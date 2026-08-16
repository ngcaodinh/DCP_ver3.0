import { getRedisClientIfReady } from '../config/redis';
import { getLogger } from '../config/logger';
import {
  processDisbursementTransferWebhook,
  type DisbursementTransferWebhookPayload,
  type DisbursementResult
} from './disbursementService';
import { verifyPayosTransferWebhookChecksum } from './payosService';
import { webhookEvents, type DisbursementWebhookEventPayload } from '../events/webhookEvents';
import {
  WebhookAuditLogModel,
  createWebhookAuditId,
  type WebhookAuditAction
} from '../models/webhookAuditLogModel';
import * as eventLoggerService from './event-logger.service';
/**
 * Cac hang so trang thai dung trong webhook handler.
 * Dung thay cho magic strings de tranh loi type-safe khi disbursementService thay doi enum.
 */
const DISBURSEMENT_STATUS_COMPLETED = 'COMPLETED';
const PAYOS_TRANSFER_STATUS_SUCCESS = 'SUCCESS';
const PAYOS_TRANSFER_STATUS_MANUAL_REVIEW = 'MANUAL_REVIEW';
const PAYOS_TRANSFER_STATUS_FAILED = 'FAILED';

const logger = getLogger();

/**
 * Prefix cho Redis key idempotency.
 * Format: webhook:payos:{orderCode/requestId}
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
 * Ham tao idempotency key tu orderCode/requestId.
 * Muc dich: tao key duy nhat cho moi webhook request.
 */
function buildIdempotencyKey(identifier: string): string {
  return `${IDEMPOTENCY_KEY_PREFIX}${identifier}`;
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
 * Ham kiem tra va thiet lap idempotency key trong Redis.
 * Tra ve true neu request la moi (key chua ton tai).
 * Tra ve false neu request la duplicate (key da ton tai).
 * Muc dich: chong xu ly trung lap webhook.
 */
async function checkAndSetIdempotency(orderCode: string): Promise<boolean> {
  const redisClient = getRedisClientIfReady();
  if (!redisClient) {
    logger.warn('Redis chua san sang, bo qua idempotency check. orderCode=${orderCode}', { orderCode: orderCode });
    return true;
  }

  const idempotencyKey = buildIdempotencyKey(orderCode);
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
 * Ham emit notification event sau khi xu ly webhook thanh cong.
 * Muc dich: gui thong bao cho organization khi disbursement hoan tat hoac that bai.
 * Ghi chu: organizationId da co trong DisbursementResult (da duoc them sau review A2)
 * nen khong can query lai tu DB, traanh N+1 query.
 */
async function emitDisbursementNotification(
  disbursement: DisbursementResult,
  _rawPayload: DisbursementTransferWebhookPayload
): Promise<void> {
  try {
    const eventPayload: DisbursementWebhookEventPayload = {
      requestId: disbursement.requestId,
      projectId: disbursement.projectId,
      organizationId: disbursement.organizationId,
      amount: disbursement.amount,
      status: disbursement.status,
      payosTransferStatus: disbursement.payosTransferStatus || 'UNKNOWN',
      payosTransferId: disbursement.payosTransferId,
      transactionHash: null
    };

    // Xac dinh loai event dua tren trang thai
    if (disbursement.status === DISBURSEMENT_STATUS_COMPLETED && disbursement.payosTransferStatus === PAYOS_TRANSFER_STATUS_SUCCESS) {
      webhookEvents.emit('DISBURSEMENT_TRANSFERRED', eventPayload);
      eventLoggerService.logEvent({
        eventType: 'DISBURSEMENT_TRANSFERRED',
        projectId: disbursement.projectId,
        organizationId: disbursement.organizationId,
        amount: disbursement.amount,
        correlationId: disbursement.requestId,
        timestamp: new Date(),
        payload: {
          requestId: disbursement.requestId,
          status: disbursement.status,
          payosTransferStatus: disbursement.payosTransferStatus,
          payosTransferId: disbursement.payosTransferId,
          transactionHash: eventPayload.transactionHash
        }
      });
      logger.info('Da emit DISBURSEMENT_TRANSFERRED event. requestId=${disbursement.requestId}', {
        requestId: disbursement.requestId
      });
    } else if (
      disbursement.payosTransferStatus === PAYOS_TRANSFER_STATUS_MANUAL_REVIEW
      || disbursement.payosTransferStatus === PAYOS_TRANSFER_STATUS_FAILED
    ) {
      webhookEvents.emit('DISBURSEMENT_TRANSFER_FAILED', eventPayload);
      eventLoggerService.logEvent({
        eventType: 'DISBURSEMENT_TRANSFER_FAILED',
        projectId: disbursement.projectId,
        organizationId: disbursement.organizationId,
        amount: disbursement.amount,
        correlationId: disbursement.requestId,
        timestamp: new Date(),
        payload: {
          requestId: disbursement.requestId,
          status: disbursement.status,
          payosTransferStatus: disbursement.payosTransferStatus,
          payosTransferId: disbursement.payosTransferId,
          transactionHash: eventPayload.transactionHash
        }
      });
      logger.info('Da emit DISBURSEMENT_TRANSFER_FAILED event. requestId=${disbursement.requestId}', {
        requestId: disbursement.requestId
      });
    }
  } catch (error) {
    logger.error('Emit notification event that bai. requestId=${disbursement.requestId}', {
      requestId: disbursement.requestId,
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
    const isNewRequest = await checkAndSetIdempotency(orderCode);
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
    const disbursement = await processDisbursementTransferWebhook(payload);

    // Buoc 4: Emit notification event
    await emitDisbursementNotification(disbursement, payload);

    // Buoc 5: Ghi audit log thanh cong
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
