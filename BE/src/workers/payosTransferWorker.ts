import { Job } from 'bull';
import { randomUUID } from 'crypto';
import { getLogger } from '../config/logger';
import { runWithWorkerContext } from '../config/requestContext';
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
  updateDisbursementByRequestIdWithCondition
} from '../models/disbursementModel';
import { createPayosTransfer, getPayosTransferStatusByReferenceId } from '../services/payosService';
import { processDisbursementTransferWebhook } from '../services/disbursementService';
import { openManualReviewQueueForDisbursement } from '../services/manualReviewService';
import { getPayosBankCode } from '../config/payosBankCodes';
import { sanitizeProviderError } from '../utils/sanitizeProviderError';

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
  finalTransferId?: string,
  expectedIdempotencyKey?: string
): Promise<void> {
  const safeErrorMessage = sanitizeProviderError(errorMessage) || 'PayOS transfer failed.';
  const updateCondition: Record<string, unknown> = {
    status: { $nin: ['COMPLETED', 'REJECTED', 'CANCELLED'] },
    payosTransferStatus: { $ne: 'SUCCESS' }
  };
  if (expectedIdempotencyKey) {
    updateCondition.transferIdempotencyKey = expectedIdempotencyKey;
  }

  const updatedDisbursement = await updateDisbursementByRequestIdWithCondition(requestId, updateCondition, {
    status: 'APPROVED',
    payosTransferStatus: 'MANUAL_REVIEW',
    payosTransferLastError: safeErrorMessage,
    payosTransferId: finalTransferId ?? undefined
  });

  // Dọn dẹp các job đang chờ để tránh duplicate transfer sau khi chuyển manual review
  if (!updatedDisbursement) {
    logger.warn('Bỏ qua chuyển MANUAL_REVIEW vì disbursement đã đổi trạng thái hoặc idempotency key không còn khớp.', {
      requestId,
      finalTransferId
    });
    return;
  }

  await removePendingJobsByRequestId(requestId);

  await openManualReviewQueueForDisbursement({
    disbursement: updatedDisbursement,
    reason: safeErrorMessage,
    retryCount: updatedDisbursement.payosTransferAttemptCount,
    source: 'payos_worker'
  });

  logger.warn('Disbursement chuyển sang MANUAL_REVIEW sau khi retry thất bại.', {
    requestId,
    errorMessage: safeErrorMessage,
    finalTransferId
  });
}

/**
 * Enqueue retry kế tiếp bằng job mới có delay rõ ràng thay vì mutate active Bull job.
 * @param requestId ID yêu cầu giải ngân.
 * @param attemptNumber Attempt hiện tại vừa thất bại.
 * @param idempotencyKey Khóa idempotency hiện tại của transfer.
 */
async function scheduleNextTransferRetry(
  requestId: string,
  attemptNumber: number,
  idempotencyKey: string,
  rotateIdempotencyKey = false
): Promise<void> {
  const currentDisbursement = await findDisbursementByRequestId(requestId);
  if (
    !currentDisbursement
    || currentDisbursement.payosTransferStatus !== 'PROCESSING'
    || currentDisbursement.transferIdempotencyKey !== idempotencyKey
  ) {
    logger.warn('Không schedule retry vì disbursement đã rời chain hiện tại.', {
      requestId,
      attemptNumber,
      expectedIdempotencyKey: idempotencyKey,
      currentPayosTransferStatus: currentDisbursement?.payosTransferStatus,
      currentIdempotencyKey: currentDisbursement?.transferIdempotencyKey
    });
    return;
  }

  const nextAttempt = attemptNumber + 1;
  const delayIndex = Math.max(0, attemptNumber - 1);
  const delayMs = PAYOS_TRANSFER_RETRY_DELAYS_MS[delayIndex] ?? PAYOS_TRANSFER_RETRY_DELAYS_MS[0];
  const nextIdempotencyKey = rotateIdempotencyKey
    ? `auto-retry-${requestId}-${randomUUID()}`
    : idempotencyKey;

  if (rotateIdempotencyKey) {
    const rotatedDisbursement = await updateDisbursementByRequestIdWithCondition(
      requestId,
      {
        status: { $in: ['APPROVED', 'EXECUTING'] },
        payosTransferStatus: 'PROCESSING',
        transferIdempotencyKey: idempotencyKey
      },
      {
        transferIdempotencyKey: nextIdempotencyKey,
        payosTransferStatus: 'PROCESSING'
      }
    );
    if (!rotatedDisbursement) {
      logger.warn('Không rotate key hoặc schedule retry vì disbursement đã rời chain hiện tại.', {
        requestId,
        attemptNumber,
        expectedIdempotencyKey: idempotencyKey
      });
      return;
    }
  }

  const { enqueued } = await enqueueDisbursementTransfer(requestId, nextAttempt, nextIdempotencyKey, {
    delay: delayMs
  });

  if (!enqueued) {
    logger.warn('Không thể schedule retry cho disbursement transfer job.', {
      requestId,
      nextAttempt,
      delayMs,
      idempotencyKey: nextIdempotencyKey
    });
    return;
  }

  logger.info('Đã schedule retry cho disbursement transfer job.', {
    requestId,
    attemptNumber: nextAttempt,
    delayMs,
    idempotencyKey: nextIdempotencyKey
  });
}

