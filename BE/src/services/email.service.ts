/**
 * Service gửi email qua Gmail SMTP với Nodemailer + Handlebars template engine.
 * Hỗ trợ retry 3 lần, interval 1 phút, fallback to IN_APP khi exhausted.
 */
import nodemailer from 'nodemailer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Handlebars from 'handlebars';
import { getLogger } from '../config/logger';
import {
  EMAIL_MAX_RETRY_ATTEMPTS,
  EMAIL_RETRY_INTERVAL_MS,
  EMAIL_TIMEOUT_MS,
  NOTIFICATION_EMAIL_TEMPLATE_MAP,
  getResolvedUnsubscribeBaseUrl
} from './constants/notification.constants';
import type { DeliveryResult, DispatchContext } from './types/delivery.types';

const logger = getLogger();

/**
 * ESM-compatible __dirname — hoạt động đúng trong bundled app, Docker, và TypeScript compiled output.
 * `__dirname` không tồn tại trong ESM; dùng `import.meta.url` thay thế.
 */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Chuyển đổi HTML special characters thành entities.
 * Dùng làm sanitize trước khi render vào email template — phòng trường hợp
 * template dùng triple-brace `{{{content}}}` (không escape) hoặc nội dung
 * từ nguồn không đáng tin cậy (blockchain event, external API).
 */
function escapeHtmlEntities(value: unknown): string {
  if (value == null) return '';
  const str = String(value);
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Cache compiled templates để không phải compile lại mỗi lần gửi.
const templateCache = new Map<string, HandlebarsTemplateDelegate<Record<string, unknown>>>();

/**
 * Cấu hình SMTP transport từ environment variables.
 * Mục đích: khởi tạo Nodemailer transport với credentials từ env.
 *
 * Env vars bắt buộc:
 * - SMTP_HOST: host SMTP (thường là smtp.gmail.com)
 * - SMTP_PORT: port SMTP (thường là 465 cho SSL)
 * - SMTP_USER: email gửi (username/app password Gmail)
 * - SMTP_PASS: app password Gmail (không phải account password)
 * - SMTP_FROM: tên hiển thị người gửi
 */
interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  auth: { user: string; pass: string };
  from: string;
}

/**
 * Lấy cấu hình SMTP từ environment variables.
 * @returns SmtpConfig hoặc null nếu thiếu env vars
 */
function getSmtpConfig(): SmtpConfig | null {
  const host = process.env.SMTP_HOST;
  const port = process.env.SMTP_PORT;
  const user = process.env.SMTP_USER;
  const password = process.env.SMTP_PASS;
  const from = process.env.SMTP_FROM;

  if (!host || !port || !user || !password || !from) {
    logger.warn('Thiếu SMTP configuration trong environment variables.', {
      hasHost: !!host,
      hasPort: !!port,
      hasUser: !!user,
      hasPassword: !!password,
      hasFrom: !!from
    });
    return null;
  }

  const portNum = parseInt(port, 10);
  // Port 465 thường dùng SSL, port 587 dùng STARTTLS
  const secure = portNum === 465;

  return {
    host,
    port: portNum,
    secure,
    auth: { user, pass: password },
    from
  };
}

/**
 * Nodemailer transporter — singleton, khởi tạo lazy.
 * Tái sử dụng connection pool giữa các lần gửi.
 */
let transporter: nodemailer.Transporter | null = null;

/**
 * Khởi tạo hoặc lấy transporter instance.
 * @returns Nodemailer transporter hoặc null nếu không có config
 */
function getTransporter(): nodemailer.Transporter | null {
  if (transporter) return transporter;

  const config = getSmtpConfig();
  if (!config) return null;

  transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: {
      user: config.auth.user,
      pass: config.auth.pass
    },
    pool: true,
    maxConnections: 5,
    rateLimit: 10, // Gmail limit: 100 email/ngày cho app password thường, 2000 cho Google Workspace
    timeout: EMAIL_TIMEOUT_MS
  });

  return transporter;
}

