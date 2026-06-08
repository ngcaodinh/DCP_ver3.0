import crypto from 'crypto';
import {
  createDepositTransaction,
  DepositTransaction,
  findDepositTransactionByOrderCode,
  updateDepositTransaction
} from '../models/depositModel';
import { createPayosPaymentLink, verifyPayosWebhookChecksum } from './payosService';
import { mintTokenForDeposit } from './blockchainMintService';
import { getLogger } from '../config/logger';

type CreateDepositInput = {
  userId: string;
  walletAddress: string;
  amountVnd: number;
  correlationId: string;
};

type CreateDepositResult = {
  orderCode: string;
  paymentUrl: string;
  status: DepositTransaction['status'];
};

type PayosWebhookPayload = {
  orderCode?: string | number;
  code?: string | number;
  desc?: string;
  success?: boolean;
  status?: string;
  data?: Record<string, unknown>;
  signature?: string;
  checksum?: string;
  checksumSource?: 'header' | 'body' | 'missing';
};

type WebhookChecksumCandidate = {
  checksumData: Record<string, unknown>;
  checksumValue: string;
  verifyMode: 'payload_data' | 'payload_top_level' | 'payload_data_string';
};


type WebhookChecksumVerifyResult = {
  isValid: boolean;
  verifyMode: 'payload_data' | 'payload_top_level' | 'payload_data_string' | 'none';
};

const logger = getLogger();
const minimumDepositAmountVnd = 10000;
const paymentTimeoutMilliseconds = 15 * 60 * 1000;

/**
 * Hàm sinh orderCode duy nhất cho PayOS.
 * Mục đích: tạo mã đơn hàng dạng số để tương thích ràng buộc API PayOS.
 */
function generateOrderCode(): string {
  const orderNumber = Date.now() + Math.floor(Math.random() * 999);
  return String(orderNumber);
}

/**
 * Hàm tạo correlation id cho giao dịch nạp tiền.
 * Mục đích: phục vụ truy vết log xuyên suốt toàn bộ pipeline deposit.
 */
function generateCorrelationId(): string {
  return crypto.randomUUID();
}

/**
 * Hàm validate số tiền nạp từ người dùng.
 * Mục đích: chặn yêu cầu không hợp lệ theo quy tắc nghiệp vụ FR2.
 */
function validateDepositAmount(amountVnd: number): void {
  if (!Number.isFinite(amountVnd) || !Number.isInteger(amountVnd)) {
    throw new Error('Số tiền nạp phải là số nguyên hợp lệ.');
  }

  if (amountVnd < minimumDepositAmountVnd) {
    throw new Error('Số tiền nạp tối thiểu là 10,000 VNĐ.');
  }
}

/**
 * Hàm tạo giao dịch nạp tiền và payment link PayOS.
 * Mục đích: khởi tạo giao dịch trạng thái chờ thanh toán trước khi redirect người dùng.
 */
