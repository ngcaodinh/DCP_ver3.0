import { getRedisClientIfReady } from '../config/redis';
import { getLogger } from '../config/logger';
import {
  processDisbursementTransferWebhook,
  type DisbursementTransferWebhookPayload,
  type DisbursementResult
} from './disbursementService';
import { verifyPayosTransferWebhookChecksum } from './payosService';
import { processAuditorPayoutPayosResult } from './auditorPayoutService';
import {
  WebhookAuditLogModel,
  createWebhookAuditId,
  type WebhookAuditAction
} from '../models/webhookAuditLogModel';
const logger = getLogger();

/**
 * Prefix cho Redis key idempotency.
 * Format: webhook:payos:{orderCode/requestId}:{status}
 */
const IDEMPOTENCY_KEY_PREFIX = 'webhook:payos:';

/**
 * Thoi gian het han cua idempotency key (30 ngay).
 * Du dai de xu ly retry tu PayOS sau nhieu ngay.
 */
const IDEMPOTENCY_KEY_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * Ket qua xu ly webhook.
 */
export type PayosWebhookProcessResult = {
  success: boolean;
  isDuplicate: boolean;
  disbursement: DisbursementResult | null;
  message: string;
};

/**
 * Hàm tạo idempotency key từ orderCode/requestId và trạng thái.
 * Mục đích: cho phép webhook cập nhật từ PROCESSING sang trạng thái terminal.
 */
function buildIdempotencyKey(identifier: string, status: string): string {
  return `${IDEMPOTENCY_KEY_PREFIX}${identifier}:${status}`;
}

/**
 * Ham trich xuat orderCode tu payload webhook.
 * Muc dich: lay dinh danh de tao idempotency key.
 */
function extractOrderCode(payload: DisbursementTransferWebhookPayload): string | null {
  // Thu extract tu data object truoc
  const data = payload.data as Record<string, unknown> | undefined;
  if (data) {
    const orderCode = data.orderCode || data.requestId || data.referenceId;
    if (typeof orderCode === 'string' && orderCode.length > 0) {
      return orderCode.trim();
    }
    if (typeof orderCode === 'number') {
      return String(orderCode);
    }
  }

  // Fallback sang top-level fields
  const topLevelOrderCode = payload.requestId || payload.transferId;
  if (typeof topLevelOrderCode === 'string' && topLevelOrderCode.length > 0) {
    return topLevelOrderCode.trim();
  }
  if (typeof topLevelOrderCode === 'number') {
    return String(topLevelOrderCode);
  }

  return null;
}

/**
 * Hàm trích xuất trạng thái webhook để phân biệt các lần callback trong cùng transfer.
 * Mục đích: giữ idempotency theo từng trạng thái thay vì khóa cả vòng đời orderCode.
 */
function extractWebhookStatus(payload: DisbursementTransferWebhookPayload): string {
  const data = payload.data as Record<string, unknown> | undefined;
  const rawStatus = data?.state
    || data?.status
    || data?.approvalState
    || payload.status
    || payload.code
    || 'UNKNOWN';

  return String(rawStatus).trim().toUpperCase() || 'UNKNOWN';
}

/** Chỉ nhận diện payout Auditor từ reference UUID do hệ thống tạo, tránh query Mongo thừa cho lane giải ngân. */
function isAuditorPayoutWebhook(payload: DisbursementTransferWebhookPayload): boolean {
  const data = payload.data as Record<string, unknown> | undefined;
  const referenceId = data?.referenceId ?? data?.requestId ?? payload.requestId;
  return typeof referenceId === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(referenceId.trim());
}

/**
 * Hàm kiểm tra và thiết lập idempotency key trong Redis.
 * Trả về true nếu request là mới (key chưa tồn tại).
 * Trả về false nếu request là duplicate (key đã tồn tại).
 * Mục đích: chống xử lý trùng lặp webhook.
 */
