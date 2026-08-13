import { Request, Response } from 'express';
import { getLogger } from '../config/logger';
import { processPayosWebhook, type PayosWebhookProcessResult } from '../services/payosWebhookService';
import { type DisbursementTransferWebhookPayload } from '../services/disbursementService';

const logger = getLogger();

/**
 * Hàm trích xuất IP client từ request.
 * Ưu tiên: x-client-ip (đã được set bởi middleware) > x-forwarded-for > request.ip.
 * Mục đích: lấy IP thực của client để ghi audit log.
 */
function extractClientIp(request: Request): string {
  const clientIpHeader = request.headers['x-client-ip'];
  if (clientIpHeader && typeof clientIpHeader === 'string') {
    return clientIpHeader.split(',')[0].trim();
  }

  const forwardedFor = request.headers['x-forwarded-for'];
  if (forwardedFor && typeof forwardedFor === 'string') {
    return forwardedFor.split(',')[0].trim();
  }

  return request.ip || 'unknown';
}

/**
 * Hàm xây dựng payload cho service từ request body.
 * Chuẩn hóa signature và checksum từ headers và body.
 * Mục đích: đảm bảo payload có đủ thông tin để verify.
 */
function buildWebhookPayload(request: Request): DisbursementTransferWebhookPayload {
  const rawPayload = request.body || {};

  // Lấy signature từ headers theo thứ tự ưu tiên
  const signatureFromHeader = String(
    request.headers['x-payos-signature']
    || request.headers['x-signature']
    || request.headers['x-checksum']
    || ''
  ).trim();

  // Lấy signature từ body
  const signatureFromBody = String(
    (rawPayload as { signature?: string }).signature
    || (rawPayload as { checksum?: string }).checksum
    || ''
  ).trim();

  // Normalize checksum - ưu tiên body, sau đó header
  const normalizedChecksum = signatureFromBody || signatureFromHeader || undefined;
  const checksumSource: 'header' | 'body' | 'missing' = signatureFromBody
    ? 'body'
    : (signatureFromHeader ? 'header' : 'missing');

  return {
    ...(rawPayload as DisbursementTransferWebhookPayload),
    signature: normalizedChecksum,
    checksum: normalizedChecksum,
    checksumSource
  };
}

/**
 * GET /api/webhooks/payos
 * Health check endpoint cho PayOS webhook.
 * Dùng để PayOS kiểm tra URL callback có hoạt động không.
 * Actor: PayOS system health-check.
 */
export async function handlePayosWebhookHealth(_request: Request, response: Response): Promise<void> {
  response.status(200).json({
    message: 'PayOS webhook URL hoạt động.',
    timestamp: new Date().toISOString()
  });
}

/**
 * POST /api/webhooks/payos
 * Xử lý webhook transfer từ PayOS cho FR8.
 * Thực hiện: verify signature, idempotency check, cập nhật disbursement, emit notification.
 * Actor: PayOS callback.
 */
export async function handlePayosWebhook(request: Request, response: Response): Promise<void> {
  const clientIp = extractClientIp(request);

  try {
    // Kiểm tra payload có trống không
    const rawPayload = request.body || {};
    if (Object.keys(rawPayload).length === 0) {
      logger.warn('Nhận webhook PayOS với payload trống.', { ipAddress: clientIp });
      response.status(200).json({
        message: 'Webhook URL hoạt động.'
      });
      return;
    }

    // Build payload cho service
    const webhookPayload = buildWebhookPayload(request);

    // Kiểm tra có đủ thông tin định danh không
    const hasBusinessIdentifier = Boolean(
      webhookPayload.requestId
      || webhookPayload.transferId
      || (webhookPayload.data as Record<string, unknown>)?.requestId
      || (webhookPayload.data as Record<string, unknown>)?.transferId
    );

    if (!hasBusinessIdentifier) {
      logger.warn('Webhook PayOS thiếu thông tin định danh.', { ipAddress: clientIp });
      response.status(200).json({
        message: 'Webhook URL hoạt động.'
      });
      return;
    }

    // Xử lý webhook
    const result: PayosWebhookProcessResult = await processPayosWebhook(webhookPayload, clientIp);

    if (result.isDuplicate) {
      // Webhook trùng lặp - trả về thành công (idempotent)
      logger.info('Webhook PayOS trùng lặp đã được bỏ qua.', { ipAddress: clientIp });
      response.status(200).json({
        message: result.message,
        isDuplicate: true
      });
      return;
    }

    // Webhook xử lý thành công
    logger.info('Webhook PayOS đã xử lý thành công.', { ipAddress: clientIp });
    response.status(200).json({
      message: result.message,
      isDuplicate: false,
      requestId: result.disbursement?.requestId,
      status: result.disbursement?.status,
      payosTransferStatus: result.disbursement?.payosTransferStatus
    });
  } catch (error) {
    const errorMessage = (error as Error)?.message || 'Webhook không hợp lệ.';

    // Log lỗi chi tiết
    logger.error('Xử lý webhook PayOS thất bại.', {
      ipAddress: clientIp,
      errorMessage
    });

    // Trả về lỗi 400 cho checksum không hợp lệ
    if (errorMessage.includes('checksum không hợp lệ') || errorMessage.includes('signature không hợp lệ')) {
      response.status(400).json({
        message: errorMessage
      });
      return;
    }

    // Trả về lỗi 404 cho disbursement không tìm thấy
    if (errorMessage.includes('Không tìm thấy disbursement')) {
      response.status(200).json({
        message: 'Webhook URL hoạt động.'
      });
      return;
    }

    // Các lỗi khác - vẫn trả 200 để PayOS không retry
    response.status(200).json({
      message: 'Webhook đã được nhận.'
    });
  }
}
