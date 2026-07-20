import { Job } from 'bull';
import { randomUUID } from 'crypto';
import { getLogger } from '../config/logger';
import {
  getDisbursementTransferQueue,
  enqueueDisbursementTransfer,
  PAYOS_TRANSFER_RETRY_DELAYS_MS,
  removePendingJobsByRequestId,
  DisbursementTransferJobData
} from '../queues/disbursementTransferQueue';
import {
  createTransferLog,
  updateTransferLogById,
  DisbursementTransferLogRecord
} from '../models/disbursementTransferModel';
import {
  findDisbursementByRequestId,
  updateDisbursementByRequestId
} from '../models/disbursementModel';
import { createPayosTransfer, getPayosTransferStatusByReferenceId } from '../services/payosService';
import { createUserNotification } from '../services/notificationService';
import { processDisbursementTransferWebhook } from '../services/disbursementService';
import { getPayosBankCode } from '../config/payosBankCodes';

/**
 * Giới hạn số lần retry tối đa.
 * Sau 3 lần fail → chuyển sang MANUAL_REVIEW.
 */
const MAX_TRANSFER_RETRY_COUNT = 3;

/**
 * Thời gian polling interval sau khi tạo transfer (miliseconds).
 */
const TRANSFER_POLL_INTERVAL_MS = Number(process.env.DISBURSEMENT_TRANSFER_POLL_INTERVAL_MS || 15000);

/**
 * Số lần polling tối đa để chờ transfer hoàn tất.
 */
const TRANSFER_POLL_MAX_ATTEMPTS = Number(process.env.DISBURSEMENT_TRANSFER_POLL_MAX_ATTEMPTS || 60);

const logger = getLogger();

/**
 * Hàm extract message từ error object.
 */
export function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const msg = (error as Record<string, unknown>).message ?? (error as Error | null)?.message;
    if (typeof msg === 'string') return msg;
  }
  return String(error);
}

/**
 * Hàm sanitize response data trước khi lưu vào log.
 * Loại bỏ các trường nhạy cảm như số tài khoản, tên chủ tài khoản.
 */