/**
 * Reset transporter (dùng cho testing).
 * Mục đích: cho phép mock inject transporter mới sau khi module đã load.
 */
export function resetTransporter(): void {
  transporter = null;
}

/**
 * Thiết lập transporter với mock (cho testing).
 */
export function setTransporter(mock: nodemailer.Transporter): void {
  transporter = mock;
}

/**
 * Load và compile Handlebars template từ file.
 * Templates được cache trong memory sau lần đầu load.
 *
 * @param templateName Tên template (không có extension, ví dụ: 'large-donation')
 * @returns Compiled Handlebars template
 * @throws Error nếu template file không tồn tại
 */
function loadTemplate(templateName: string): HandlebarsTemplateDelegate<Record<string, unknown>> {
  const cached = templateCache.get(templateName);
  if (cached) return cached;

  const templatePath = path.resolve(__dirname, '../../templates/email', `${templateName}.hbs`);
  if (!fs.existsSync(templatePath)) {
    throw new Error(`Email template không tồn tại: ${templateName}.hbs`);
  }

  const templateSource = fs.readFileSync(templatePath, 'utf-8');
  const compiled = Handlebars.compile(templateSource);

  // Cache compiled template
  templateCache.set(templateName, compiled);
  logger.info(`Email template loaded và compiled: ${templateName}`, { templateName });

  return compiled;
}

/**
 * Render HTML email từ template + context.
 *
 * @param templateName Tên template
 * @param context Dữ liệu fill vào template
 * @returns HTML string đã được render
 */
function renderTemplate(templateName: string, context: Record<string, unknown>): string {
  const template = loadTemplate(templateName);
  // Escape HTML entities cho tất cả giá trị string trong context.
  // Đảm bảo content/title không inject được HTML vào email ngay cả khi template dùng triple-brace.
  const sanitizedContext: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    sanitizedContext[key] = typeof value === 'string' ? escapeHtmlEntities(value) : value;
  }
  return template(sanitizedContext) as string;
}

/**
 * Gửi email một lần (không retry).
 * Dùng Nodemailer để gửi qua SMTP.
 *
 * @param options Các tham số gửi email
 * @returns DeliveryResult
 */
async function sendEmailOnce(options: {
  to: string;
  subject: string;
  html: string;
}): Promise<DeliveryResult> {
  const tp = getTransporter();
  if (!tp) {
    return {
      success: false,
      channel: 'EMAIL',
      errorMessage: 'SMTP transporter không khả dụng (thiếu config)',
      retryable: false
    };
  }

  const config = getSmtpConfig();
  const startTime = Date.now();

  try {
    const result = await tp.sendMail({
      from: config!.from,
      to: options.to,
      subject: options.subject,
      html: options.html,
      text: options.html.replace(/<[^>]+>/g, ''), // Plain text fallback
      headers: {
        'X-Mailer': 'DCP-Notification-System'
      }
    });

    const latencyMs = Date.now() - startTime;
    logger.info('Email đã được gửi thành công.', {
      to: options.to,
      subject: options.subject,
      messageId: result.messageId,
      latencyMs
    });

    return {
      success: true,
      channel: 'EMAIL',
      providerMessageId: result.messageId,
      latencyMs
    };
  } catch (error) {
    const latencyMs = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);

    logger.error('Email send thất bại.', {
      to: options.to,
      subject: options.subject,
      errorMessage,
      latencyMs
    });

    // Kiểm tra xem lỗi có retryable không
    // Gmail: rate limit, temporary failures là retryable
    const retryable = isRetryableError(error);

    return {
      success: false,
      channel: 'EMAIL',
      errorMessage,
      retryable
    };
  }
}

/**
 * Kiểm tra xem lỗi email có nên retry hay không.
 * Một số lỗi như invalid recipient, authentication failure thì không retry.
 */
function isRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    if (message.includes('invalid recipient')) return false;
    if (message.includes('authentication failed')) return false;
    if (message.includes('credentials')) return false;
    if (message.includes('eai_ewronguser')) return false;
  }
  return true;
}