/** Kiểm tra job còn thuộc đúng transfer chain đang PROCESSING hay đã bị rotate state/key. */
function isActiveTransferChain(
  disbursement: Awaited<ReturnType<typeof findDisbursementByRequestId>>,
  idempotencyKey: string
): boolean {
  return Boolean(
    disbursement
    && disbursement.transferIdempotencyKey === idempotencyKey
    && disbursement.payosTransferStatus === 'PROCESSING'
    && (disbursement.status === 'APPROVED' || disbursement.status === 'EXECUTING')
  );
}

/**
 * Hàm thực hiện polling để chờ PayOS xác nhận transfer.
 * Mục đích: chủ động kiểm tra trạng thái thay vì chờ webhook.
 */
export async function pollTransferUntilFinal(
  requestId: string,
  idempotencyKey: string
): Promise<'SUCCESS' | 'PROCESSING' | 'FAILED' | 'STALE'> {
  for (let attempt = 0; attempt < TRANSFER_POLL_MAX_ATTEMPTS; attempt += 1) {
    // Kiểm tra disbursement đã được xử lý chưa (có thể webhook đến trước)
    const currentDisbursement = await findDisbursementByRequestId(requestId);
    if (!currentDisbursement || currentDisbursement.transferIdempotencyKey !== idempotencyKey) {
      return 'STALE';
    }
    if (
      currentDisbursement?.payosTransferStatus === 'SUCCESS'
      || currentDisbursement?.status === 'COMPLETED'
    ) {
      return 'SUCCESS';
    }

    if (
      currentDisbursement?.payosTransferStatus === 'MANUAL_REVIEW'
      || !isActiveTransferChain(currentDisbursement, idempotencyKey)
    ) {
      return 'STALE';
    }

    await new Promise(resolve => setTimeout(resolve, TRANSFER_POLL_INTERVAL_MS));

    try {
      const status = await getPayosTransferStatusByReferenceId(requestId);
      if (status.found) {
        if (status.transferStatus === 'SUCCESS' || status.transferStatus === 'FAILED') {
          // Đọc lại sau provider call để không dùng kết quả terminal của job cũ khi key/state vừa đổi.
          const latestDisbursement = await findDisbursementByRequestId(requestId);
          if (!isActiveTransferChain(latestDisbursement, idempotencyKey)) {
            return 'STALE';
          }
        }

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
async function processTransferJobInternal(job: Job<DisbursementTransferJobData>): Promise<void> {
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

  if (disbursement.payosTransferStatus === 'MANUAL_REVIEW') {
    logger.warn('Disbursement đang chờ manual review, bỏ qua job.', {
      requestId,
      attemptNumber
    });
    return;
  }

  if (
    disbursement.transferIdempotencyKey
    && disbursement.transferIdempotencyKey !== idempotencyKey
  ) {
    logger.warn('Bỏ qua job stale vì idempotency key đã được rotate.', {
      requestId,
      attemptNumber
    });
    return;
  }

  // Kiểm tra timeout deadline
  const isTimedOut = await isDisbursementTimedOut(requestId);
  if (isTimedOut) {
    await moveToManualReview(requestId, 'Disbursement đã quá deadline timeout.', undefined, idempotencyKey);
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
  const preparedDisbursement = await updateDisbursementByRequestIdWithCondition(
    requestId,
    {
      status: { $in: ['APPROVED', 'EXECUTING'] },
      payosTransferStatus: { $nin: ['SUCCESS', 'MANUAL_REVIEW'] },
      // Atomic claim: cùng một attempt chỉ được một Bull job đi tới provider.
      payosTransferAttemptCount: { $lt: attemptNumber },
      $or: [
        { transferIdempotencyKey: null },
        { transferIdempotencyKey: idempotencyKey }
      ]
    },
    {
      payosTransferAttemptCount: attemptNumber,
      payosTransferStatus: 'PROCESSING',
      // Lưu key trước API call để lỗi mạng vẫn có thể retry đúng chain mà không tạo key khác.
      transferIdempotencyKey: idempotencyKey
    }
  );
  if (!preparedDisbursement) {
    logger.warn('Bỏ qua job vì disbursement đã đổi state trước khi gọi PayOS.', {
      requestId,
      attemptNumber
    });
    return;
  }

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
    const updatedDisbursement = await updateDisbursementByRequestIdWithCondition(
      requestId,
      {
        status: { $in: ['APPROVED', 'EXECUTING'] },
        payosTransferStatus: 'PROCESSING',
        transferIdempotencyKey: idempotencyKey
      },
      updatePayload
    );
    if (!updatedDisbursement) {
      logger.warn('Bỏ qua kết quả PayOS vì job đã stale sau khi provider trả kết quả.', {
        requestId,
        attemptNumber
      });
      return;
    }

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
        source: 'internal_poll',
        expectedTransferIdempotencyKey: idempotencyKey
      });
      return;
    }

    // Nếu PayOS trả FAILED → xử lý retry hoặc manual review
    if (transferResult.transferStatus === 'FAILED') {
      const errorMsg = sanitizeProviderError(extractErrorMessage(transferResult.rawPayload))
        || 'PayOS transfer returned FAILED status.';
      await updateTransferLogById(transferLog.transferLogId, {
        status: 'FAILED',
        errorMessage: errorMsg
      });

      if (attemptNumber >= MAX_TRANSFER_RETRY_COUNT) {
        await moveToManualReview(requestId, errorMsg, transferResult.transferId, idempotencyKey);
      } else {
        await scheduleNextTransferRetry(requestId, attemptNumber, idempotencyKey, true);
      }
      return;
    }

    // PayOS trả PROCESSING → polling
    const pollResult = await pollTransferUntilFinal(requestId, idempotencyKey);

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
        source: 'internal_poll',
        expectedTransferIdempotencyKey: idempotencyKey
      });
      return;
    }

    if (pollResult === 'STALE') {
      logger.warn('Bỏ qua kết quả polling vì transfer job đã stale sau khi provider trả kết quả.', {
        requestId,
        attemptNumber
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
        transferResult.transferId,
        idempotencyKey
      );
    } else {
      const pollingErrorMessage = pollResult === 'FAILED'
        ? 'PayOS polling returned FAILED status.'
        : 'Không xác định được trạng thái cuối sau polling, sẽ kiểm tra lại cùng idempotency key.';
      await updateTransferLogById(transferLog.transferLogId, {
        status: pollResult === 'FAILED' ? 'FAILED' : 'PROCESSING',
        errorMessage: pollingErrorMessage,
        completedAt: new Date(finalEndTime),
        durationMs: finalDurationMs
      });
      await scheduleNextTransferRetry(
        requestId,
        attemptNumber,
        idempotencyKey,
        pollResult === 'FAILED'
      );
    }
  } catch (error) {
    const endTime = Date.now();
    const errorMessage = sanitizeProviderError(extractErrorMessage(error)) || 'PayOS transfer failed.';

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
      await moveToManualReview(requestId, errorMessage, undefined, idempotencyKey);
    } else {
      await scheduleNextTransferRetry(requestId, attemptNumber, idempotencyKey);
    }
  }
}