export function sanitizePayosResponseForLog(
  data: unknown
): Record<string, unknown> {
  if (!data || typeof data !== 'object') {
    return {};
  }

  const sanitized: Record<string, unknown> = {};
  const sensitiveKeys = [
    'accountnumber', 'account_number', 'toaccountnumber',
    'accountholdername', 'account_holder_name', 'toaccountholdername',
    'name', 'recipient'
  ];

  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    const normalizedKey = key.toLowerCase();
    if (sensitiveKeys.some(sk => normalizedKey.includes(sk))) {
      sanitized[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      sanitized[key] = sanitizePayosResponseForLog(value);
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

/**
 * Hàm mask số tài khoản cho log.
 * Hiển thị 4 số cuối, phần còn lại thay bằng *.
 */
export function maskBankAccount(accountNumber: string): string {
  if (!accountNumber || accountNumber.length <= 4) {
    return '****';
  }
  const visibleDigits = accountNumber.slice(-4);
  const maskedDigits = '*'.repeat(accountNumber.length - 4);
  return `${maskedDigits}${visibleDigits}`;
}

/**
 * Hàm mask tên chủ tài khoản cho log.
 * Chỉ hiển thị 2 ký tự đầu.
 */
export function maskAccountHolderName(name: string): string {
  if (!name || name.length <= 2) {
    return '**';
  }
  return `${name.slice(0, 2)}${'*'.repeat(Math.max(0, name.length - 2))}`;
}

/**
 * Hàm kiểm tra xem disbursement có đã quá timeout chưa.
 * Mục đích: không thực hiện transfer nếu đã quá hạn.
 */
export async function isDisbursementTimedOut(requestId: string): Promise<boolean> {
  const disbursement = await findDisbursementByRequestId(requestId);
  if (!disbursement || !disbursement.timeoutDeadline) {
    return false;
  }

  const now = new Date();
  if (now > disbursement.timeoutDeadline) {
    logger.warn('Disbursement đã quá deadline, bỏ qua transfer.', {
      requestId,
      deadline: disbursement.timeoutDeadline.toISOString()
    });
    return true;
  }

  return false;
}

/**
 * Hàm chuyển disbursement sang trạng thái MANUAL_REVIEW.
 * Mục đích: khi retry fail đạt max, admin cần xử lý tay.
 */
export async function moveToManualReview(
  requestId: string,
  errorMessage: string,
  finalTransferId?: string
): Promise<void> {
  await updateDisbursementByRequestId(requestId, {
    status: 'APPROVED',
    payosTransferStatus: 'MANUAL_REVIEW',
    payosTransferLastError: errorMessage,
    payosTransferId: finalTransferId ?? undefined
  });

  // Dọn dẹp các job đang chờ để tránh duplicate transfer sau khi chuyển manual review
  await removePendingJobsByRequestId(requestId);

  await createUserNotification({
    userId: 'admin',
    notificationType: 'SYSTEM' as const,
    title: 'Yêu cầu giải ngân cần xử lý tay',
    content: `Yêu cầu giải ngân ${requestId} đã fail sau ${MAX_TRANSFER_RETRY_COUNT} lần retry PayOS và cần được xử lý thủ công.`,
    deduplicationKey: `DISBURSEMENT_MANUAL_REVIEW:${requestId}`,
    metadata: {
      requestId,
      errorMessage,
      transferId: finalTransferId,
      reason: 'PayOS transfer thất bại sau khi retry tối đa'
    }
  });

  logger.warn('Disbursement chuyển sang MANUAL_REVIEW sau khi retry thất bại.', {
    requestId,
    errorMessage,
    finalTransferId
  });
}

/**
 * Hàm thực hiện polling để chờ PayOS xác nhận transfer.
 * Mục đích: chủ động kiểm tra trạng thái thay vì chờ webhook.
 */
export async function pollTransferUntilFinal(
  requestId: string,
  payosTransferId: string
): Promise<'SUCCESS' | 'PROCESSING' | 'FAILED'> {
  for (let attempt = 0; attempt < TRANSFER_POLL_MAX_ATTEMPTS; attempt += 1) {
    // Kiểm tra disbursement đã được xử lý chưa (có thể webhook đến trước)
    const currentDisbursement = await findDisbursementByRequestId(requestId);
    if (
      currentDisbursement?.payosTransferStatus === 'SUCCESS'
      || currentDisbursement?.status === 'COMPLETED'
    ) {
      return 'SUCCESS';
    }

    if (
      currentDisbursement?.payosTransferStatus === 'MANUAL_REVIEW'
    ) {
      return 'FAILED';
    }

    await new Promise(resolve => setTimeout(resolve, TRANSFER_POLL_INTERVAL_MS));

    try {
      const status = await getPayosTransferStatusByReferenceId(payosTransferId);
      if (status.found) {
        if (status.transferStatus === 'SUCCESS') {
          return 'SUCCESS';
        }
        if (status.transferStatus === 'FAILED') {
          return 'FAILED';
        }
      }
    } catch {
      // Tiếp tục polling nếu query thất bại
    }
  }

  return 'PROCESSING';
}

/**
 * Hàm xử lý một job transfer.
 * Mục đích: gọi PayOS API, ghi log, retry nếu fail, chuyển manual review nếu hết retry.
 */
export async function processTransferJob(job: Job<DisbursementTransferJobData>): Promise<void> {
  const { requestId, attemptNumber, idempotencyKey } = job.data;
  const startTime = Date.now();

  logger.info('Bắt đầu xử lý disbursement transfer job.', {
    requestId,
    attemptNumber,
    jobId: job.id
  });

  // Kiểm tra disbursement tồn tại và ở trạng thái hợp lệ
  const disbursement = await findDisbursementByRequestId(requestId);
  if (!disbursement) {
    logger.warn('Không tìm thấy disbursement, bỏ qua job.', { requestId });
    return;
  }

  if (disbursement.status !== 'APPROVED' && disbursement.status !== 'EXECUTING') {
    logger.warn('Disbursement không ở trạng thái APPROVED/EXECUTING, bỏ qua job.', {
      requestId,
      status: disbursement.status
    });
    return;
  }

  const currentStatus = disbursement.status as string;
  if (currentStatus === 'COMPLETED' || disbursement.payosTransferStatus === 'SUCCESS') {
    if (currentStatus === 'COMPLETED') {
      logger.info('Disbursement đã COMPLETED, bỏ qua job.', { requestId });
    } else {
      logger.info('Disbursement đã transfer thành công, bỏ qua job.', { requestId });
    }
    return;
  }

  // Kiểm tra timeout deadline
  const isTimedOut = await isDisbursementTimedOut(requestId);
  if (isTimedOut) {
    await moveToManualReview(requestId, 'Disbursement đã quá deadline timeout.');
    return;
  }

  // Lấy PayOS bank code từ config - đã được externalize vào payosBankCodes.ts
  const bankCode = getPayosBankCode(disbursement.beneficiaryBankAccount.bankName)
    || disbursement.beneficiaryBankAccount.bankName.slice(0, 32);

  // Tạo bản ghi log cho attempt này
  const transferLogRecord: DisbursementTransferLogRecord = {
    transferLogId: `TRF-${Date.now()}-${randomUUID().replace(/-/g, '').slice(0, 5).toUpperCase()}`,
    disbursementRequestId: requestId,
    attemptNumber,
    payosTransferId: null,
    providerTransactionId: null,
    amount: disbursement.amount,
    bankCode,
    bankAccountNumber: maskBankAccount(disbursement.beneficiaryBankAccount.bankAccountNumber),
    accountHolderName: maskAccountHolderName(disbursement.beneficiaryBankAccount.accountHolderName),
    status: 'PROCESSING',
    errorMessage: null,
    responseData: null,
    startedAt: new Date(startTime),
    completedAt: null,
    durationMs: null
  };

  let transferLog: DisbursementTransferLogRecord;
  try {
    transferLog = await createTransferLog(transferLogRecord);
  } catch {
    // Nếu không tạo được log, vẫn tiếp tục transfer
    transferLog = transferLogRecord;
  }

  // Cập nhật disbursement với attempt count
  await updateDisbursementByRequestId(requestId, {
    payosTransferAttemptCount: attemptNumber,
    payosTransferStatus: 'PROCESSING'
  });

  try {
    // Gọi PayOS API
    const transferResult = await createPayosTransfer({
      requestId,
      amountVnd: disbursement.amount,
      bankCode,
      bankAccountNumber: disbursement.beneficiaryBankAccount.bankAccountNumber,
      accountHolderName: disbursement.beneficiaryBankAccount.accountHolderName,
      description: `DISBURSEMENT-${requestId}`,
      idempotencyKey
    });

    const endTime = Date.now();
    const durationMs = endTime - startTime;

    // Cập nhật disbursement với transfer ID
    // Nếu transferIdempotencyKey chưa được set, cập nhật luôn để đảm bảo idempotency
    const updatePayload: Record<string, unknown> = {
      payosTransferId: transferResult.transferId,
      payosTransferStatus: 'PROCESSING',
      transferIdempotencyKey: idempotencyKey
    };
    await updateDisbursementByRequestId(requestId, updatePayload);

    // Cập nhật log
    await updateTransferLogById(transferLog.transferLogId, {
      payosTransferId: transferResult.transferId,
      providerTransactionId: transferResult.providerTransactionId,
      status: transferResult.transferStatus === 'SUCCESS' ? 'SUCCESS' : 'PROCESSING',
      responseData: sanitizePayosResponseForLog(transferResult.rawPayload),
      completedAt: new Date(endTime),
      durationMs
    });

    logger.info('PayOS transfer đã khởi tạo.', {
      requestId,
      payosTransferId: transferResult.transferId,
      transferStatus: transferResult.transferStatus,
      attemptNumber,
      durationMs
    });

    // Nếu PayOS trả SUCCESS ngay → cập nhật thành công
    if (transferResult.transferStatus === 'SUCCESS') {
      await updateTransferLogById(transferLog.transferLogId, {
        status: 'SUCCESS'
      });
      // Trigger finalize thông qua webhook handler
      await processDisbursementTransferWebhook({
        requestId,
        transferId: transferResult.transferId,
        status: 'SUCCESS'
      }, {
        skipChecksumVerify: true,
        source: 'internal_poll'
      });
      return;
    }

    // Nếu PayOS trả FAILED → xử lý retry hoặc manual review
    if (transferResult.transferStatus === 'FAILED') {
      const errorMsg = extractErrorMessage(transferResult.rawPayload) || 'PayOS transfer returned FAILED status.';
      await updateTransferLogById(transferLog.transferLogId, {
        status: 'FAILED',
        errorMessage: errorMsg
      });

      if (attemptNumber >= MAX_TRANSFER_RETRY_COUNT) {
        await moveToManualReview(requestId, errorMsg, transferResult.transferId);
      }
      return;
    }

    // PayOS trả PROCESSING → polling
    const pollResult = await pollTransferUntilFinal(requestId, transferResult.transferId);

    const finalEndTime = Date.now();
    const finalDurationMs = finalEndTime - startTime;

    if (pollResult === 'SUCCESS') {
      await updateTransferLogById(transferLog.transferLogId, {
        status: 'SUCCESS',
        completedAt: new Date(finalEndTime),
        durationMs: finalDurationMs
      });
      await processDisbursementTransferWebhook({
        requestId,
        transferId: transferResult.transferId,
        status: 'SUCCESS'
      }, {
        skipChecksumVerify: true,
        source: 'internal_poll'
      });
      return;
    }

    // Polling kết thúc nhưng không xác định được trạng thái cuối
    if (attemptNumber >= MAX_TRANSFER_RETRY_COUNT) {
      await updateTransferLogById(transferLog.transferLogId, {
        status: 'MANUAL_REVIEW',
        errorMessage: 'Không xác định được trạng thái cuối sau polling.',
        completedAt: new Date(finalEndTime),
        durationMs: finalDurationMs
      });
      await moveToManualReview(
        requestId,
        'Không xác định được trạng thái cuối sau khi polling. Vui lòng kiểm tra trên PayOS dashboard.',
        transferResult.transferId
      );
    }
  } catch (error) {
    const endTime = Date.now();
    const errorMessage = extractErrorMessage(error);

    logger.error('PayOS transfer job thất bại.', {
      requestId,
      attemptNumber,
      errorMessage,
      durationMs: endTime - startTime
    });

    // Cập nhật log với lỗi
    await updateTransferLogById(transferLog.transferLogId, {
      status: 'FAILED',
      errorMessage,
      completedAt: new Date(endTime),
      durationMs: endTime - startTime
    });

    // Nếu đã hết retry → chuyển manual review
    if (attemptNumber >= MAX_TRANSFER_RETRY_COUNT) {
      await moveToManualReview(requestId, errorMessage);
    }
  }
}

/**
 * Hàm khởi động PayOS Transfer Worker.
 * Mục đích: consume job từ Bull queue và xử lý PayOS transfer.
 */
export function startPayosTransferWorker(): void {
  const queue = getDisbursementTransferQueue();
  if (!queue) {
    logger.warn('Disbursement transfer queue không khả dụng. Worker không khởi động được.');
    return;
  }

  // Retry với exponential backoff: 1m → 5m → 30m
  queue.process(async (job: Job<DisbursementTransferJobData>) => {
    try {
      await processTransferJob(job);
    } catch (error) {
      const { requestId, attemptNumber } = job.data;
      const errorMessage = extractErrorMessage(error);

      logger.error('PayOS transfer job thất bại trong process handler.', {
        requestId,
        attemptNumber,
        jobId: job.id,
        errorMessage
      });

      if (attemptNumber < MAX_TRANSFER_RETRY_COUNT) {
        const nextAttempt = attemptNumber + 1;
        const delayIndex = attemptNumber - 1;
        const delayMs = PAYOS_TRANSFER_RETRY_DELAYS_MS[delayIndex] ?? PAYOS_TRANSFER_RETRY_DELAYS_MS[0];

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (job as any).moveToDelayed(delayMs);

        job.data = {
          requestId,
          attemptNumber: nextAttempt,
          idempotencyKey: job.data.idempotencyKey
        };

        logger.info('Đã schedule retry cho disbursement transfer job.', {
          requestId,
          attemptNumber: nextAttempt,
          delayMs
        });
      } else {
        await moveToManualReview(requestId, errorMessage);
      }

      throw error;
    }
  });

  // Xử lý job complete
  queue.on('completed', (job: Job<DisbursementTransferJobData>) => {
    logger.info('Disbursement transfer job hoàn thành.', {
      requestId: job.data.requestId,
      attemptNumber: job.data.attemptNumber,
      jobId: job.id
    });
  });

  logger.info('PayOS Transfer Worker đã khởi động.');
}

/**
 * Hàm trigger transfer cho một disbursement đã APPROVED.
 * Mục đích: được gọi khi disbursement đạt trạng thái APPROVED.
 */
export async function triggerPayosTransferForApprovedDisbursement(
  requestId: string
): Promise<{ enqueued: boolean; jobId?: string | number }> {
  const disbursement = await findDisbursementByRequestId(requestId);
  if (!disbursement) {
    return { enqueued: false };
  }

  const disbursementStatus = disbursement.status as string;
  if (disbursementStatus !== 'APPROVED') {
    logger.warn('Disbursement không ở trạng thái APPROVED, không trigger transfer.', {
      requestId,
      status: disbursementStatus
    });
    return { enqueued: false };
  }

  if (disbursement.payosTransferStatus === 'SUCCESS') {
    logger.info('Disbursement đã transfer thành công trước đó.', { requestId });
    return { enqueued: false };
  }

  const currentAttempt = (disbursement.payosTransferAttemptCount ?? 0) + 1;
  const idempotencyKey = disbursement.transferIdempotencyKey ?? `disbursement-${requestId}`;

  const result = await enqueueDisbursementTransfer(
    requestId,
    currentAttempt,
    idempotencyKey
  );

  return {
    enqueued: result.enqueued,
    jobId: result.jobId
  };
}