async function checkAndSetIdempotency(orderCode: string, status: string): Promise<boolean> {
  const redisClient = getRedisClientIfReady();
  if (!redisClient) {
    logger.warn('Redis chua san sang, bo qua idempotency check. orderCode=${orderCode}', { orderCode: orderCode });
    return true;
  }

  const idempotencyKey = buildIdempotencyKey(orderCode, status);
  try {
    // SETNX voi TTL - tra ve 1 neu key moi duoc set (true), 0 neu key da ton tai (false)
    const result = await redisClient.setNX(idempotencyKey, Date.now().toString());
    if (result) {
      // Key moi duoc tao, set TTL
      await redisClient.expire(idempotencyKey, IDEMPOTENCY_KEY_TTL_SECONDS);
      logger.info('Idempotency key da duoc thiet lap. orderCode=${orderCode}', { orderCode: orderCode });
      return true;
    }

    logger.info('Webhook trung lap, bo qua xu ly. orderCode=${orderCode}', { orderCode: orderCode });
    return false;
  } catch (error) {
    logger.error('Loi khi kiem tra idempotency key. orderCode=${orderCode}', {
      orderCode: orderCode,
      errorMessage: (error as Error)?.message
    });
    // Khi loi Redis, cho phep xu ly de tranh miss webhook
    return true;
  }
}

/**
 * Ham sanitize payload truoc khi ghi audit log.
 * Loai bo cac truong nhay cam nhu so tai khoan, ten chu tai khoan.
 * Muc dich: dam bao audit log khong chua sensitive data.
 */