/**
 * Gửi email một lần (không retry nội bộ).
 * Retry được xử lý bởi Bull queue trong notification worker.
 * Spec: retry 3 lần với 1-minute interval do Bull quản lý (non-blocking).
 *
 * @param options Các tham số gửi email
 * @returns DeliveryResult
 */
export async function sendEmailWithRetry(options: {
  to: string;
  subject: string;
  html: string;
}): Promise<DeliveryResult> {
  // Một lần gửi duy nhất — Bull queue xử lý retry nếu cần (không block worker)
  const result = await sendEmailOnce(options);

  if (!result.success && result.retryable) {
    logger.info('Email gửi thất bại nhưng retryable — Bull queue sẽ retry.', {
      to: options.to,
      errorMessage: result.errorMessage
    });
  }

  return result;
}

/**
 * Gửi email notification qua template.
 * Đây là entry point chính cho EMAIL channel từ notificationDispatcher.
 *
 * @param options Các tham số gửi email notification
 * @returns DeliveryResult
 */
export async function sendEmail(options: {
  to: string;
  templateName: string;
  subject: string;
  templateContext: Record<string, unknown>;
  unsubscribeToken?: string;
}): Promise<DeliveryResult> {
  try {
    // Resolve unsubscribe base URL: production BẮT BUỘC có FRONTEND_URL env var
    // (helper này throw nếu thiếu trong production — không fallback về localhost).
    const unsubscribeBaseUrl = getResolvedUnsubscribeBaseUrl();
    const unsubscribeUrl = options.unsubscribeToken
      ? `${unsubscribeBaseUrl}?token=${options.unsubscribeToken}`
      : `${unsubscribeBaseUrl}`;

    const html = renderTemplate(options.templateName, {
      ...options.templateContext,
      unsubscribeUrl,
      year: new Date().getFullYear()
    });

    return await sendEmailWithRetry({
      to: options.to,
      subject: options.subject,
      html
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('Email service error (template render hoặc send).', {
      to: options.to,
      templateName: options.templateName,
      errorMessage
    });

    return {
      success: false,
      channel: 'EMAIL',
      errorMessage,
      retryable: false // Template error không retry được
    };
  }
}

/**
 * Gửi email dựa trên context notification đã được resolve.
 * Dùng bởi notificationDispatcher.
 *
 * @param dispatchContext Thông tin user context cho dispatch
 * @param notificationData Dữ liệu notification cần gửi
 * @returns DeliveryResult
 */
export async function sendNotificationEmail(
  dispatchContext: DispatchContext,
  notificationData: {
    notificationId: string;
    title: string;
    content: string;
    notificationType: string;
    metadata?: Record<string, unknown>;
  }
): Promise<DeliveryResult> {
  if (!dispatchContext.userEmail) {
    return {
      success: false,
      channel: 'EMAIL',
      errorMessage: 'User không có email — skip EMAIL channel',
      retryable: false
    };
  }

  // Map notification type → template name (shared map từ constants)
  const templateName = NOTIFICATION_EMAIL_TEMPLATE_MAP[notificationData.notificationType];
  if (!templateName) {
    return {
      success: false,
      channel: 'EMAIL',
      errorMessage: `Không có email template cho notification type: ${notificationData.notificationType}`,
      retryable: false
    };
  }

  // Build subject line
  const subjectPrefix = '[DCP] ';
  const subject = `${subjectPrefix}${notificationData.title}`;

  // Build template context
  const templateContext: Record<string, unknown> = {
    title: notificationData.title,
    content: notificationData.content,
    notificationId: notificationData.notificationId,
    notificationType: notificationData.notificationType,
    metadata: notificationData.metadata ?? {},
    donationAmountVnd: dispatchContext.donationAmountVnd
  };

  return sendEmail({
    to: dispatchContext.userEmail,
    templateName,
    subject,
    templateContext,
    unsubscribeToken: dispatchContext.unsubscribeToken
  });
}

/**
 * Kiểm tra xem email service có sẵn sàng để gửi hay không.
 * Dùng cho health check.
 */
export function isEmailServiceReady(): boolean {
  return getTransporter() !== null;
}