export async function createDepositRequest(input: CreateDepositInput): Promise<CreateDepositResult> {
  validateDepositAmount(input.amountVnd);

  const orderCode = generateOrderCode();
  const correlationId = input.correlationId || generateCorrelationId();
  const configuredReturnUrl = process.env.PAYOS_RETURN_URL || 'http://localhost:3000/deposit?paymentStatus=success';
  const configuredCancelUrl = process.env.PAYOS_CANCEL_URL || 'http://localhost:3000/deposit?paymentStatus=cancel';

  // Ghi chú logic phức tạp: luôn đính kèm orderCode vào URL để frontend polling đúng giao dịch
  // ngay cả khi cổng thanh toán không tự thêm orderCode khi redirect về hệ thống.
  const returnUrl = `${configuredReturnUrl}${configuredReturnUrl.includes('?') ? '&' : '?'}orderCode=${orderCode}`;
  const cancelUrl = `${configuredCancelUrl}${configuredCancelUrl.includes('?') ? '&' : '?'}orderCode=${orderCode}`;

  logger.info('Bắt đầu tạo payment link deposit.', {
    correlationId,
    walletAddress: input.walletAddress
  });

  const paymentLinkResult = await createPayosPaymentLink({
    orderCode,
    amountVnd: input.amountVnd,
    description: `NAPTIEN${orderCode.slice(-6)}`,
    returnUrl,
    cancelUrl
  });

  const now = new Date();
  await createDepositTransaction({
    id: crypto.randomUUID(),
    orderCode: paymentLinkResult.orderCode,
    userId: input.userId,
    walletAddress: input.walletAddress,
    amountVnd: input.amountVnd,
    tokenAmount: input.amountVnd,
    paymentUrl: paymentLinkResult.paymentUrl,
    status: 'PENDING_PAYMENT',
    onChainTransactionHash: null,
    payosTransactionId: null,
    failureReason: null,
    correlationId,
    createdAt: now,
    updatedAt: now,
    paymentConfirmedAt: null,
    mintCompletedAt: null,
    webhookProcessedAt: null
  });

  logger.info('Tạo payment link deposit thành công.', {
    correlationId,
    orderCode: paymentLinkResult.orderCode,
    walletAddress: input.walletAddress
  });

  return {
    orderCode: paymentLinkResult.orderCode,
    paymentUrl: paymentLinkResult.paymentUrl,
    status: 'PENDING_PAYMENT'
  };
}



/**
 * Hàm chuẩn hóa orderCode nhận từ webhook.
 * Mục đích: đảm bảo dữ liệu idempotency luôn nhất quán trước khi tra cứu DB.
 */
function normalizeOrderCode(value: unknown): string {
  if (typeof value === 'number') {
    return String(value);
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }

  return '';
}

/**
 * Hàm chuẩn hóa webhook data từ payload.
 * Mục đích: xử lý trường hợp data là chuỗi JSON hoặc không hợp lệ.
 */
function normalizeWebhookData(data: unknown): Record<string, unknown> {
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    return data as Record<string, unknown>;
  }

  if (typeof data === 'string' && data.trim().length > 0) {
    try {
      const parsedData = JSON.parse(data) as unknown;
      if (parsedData && typeof parsedData === 'object' && !Array.isArray(parsedData)) {
        return parsedData as Record<string, unknown>;
      }
    } catch {
      return {};
    }
  }

  return {};
}

/**
 * Hàm xác định kết quả thanh toán từ payload webhook PayOS.
 * Mục đích: tương thích nhiều định dạng webhook khác nhau và giảm rủi ro parse sai trạng thái.
 */
function detectPaymentSuccess(payload: PayosWebhookPayload, webhookData: Record<string, unknown>): boolean {
  const payloadCode = String(payload.code ?? '').trim();
  const dataCode = String(webhookData.code ?? '').trim();
  const normalizedStatus = String(payload.status ?? webhookData.status ?? '').trim().toUpperCase();

  if (typeof payload.success === 'boolean') {
    return payload.success;
  }

  if (payloadCode === '00' || dataCode === '00') {
    return true;
  }

  if (normalizedStatus === 'PAID' || normalizedStatus === 'SUCCESS' || normalizedStatus === 'COMPLETED') {
    return true;
  }

  return false;
}

/**
 * Hàm trích xuất mã giao dịch PayOS từ webhook.
 * Mục đích: lưu dấu vết đối soát để audit và truy vết giao dịch ngân hàng.
 */
function extractPayosTransactionId(webhookData: Record<string, unknown>): string | null {
  const transactionId = webhookData.transactionNo || webhookData.reference || webhookData.paymentLinkId;
  return transactionId ? String(transactionId) : null;
}

/**
 * Hàm kiểm tra giao dịch chờ thanh toán đã hết hạn hay chưa.
 * Mục đích: tự động hủy giao dịch quá 15 phút theo yêu cầu FR2.
 */
function isPendingPaymentExpired(transaction: DepositTransaction, currentTime: Date): boolean {
  if (transaction.status !== 'PENDING_PAYMENT') {
    return false;
  }

  const createdTimestamp = transaction.createdAt.getTime();
  const expiredTimestamp = createdTimestamp + paymentTimeoutMilliseconds;
  return currentTime.getTime() > expiredTimestamp;
}

