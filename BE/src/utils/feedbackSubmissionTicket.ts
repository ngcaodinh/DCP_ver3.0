import crypto from 'crypto';
import { isProductionPlaceholder } from '../config/publicFeedbackRuntimeConfig';
import { ApplicationError } from './applicationError';

const TICKET_TTL_SECONDS = 30 * 60;
const MINIMUM_PRODUCTION_KEY_LENGTH = 32;
let developmentTicketKey: string | null = null;

type TicketPayload = {
  projectId: string;
  issuedAt: number;
  nonce: string;
};

/** Lấy khóa HMAC cho ticket và dừng sớm ở production nếu bí mật chưa đủ mạnh. */
export function getFeedbackTicketHmacKey(): string {
  const configuredKey = process.env.FEEDBACK_TICKET_HMAC_KEY?.trim() || '';
  if (configuredKey) {
    if (process.env.NODE_ENV === 'production' && configuredKey.length < MINIMUM_PRODUCTION_KEY_LENGTH) {
      throw new Error(`FEEDBACK_TICKET_HMAC_KEY must be at least ${MINIMUM_PRODUCTION_KEY_LENGTH} characters in production.`);
    }
    if (process.env.NODE_ENV === 'production' && isProductionPlaceholder(configuredKey)) {
      throw new Error('FEEDBACK_TICKET_HMAC_KEY must not use a production placeholder value.');
    }
    return configuredKey;
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error('FEEDBACK_TICKET_HMAC_KEY is not configured in production.');
  }

  if (!developmentTicketKey) {
    developmentTicketKey = crypto.randomBytes(32).toString('hex');
  }
  return developmentTicketKey;
}

/** Kiểm tra cấu hình HMAC ticket ngay khi backend khởi động. */
export function validateFeedbackSubmissionTicketConfig(): void {
  getFeedbackTicketHmacKey();
}

/** Mã hóa payload ticket sang base64url để form có thể gửi dưới dạng trường ẩn. */
function encodeTicketPayload(payload: TicketPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/** Tạo chữ ký HMAC-SHA256 cho payload ticket theo đúng namespace của feedback public. */
function signTicketPayload(encodedPayload: string): string {
  return crypto.createHmac('sha256', getFeedbackTicketHmacKey()).update(encodedPayload).digest('hex');
}

/** Phát hành ticket một lần cho đúng project và thời hạn 30 phút. */
export function issueSubmissionTicket(projectId: string): string {
  const payload = encodeTicketPayload({
    projectId,
    issuedAt: Date.now(),
    nonce: crypto.randomUUID()
  });
  return `${payload}.${signTicketPayload(payload)}`;
}

/** Giải mã payload ticket sau khi xác minh chữ ký để không tin dữ liệu đã bị sửa đổi. */
function decodeTicketPayload(encodedPayload: string): TicketPayload {
  try {
    const decoded = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as unknown;
    if (!decoded || typeof decoded !== 'object') throw new Error('Invalid payload');
    const candidate = decoded as Record<string, unknown>;
    if (
      typeof candidate.projectId !== 'string' ||
      typeof candidate.issuedAt !== 'number' ||
      typeof candidate.nonce !== 'string' ||
      !candidate.nonce
    ) {
      throw new Error('Invalid payload');
    }
    return {
      projectId: candidate.projectId,
      issuedAt: candidate.issuedAt,
      nonce: candidate.nonce
    };
  } catch {
    throw new ApplicationError('Ticket không hợp lệ.', 400, 'INVALID_TICKET');
  }
}

/** Xác minh HMAC bằng timingSafeEqual, projectId và thời hạn trước khi ticket được chiếm. */
export function verifySubmissionTicket(ticket: string, projectId: string): TicketPayload {
  const separatorIndex = ticket.lastIndexOf('.');
  if (separatorIndex <= 0) {
    throw new ApplicationError('Ticket không hợp lệ.', 400, 'INVALID_TICKET');
  }

  const encodedPayload = ticket.slice(0, separatorIndex);
  const providedSignature = ticket.slice(separatorIndex + 1);
  const expectedSignature = signTicketPayload(encodedPayload);
  const providedBuffer = Buffer.from(providedSignature, 'utf8');
  const expectedBuffer = Buffer.from(expectedSignature, 'utf8');
  if (
    providedBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(providedBuffer, expectedBuffer)
  ) {
    throw new ApplicationError('Ticket không hợp lệ.', 400, 'INVALID_TICKET');
  }

  const payload = decodeTicketPayload(encodedPayload);
  if (payload.projectId !== projectId) {
    throw new ApplicationError('Ticket không thuộc project này.', 400, 'INVALID_TICKET');
  }

  const ticketAgeSeconds = (Date.now() - payload.issuedAt) / 1000;
  if (ticketAgeSeconds >= TICKET_TTL_SECONDS) {
    throw new ApplicationError('Phiên gửi feedback đã hết hạn.', 400, 'TICKET_EXPIRED');
  }
  if (ticketAgeSeconds < 0) {
    throw new ApplicationError('Ticket không hợp lệ.', 400, 'INVALID_TICKET');
  }

  return payload;
}

export { TICKET_TTL_SECONDS };
