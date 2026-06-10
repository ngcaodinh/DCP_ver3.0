import crypto from 'crypto';
import mongoose, { Schema } from 'mongoose';

/**
 * Loai hanh dong audit log cho webhook.
 * WEBHOOK_SIGNATURE_INVALID: Ghi nhan webhook co chu ky khong hop le.
 * WEBHOOK_PROCESSED: Webhook duoc xu ly thanh cong.
 * WEBHOOK_DUPLICATE: Webhook trung lap (idempotency check).
 */
export type WebhookAuditAction = 'WEBHOOK_SIGNATURE_INVALID' | 'WEBHOOK_PROCESSED' | 'WEBHOOK_DUPLICATE';

/**
 * Ban ghi audit log cho webhook PayOS.
 * Dung de ghi nhan cac su kien bao mat va hoat dong cua webhook.
 */
export type WebhookAuditLog = {
  auditId: string;
  action: WebhookAuditAction;
  sourceIp: string;
  requestBody: Record<string, unknown>;
  signature: string | null;
  orderCode: string | null;
  errorMessage: string | null;
  timestamp: Date;
};

const webhookAuditLogSchema = new Schema<WebhookAuditLog>({
  auditId: { type: String, required: true, unique: true },
  action: {
    type: String,
    required: true,
    enum: ['WEBHOOK_SIGNATURE_INVALID', 'WEBHOOK_PROCESSED', 'WEBHOOK_DUPLICATE']
  },
  sourceIp: { type: String, required: true },
  requestBody: { type: Schema.Types.Mixed, required: true, default: {} },
  signature: { type: String, default: null },
  orderCode: { type: String, default: null },
  errorMessage: { type: String, default: null },
  timestamp: { type: Date, required: true, default: Date.now }
});

// Index cho viec query nhanh theo thoi gian va action
webhookAuditLogSchema.index({ timestamp: -1 });
webhookAuditLogSchema.index({ action: 1, timestamp: -1 });
webhookAuditLogSchema.index({ orderCode: 1 });

export const WebhookAuditLogModel = mongoose.models.WebhookAuditLog
  || mongoose.model<WebhookAuditLog>('WebhookAuditLog', webhookAuditLogSchema, 'admin_audit_logs');

/**
 * Ham tao ma audit log duy nhat.
 * Muc dich: sinh ID an toan cho ban ghi audit log.
 * Dung crypto.randomBytes thay vi Math.random() de dam bao tinh ngau nhien cryptographically secure.
 */
export function createWebhookAuditId(): string {
  const randomPart = crypto.randomBytes(6).toString('hex').toUpperCase();
  return `WAL-${Date.now()}-${randomPart}`;
}