/**
 * Hàm mint token với cơ chế retry giới hạn.
 * Mục đích: đáp ứng alternative flow UC2.1 (8a) khi giao dịch mint bị revert tạm thời.
 */
async function mintTokenWithRetry(
  walletAddress: string,
  tokenAmount: number,
  orderCode: string,
  correlationId: string
): Promise<{ transactionHash: string }> {
  const maximumMintRetryCount = 3;

  for (let currentAttempt = 1; currentAttempt <= maximumMintRetryCount; currentAttempt += 1) {
    try {
      const mintResult = await mintTokenForDeposit(walletAddress, tokenAmount, orderCode);
      return mintResult;
    } catch (error) {
      logger.error(`Mint token thất bại ở lần thử ${currentAttempt}/${maximumMintRetryCount}.`, {
        correlationId,
        errorMessage: (error as Error).message
      });

      if (currentAttempt === maximumMintRetryCount) {
        throw error;
      }
    }
  }

  throw new Error('Mint token thất bại sau khi đã retry tối đa.');
}


/**
 * Hàm lấy danh sách dữ liệu có thể dùng để verify checksum webhook.
 * Mục đích: tương thích nhiều biến thể payload PayOS (top-level và payload.data).
 */
function buildWebhookChecksumCandidates(payload: PayosWebhookPayload): WebhookChecksumCandidate[] {
  const webhookData = normalizeWebhookData(payload.data);
  const topLevelData = payload as unknown as Record<string, unknown>;
  const checksumValue = String(payload.signature || payload.checksum || '').trim();

  if (!checksumValue) {
    return [];
  }

  const checksumCandidates: WebhookChecksumCandidate[] = [];

  if (Object.keys(webhookData).length > 0) {
    checksumCandidates.push({
      checksumData: webhookData,
      checksumValue,
      verifyMode: 'payload_data'
    });
  }

  checksumCandidates.push({
    checksumData: topLevelData,
    checksumValue,
    verifyMode: 'payload_top_level'
  });

  return checksumCandidates;
}

/**
 * Hàm xác thực checksum webhook với cơ chế fallback đa payload.
 * Mục đích: tránh false-negative khi PayOS ký trên cấu trúc dữ liệu khác nhau.
 */
function verifyWebhookChecksumCandidates(checksumCandidates: WebhookChecksumCandidate[]): WebhookChecksumVerifyResult {
  for (const checksumCandidate of checksumCandidates) {
    const isValid = verifyPayosWebhookChecksum(checksumCandidate.checksumData, checksumCandidate.checksumValue);
    if (isValid) {
      return { isValid: true, verifyMode: checksumCandidate.verifyMode };
    }
  }

  return { isValid: false, verifyMode: 'none' };
}

/**
 * Hàm xử lý webhook PayOS cho nghiệp vụ deposit.
 * Mục đích: verify checksum, cập nhật trạng thái thanh toán và mint token on-chain.
 */
