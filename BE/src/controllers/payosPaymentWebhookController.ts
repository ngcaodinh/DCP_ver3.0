import { Request, Response } from 'express';
import { getLogger } from '../config/logger';
import { findDepositTransactionByOrderCode } from '../models/depositModel';
import { handleDepositWebhook } from './depositController';
import { handleGuestDepositWebhook } from './guestDepositController';
import { handleGuestPayosWebhook } from './guestPayosWebhookController';
import { findGuestDepositByOrderCodeRepo } from '../repositories/guestDepositRepository';
import { findGuestPayosDonationByOrderCode } from '../repositories/guestPayosDonationRepository';

const logger = getLogger();

type PaymentWebhookFlow = 'ACCOUNT_DEPOSIT' | 'GUEST_DEPOSIT' | 'GUEST_DONATION';

/**
 * Hàm chuẩn hóa object data trong payload webhook PayOS.
 * Mục đích: đọc được orderCode khi PayOS gửi data dưới dạng object hoặc chuỗi JSON.
 */
function normalizeWebhookData(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    try {
      const parsedValue = JSON.parse(value) as unknown;
      if (parsedValue && typeof parsedValue === 'object' && !Array.isArray(parsedValue)) {
        return parsedValue as Record<string, unknown>;
      }
    } catch {
      return {};
    }
  }

  return {};
}

/**
 * Hàm lấy orderCode từ payload webhook PayOS.
 * Mục đích: dùng một khóa định tuyến ổn định thay vì tin vào URL callback riêng của từng luồng.
 */
function extractWebhookOrderCode(payload: unknown): string {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return '';
  }

  const rawPayload = payload as Record<string, unknown>;
  const webhookData = normalizeWebhookData(rawPayload.data);
  const candidate = webhookData.orderCode ?? rawPayload.orderCode;

  if (typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate > 0) {
    return String(candidate);
  }

  return typeof candidate === 'string' ? candidate.trim() : '';
}

/**
 * Hàm xác định luồng nghiệp vụ sở hữu orderCode webhook.
 * Mục đích: chỉ chuyển tiếp khi orderCode thuộc duy nhất một giao dịch để tránh xử lý nhầm hoặc mint sai.
 */
async function resolvePaymentWebhookFlow(orderCode: string): Promise<PaymentWebhookFlow | null> {
  const [accountDeposit, guestDeposit, guestDonation] = await Promise.all([
    findDepositTransactionByOrderCode(orderCode),
    findGuestDepositByOrderCodeRepo(orderCode),
    findGuestPayosDonationByOrderCode(orderCode)
  ]);

  const matchedFlowList: PaymentWebhookFlow[] = [
    ...(accountDeposit ? ['ACCOUNT_DEPOSIT'] as const : []),
    ...(guestDeposit ? ['GUEST_DEPOSIT'] as const : []),
    ...(guestDonation ? ['GUEST_DONATION'] as const : [])
  ];

  if (matchedFlowList.length !== 1) {
    if (matchedFlowList.length > 1) {
      logger.error('Webhook PayOS có orderCode trùng giữa nhiều luồng thanh toán.', { orderCode, matchedFlowList });
    }
    return null;
  }

  return matchedFlowList[0];
}

/**
 * Hàm trả health check cho webhook thanh toán PayOS dùng chung.
 * Mục đích: giúp PayOS xác thực URL callback duy nhất trước khi gửi giao dịch thật.
 */
export async function handlePayosPaymentWebhookHealth(_request: Request, response: Response): Promise<void> {
  response.status(200).json({ message: 'PayOS payment webhook URL hoạt động.' });
}

/**
 * Hàm điều phối webhook thanh toán PayOS cho ba luồng nạp tiền.
 * Mục đích: dùng một callback công khai nhưng vẫn giữ kiểm tra checksum và nghiệp vụ riêng của từng luồng.
 */
export async function handlePayosPaymentWebhook(request: Request, response: Response): Promise<void> {
  const orderCode = extractWebhookOrderCode(request.body);
  if (!orderCode) {
    response.status(200).json({ message: 'PayOS payment webhook URL hoạt động.' });
    return;
  }

  const paymentWebhookFlow = await resolvePaymentWebhookFlow(orderCode);
  if (!paymentWebhookFlow) {
    response.status(200).json({ message: 'Webhook payment chưa có giao dịch cần xử lý.' });
    return;
  }

  if (paymentWebhookFlow === 'ACCOUNT_DEPOSIT') {
    await handleDepositWebhook(request, response);
    return;
  }

  if (paymentWebhookFlow === 'GUEST_DEPOSIT') {
    await handleGuestDepositWebhook(request, response);
    return;
  }

  await handleGuestPayosWebhook(request, response);
}