function sanitizePayloadForAuditLog(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object') {
    return {};
  }

  const sanitized: Record<string, unknown> = {};
  const payloadObj = payload as Record<string, unknown>;

  const sensitiveFields = [
    'accountNumber', 'account_number', 'bankAccountNumber',
    'accountHolderName', 'account_holder_name', 'holderName',
    'bankCode', 'bank_code', 'accountType', 'account_type',
    'password', 'secret', 'token', 'apiKey', 'api_key', 'secretKey'
  ];

  for (const [key, value] of Object.entries(payloadObj)) {
    const lowerKey = key.toLowerCase();
    const isSensitive = sensitiveFields.some(
      sensitiveField => lowerKey.includes(sensitiveField)
    );

    if (isSensitive) {
      sanitized[key] = '[REDACTED]';
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      sanitized[key] = sanitizePayloadForAuditLog(value);
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

/**
 * Ham ghi audit log cho webhook.
 * Muc dich: theo doi cac su kien webhook cho bao mat va debug.
 */
async function writeWebhookAuditLog(
  action: WebhookAuditAction,
  sourceIp: string,
  requestBody: unknown,
  signature: string | null,
  orderCode: string | null,
  errorMessage: string | null
): Promise<void> {
  try {
    const auditLog = {
      auditId: createWebhookAuditId(),
      action,
      sourceIp,
      requestBody: sanitizePayloadForAuditLog(requestBody),
      signature,
      orderCode,
      errorMessage,
      timestamp: new Date()
    };

    await WebhookAuditLogModel.create(auditLog);
    logger.info('Da ghi webhook audit log.', { auditId: auditLog.auditId, action, orderCode: orderCode ?? undefined });
  } catch (error) {
    logger.error('Ghi webhook audit log that bai.', {
      action,
      orderCode: orderCode ?? undefined,
      errorMessage: (error as Error)?.message
    });
  }
}

/**
 * Ham verify checksum cua webhook payload.
 * Tra ve true neu checksum hop le, false neu khong.
 * Muc dich: xac thuc webhook thuc su den tu PayOS.
 */
function verifyWebhookChecksum(payload: DisbursementTransferWebhookPayload): boolean {
  // Lay checksum tu payload
  const checksum = payload.signature || payload.checksum;
  if (!checksum) {
    return false;
  }

  // Build data object de verify
  const payloadData = (payload.data && typeof payload.data === 'object')
    ? payload.data as Record<string, unknown>
    : { ...(payload as unknown as Record<string, unknown>) };

  // Xoa checksum/signature khoi data truoc khi verify
  const dataForVerify = { ...payloadData };
  delete dataForVerify.signature;
  delete dataForVerify.checksum;

  return verifyPayosTransferWebhookChecksum(dataForVerify, checksum);
}

/**
 * Ham xu ly webhook PayOS chuyen khoan giai ngan.
 * Thuc hien: verify signature, idempotency check, cap nhat disbursement, emit notification.
 * Muc dich: endpoint chinh cho webhook FR8 voi day du tinh nang bao mat.
 */
export async function processPayosWebhook(
  payload: DisbursementTransferWebhookPayload,
  sourceIp: string
): Promise<PayosWebhookProcessResult> {
  const orderCode = extractOrderCode(payload);

  // Buoc 1: Verify checksum truoc khi xu ly
  if (!verifyWebhookChecksum(payload)) {
    logger.warn('Webhook PayOS co checksum khong hop le. orderCode=${orderCode}', { orderCode: orderCode ?? undefined });

    // Ghi audit log cho signature khong hop le
    await writeWebhookAuditLog(
      'WEBHOOK_SIGNATURE_INVALID',
      sourceIp,
      payload,
      payload.signature || payload.checksum || null,
      orderCode,
      'Invalid HMAC-SHA256 signature'
    );

    // Log su kien bao mat
    logger.warn('Phat hien webhook voi signature khong hop le - co the la tan cong gia mao.', {
      sourceIp,
      orderCode: orderCode ?? undefined
    });

    throw new Error('Webhook checksum khong hop le.');
  }

  // Buoc 2: Idempotency check
  if (orderCode) {
    const isNewRequest = await checkAndSetIdempotency(orderCode, extractWebhookStatus(payload));
    if (!isNewRequest) {
      // Webhook trung lap - ghi audit log va tra ve thanh cong (idempotent)
      await writeWebhookAuditLog(
        'WEBHOOK_DUPLICATE',
        sourceIp,
        payload,
        payload.signature || payload.checksum || null,
        orderCode,
        null
      );

      return {
        success: true,
        isDuplicate: true,
        disbursement: null,
        message: 'Webhook da duoc xu ly truoc do.'
      };
    }
  }

  // Buoc 3: Xu ly webhook thong qua service co san
  try {
    const callbackData = payload.data as Record<string, unknown> | undefined;
    const transferIdCandidate = callbackData?.transferId ?? callbackData?.id ?? payload.transferId;
    let handledAuditorPayout = false;
    if (isAuditorPayoutWebhook(payload)) {
      try {
        handledAuditorPayout = await processAuditorPayoutPayosResult(
          typeof transferIdCandidate === 'string' ? transferIdCandidate : null,
          extractWebhookStatus(payload)
        );
      } catch (error) {
        // Lỗi lane Auditor không được phép làm PayOS retry webhook giải ngân đã hợp lệ.
        logger.warn('Không thể xử lý webhook payout Auditor; tiếp tục lane giải ngân.', {
          errorMessage: error instanceof Error ? error.message : 'UNKNOWN_ERROR'
        });
      }
    }
    if (handledAuditorPayout) {
      await writeWebhookAuditLog('WEBHOOK_PROCESSED', sourceIp, payload, payload.signature || payload.checksum || null, orderCode, null);
      return { success: true, isDuplicate: false, disbursement: null, message: 'Webhook chi trả Kiểm toán viên đã được xử lý.' };
    }
    const disbursement = await processDisbursementTransferWebhook(payload);

    // Buoc 4: Ghi audit log thanh cong
    await writeWebhookAuditLog(
      'WEBHOOK_PROCESSED',
      sourceIp,
      payload,
      payload.signature || payload.checksum || null,
      orderCode,
      null
    );

    return {
      success: true,
      isDuplicate: false,
      disbursement,
      message: 'Webhook da duoc xu ly thanh cong.'
    };
  } catch (error) {
    const errorMessage = (error as Error)?.message || 'Unknown error';

    // Ghi audit log cho loi xu ly
    await writeWebhookAuditLog(
      'WEBHOOK_PROCESSED',
      sourceIp,
      payload,
      payload.signature || payload.checksum || null,
      orderCode,
      errorMessage
    );

    logger.error('Xu ly webhook PayOS that bai. orderCode=${orderCode}', {
      orderCode: orderCode ?? undefined,
      errorMessage
    });

    throw error;
  }
}