export async function processDepositWebhook(payload: PayosWebhookPayload): Promise<DepositTransaction> {
  const webhookData = normalizeWebhookData(payload.data);
  const checksumCandidates = buildWebhookChecksumCandidates(payload);
  const orderCode = normalizeOrderCode(webhookData.orderCode || payload.orderCode);

  if (!orderCode) {
    throw new Error('Webhook thiếu orderCode hợp lệ.');
  }

  const checksumVerifyResult = verifyWebhookChecksumCandidates(checksumCandidates);
  if (checksumCandidates.length === 0 || !checksumVerifyResult.isValid) {
    logger.warn('Webhook deposit checksum không hợp lệ.', {
      orderCode,
      checksumSource: payload.checksumSource || 'missing',
      verifyMode: checksumVerifyResult.verifyMode
    });
    throw new Error('Webhook checksum không hợp lệ.');
  }

  logger.info('Webhook deposit checksum hợp lệ.', {
    orderCode,
    checksumSource: payload.checksumSource || 'missing',
    verifyMode: checksumVerifyResult.verifyMode
  });

  const depositTransaction = await findDepositTransactionByOrderCode(orderCode);
  if (!depositTransaction) {
    throw new Error('Không tìm thấy giao dịch deposit theo orderCode.');
  }

  const isPaymentSuccess = detectPaymentSuccess(payload, webhookData);
  const now = new Date();

  if (depositTransaction.status === 'MINT_COMPLETED') {
    logger.info('Webhook deposit được bỏ qua do giao dịch đã mint hoàn tất.', {
      correlationId: depositTransaction.correlationId,
      orderCode: depositTransaction.orderCode,
      finalStatus: depositTransaction.status
    });
    return depositTransaction;
  }

  if (depositTransaction.status === 'FAILED') {
    if (isPaymentSuccess) {
      // Ghi chú logic phức tạp: webhook thành công đến sau khi giao dịch đã FAILED là case lệch trạng thái,
      // cần giữ nguyên FAILED để tránh mint sai và chuyển sang luồng đối soát/hoàn tiền thủ công.
      logger.error(`Phát hiện thanh toán đến muộn sau khi giao dịch đã FAILED (orderCode=${depositTransaction.orderCode}), yêu cầu đối soát thủ công.`, {
        correlationId: depositTransaction.correlationId,
        orderCode: depositTransaction.orderCode,
        walletAddress: depositTransaction.walletAddress,
        finalStatus: depositTransaction.status
      });
    } else {
      logger.info('Webhook deposit được bỏ qua do giao dịch đã FAILED.', {
        correlationId: depositTransaction.correlationId,
        orderCode: depositTransaction.orderCode,
        walletAddress: depositTransaction.walletAddress,
        finalStatus: depositTransaction.status
      });
    }

    return depositTransaction;
  }

  if (depositTransaction.status === 'PAYMENT_CONFIRMED') {
    // Ghi chú logic phức tạp: webhook có thể bị gửi lặp sau khi hệ thống đã xác nhận thanh toán.
    // Cần bỏ qua để đảm bảo idempotent theo orderCode và tránh nguy cơ mint lặp.
    logger.info('Webhook deposit được bỏ qua do giao dịch đã ở trạng thái PAYMENT_CONFIRMED.', {
      correlationId: depositTransaction.correlationId,
      orderCode: depositTransaction.orderCode,
      walletAddress: depositTransaction.walletAddress,
      finalStatus: depositTransaction.status
    });
    return depositTransaction;
  }

  if (isPaymentSuccess && isPendingPaymentExpired(depositTransaction, now)) {
    const latePaidFailedTransaction: DepositTransaction = {
      ...depositTransaction,
      status: 'FAILED',
      updatedAt: now,
      webhookProcessedAt: now,
      payosTransactionId: extractPayosTransactionId(webhookData),
      failureReason: 'Thanh toán thành công sau thời hạn 15 phút. Giao dịch được giữ để đối soát/hoàn tiền thủ công.'
    };

    await updateDepositTransaction(latePaidFailedTransaction);
    logger.error(`Phát hiện thanh toán đến sau thời hạn 15 phút (orderCode=${latePaidFailedTransaction.orderCode}), không thực hiện mint token.`, {
      correlationId: latePaidFailedTransaction.correlationId,
      orderCode: latePaidFailedTransaction.orderCode,
      finalStatus: latePaidFailedTransaction.status
    });

    return latePaidFailedTransaction;
  }

  if (!isPaymentSuccess) {
    const failedTransaction: DepositTransaction = {
      ...depositTransaction,
      status: 'FAILED',
      updatedAt: now,
      webhookProcessedAt: now,
      failureReason: typeof payload.desc === 'string' ? payload.desc : 'Thanh toán thất bại từ PayOS.'
    };

    await updateDepositTransaction(failedTransaction);
    logger.warn('Thanh toán deposit thất bại từ webhook.', {
      correlationId: depositTransaction.correlationId,
      orderCode: failedTransaction.orderCode,
      finalStatus: failedTransaction.status
    });
    return failedTransaction;
  }

  // Cập nhật trạng thái xác nhận thanh toán trước khi gọi mint để tách rõ lifecycle nghiệp vụ.
  const paymentConfirmedTransaction: DepositTransaction = {
    ...depositTransaction,
    status: 'PAYMENT_CONFIRMED',
    updatedAt: now,
    paymentConfirmedAt: now,
    webhookProcessedAt: now,
    payosTransactionId: extractPayosTransactionId(webhookData)
  };

  await updateDepositTransaction(paymentConfirmedTransaction);
  logger.info('Thanh toán deposit đã được xác nhận, bắt đầu mint token.', {
    correlationId: paymentConfirmedTransaction.correlationId,
    orderCode: paymentConfirmedTransaction.orderCode,
    walletAddress: paymentConfirmedTransaction.walletAddress,
    finalStatus: paymentConfirmedTransaction.status
  });

  try {
    const mintResult = await mintTokenWithRetry(
      paymentConfirmedTransaction.walletAddress,
      paymentConfirmedTransaction.tokenAmount,
      paymentConfirmedTransaction.orderCode,
      paymentConfirmedTransaction.correlationId
    );

    const mintCompletedTransaction: DepositTransaction = {
      ...paymentConfirmedTransaction,
      status: 'MINT_COMPLETED',
      onChainTransactionHash: mintResult.transactionHash,
      mintCompletedAt: new Date(),
      updatedAt: new Date(),
      failureReason: null
    };

    await updateDepositTransaction(mintCompletedTransaction);
    logger.info('Mint token deposit thành công.', {
      correlationId: mintCompletedTransaction.correlationId,
      orderCode: mintCompletedTransaction.orderCode,
      walletAddress: mintCompletedTransaction.walletAddress,
      onChainTransactionHash: mintCompletedTransaction.onChainTransactionHash || undefined,
      finalStatus: mintCompletedTransaction.status
    });

    return mintCompletedTransaction;
  } catch (error) {
    const failedAfterMintTransaction: DepositTransaction = {
      ...paymentConfirmedTransaction,
      status: 'FAILED',
      updatedAt: new Date(),
      failureReason: `Mint token thất bại: ${(error as Error).message}`
    };

    await updateDepositTransaction(failedAfterMintTransaction);
    logger.error('Mint token deposit thất bại.', {
      correlationId: paymentConfirmedTransaction.correlationId,
      orderCode: failedAfterMintTransaction.orderCode,
      walletAddress: failedAfterMintTransaction.walletAddress,
      finalStatus: failedAfterMintTransaction.status,
      errorMessage: (error as Error).message
    });

    return failedAfterMintTransaction;
  }
}