/** Chạy processor PayOS transfer trong correlation context riêng của queue job. */
export async function processTransferJob(job: Job<DisbursementTransferJobData>): Promise<void> {
  return runWithWorkerContext('payos-transfer', () => processTransferJobInternal(job), job.id);
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
    return runWithWorkerContext('payos-transfer', async () => {
      try {
        await processTransferJobInternal(job);
      } catch (error) {
        const { requestId, attemptNumber } = job.data;
        const errorMessage = sanitizeProviderError(extractErrorMessage(error)) || 'PayOS transfer failed.';

        logger.error('PayOS transfer job thất bại trong process handler.', {
          requestId,
          attemptNumber,
          jobId: job.id,
          errorMessage
        });

        if (attemptNumber < MAX_TRANSFER_RETRY_COUNT) {
          await scheduleNextTransferRetry(requestId, attemptNumber, job.data.idempotencyKey);
        } else {
          await moveToManualReview(requestId, errorMessage, undefined, job.data.idempotencyKey);
        }

        throw error;
      }
    }, job.id);
  });

  // Xử lý job complete
  queue.on('completed', (job: Job<DisbursementTransferJobData>) => {
    runWithWorkerContext('payos-transfer', () => {
      logger.info('Disbursement transfer job hoàn thành.', {
        requestId: job.data.requestId,
        attemptNumber: job.data.attemptNumber,
        jobId: job.id
      });
    }, job.id);
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
