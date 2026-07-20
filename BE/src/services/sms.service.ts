/**
 * Service gửi SMS qua Twilio.
 * Fallback sang EMAIL khi SMS fail.
 */
import twilio from 'twilio';
import { getLogger } from '../config/logger';
import { SMS_TIMEOUT_MS } from './constants/notification.constants';
import type { DeliveryResult } from './types/delivery.types';

const logger = getLogger();

// Twilio client — singleton
let twilioClient: ReturnType<typeof twilio> | null = null;

/**
 * Kiểm tra Twilio credentials có được cấu hình hay chưa.
 */
function hasTwilioCredentials(): boolean {
  return !!(
    process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_AUTH_TOKEN &&
    process.env.TWILIO_FROM_NUMBER
  );
}

/**
 * Lấy Twilio client instance (lazy initialization).
 *
 * Env vars bắt buộc:
 * - TWILIO_ACCOUNT_SID: Account SID từ Twilio Console
 * - TWILIO_AUTH_TOKEN: Auth Token từ Twilio Console
 * - TWILIO_FROM_NUMBER: Số điện thoại gửi (đã verify hoặc purchased)
 */
function getTwilioClient(): ReturnType<typeof twilio> | null {
  if (twilioClient) return twilioClient;

  if (!hasTwilioCredentials()) {
    logger.warn('Thiếu Twilio credentials trong environment variables.');
    return null;
  }

  try {
    const accountSid = process.env.TWILIO_ACCOUNT_SID!;
    const authToken = process.env.TWILIO_AUTH_TOKEN!;

    twilioClient = twilio(accountSid, authToken, { accountSid });

    logger.info('Twilio client đã được khởi tạo thành công.', {
      accountSid: accountSid.substring(0, 10) + '...'
    });

    return twilioClient;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('Không thể khởi tạo Twilio client.', {
      errorMessage
    });
    return null;
  }
}

/**
 * Reset Twilio client (dùng cho testing).
 */
export function resetTwilioClient(): void {
  twilioClient = null;
}

/**
 * Set Twilio client với mock (cho testing).
 */
export function setTwilioClient(mock: ReturnType<typeof twilio>): void {
  twilioClient = mock;
}

/**
 * Gửi SMS qua Twilio.
 * Đây là entry point chính cho SMS channel.
 *
 * @param options Các tham số gửi SMS
 * @returns DeliveryResult
 */
export async function sendSms(options: {
  to: string;
  body: string;
}): Promise<DeliveryResult> {
  const client = getTwilioClient();

  if (!client) {
    return {
      success: false,
      channel: 'SMS',
      errorMessage: 'Twilio client không khả dụng (thiếu credentials hoặc chưa init)',
      retryable: false
    };
  }

  const from = process.env.TWILIO_FROM_NUMBER!;
  const startTime = Date.now();

  try {
    // Normalize phone number
    const normalizedTo = normalizePhoneNumber(options.to);
    if (!normalizedTo) {
      return {
        success: false,
        channel: 'SMS',
        errorMessage: `Số điện thoại không hợp lệ: ${options.to}`,
        retryable: false
      };
    }

    const result = await Promise.race([
      client.messages.create({
        body: options.body,
        from,
        to: normalizedTo
      }),
      new Promise<'timeout'>((_, reject) =>
        setTimeout(() => reject(new Error('Twilio timeout')), SMS_TIMEOUT_MS)
      )
    ]) as { sid: string; status: string };

    const latencyMs = Date.now() - startTime;

    logger.info('SMS đã được gửi thành công qua Twilio.', {
      messageSid: result.sid,
      status: result.status,
      to: normalizedTo.substring(0, 6) + '****',
      latencyMs
    });

    return {
      success: true,
      channel: 'SMS',
      providerMessageId: result.sid,
      latencyMs
    };
  } catch (error) {
    const latencyMs = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);

    logger.error('SMS thất bại qua Twilio.', {
      to: options.to.substring(0, 6) + '****',
      errorMessage,
      latencyMs
    });

    // Kiểm tra xem lỗi có retryable hay không
    const retryable = isRetryableTwilioError(error);

    return {
      success: false,
      channel: 'SMS',
      errorMessage,
      retryable
    };
  }
}

/**
 * Normalize phone number thành E.164 format.
 * Hỗ trợ:
 * - Số Việt Nam: 0xxx → +84xxx
 * - Số đã có +: giữ nguyên
 * - E.164: giữ nguyên
 */
function normalizePhoneNumber(phone: string): string | null {
  // Loại bỏ khoảng trắng, dấu gạch ngang, dấu chấm, dấu ngoặc
  const cleaned = phone.replace(/[\s\-./()]/g, '');

  // E.164: bắt đầu bằng +, theo sau là 8-15 chữ số (chuẩn ITU-T E.164)
  if (cleaned.startsWith('+')) {
    if (/^\+\d{8,15}$/.test(cleaned)) {
      return cleaned;
    }
    return null;
  }

  // Số Việt Nam local: bắt đầu bằng 0, đúng 10 chữ số
  if (/^0\d{9}$/.test(cleaned)) {
    return '+84' + cleaned.substring(1);
  }

  // Số quốc tế không có +: 8-15 chữ số (E.164 strict)
  if (/^\d{8,15}$/.test(cleaned)) {
    return '+' + cleaned;
  }

  return null;
}

/**
 * Kiểm tra xem lỗi Twilio có retryable hay không.
 */
function isRetryableTwilioError(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    // Lỗi không retry: invalid number, not authorized, account suspended
    if (message.includes('not a valid phone number')) return false;
    if (message.includes('not authorized')) return false;
    if (message.includes('account suspended')) return false;
    if (message.includes('unreachable')) return false;
    if (message.includes('unsubscribed')) return false;
    // Timeout thì retry
    if (message.includes('timeout')) return true;
  }
  // Mặc định retry
  return true;
}

/**
 * Gửi SMS notification dựa trên dispatch context.
 * Dùng bởi notificationDispatcher cho critical alerts.
 *
 * @param dispatchContext Thông tin user context cho dispatch
 * @param notificationData Dữ liệu notification cần gửi
 * @returns DeliveryResult
 */
export async function sendNotificationSms(
  dispatchContext: { userId: string; phoneNumber?: string },
  notificationData: {
    notificationId: string;
    title: string;
    content: string;
    notificationType: string;
  }
): Promise<DeliveryResult> {
  if (!dispatchContext.phoneNumber) {
    return {
      success: false,
      channel: 'SMS',
      errorMessage: 'User không có số điện thoại — skip SMS channel',
      retryable: false
    };
  }

  // SMS ngắn gọn hơn email — giới hạn 160 chars cho single-segment
  const smsBody = buildSmsBody(notificationData.title, notificationData.content);

  return sendSms({
    to: dispatchContext.phoneNumber,
    body: smsBody
  });
}

/**
 * Build SMS body ngắn gọn từ notification data.
 * Cắt nếu vượt 160 chars (single SMS segment limit).
 */
function buildSmsBody(title: string, content: string): string {
  const separator = ' | ';
  let body = `${title}${separator}${content}`;

  // SMS limit: 160 chars cho single segment
  // Multi-segment SMS có overhead 7 bytes/segment
  const maxLength = 160;
  if (body.length > maxLength) {
    body = body.substring(0, maxLength - 3) + '...';
  }

  return body;
}

/**
 * Kiểm tra xem SMS service có sẵn sàng hay không.
 */
export function isSmsServiceReady(): boolean {
  return getTwilioClient() !== null;
}