/**
 * Hàm tra cứu trạng thái giao dịch deposit theo orderCode.
 * Mục đích: cho frontend polling kết quả thanh toán và mint token.
 */
export async function getDepositTransactionStatus(orderCode: string): Promise<DepositTransaction | null> {
  if (!orderCode || orderCode.trim().length === 0) {
    return null;
  }

  const normalizedOrderCode = orderCode.trim();
  const depositTransaction = await findDepositTransactionByOrderCode(normalizedOrderCode);
  if (!depositTransaction) {
    return null;
  }

  const currentTime = new Date();
  if (!isPendingPaymentExpired(depositTransaction, currentTime)) {
    return depositTransaction;
  }

  // Ghi chú logic phức tạp: timeout được xử lý ngay tại API polling để tránh phụ thuộc cron job,
  // đảm bảo giao dịch chuyển FAILED nhất quán ngay khi người dùng quay lại kiểm tra trạng thái.
  const timeoutFailedTransaction: DepositTransaction = {
    ...depositTransaction,
    status: 'FAILED',
    updatedAt: currentTime,
    failureReason: 'Quá thời gian thanh toán 15 phút.'
  };

  await updateDepositTransaction(timeoutFailedTransaction);
  logger.warn(`Giao dịch deposit bị hủy do quá thời gian chờ thanh toán (orderCode=${timeoutFailedTransaction.orderCode}).`, {
    correlationId: timeoutFailedTransaction.correlationId
  });

  return timeoutFailedTransaction;
}
