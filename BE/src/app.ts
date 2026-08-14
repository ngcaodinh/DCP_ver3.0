import compression from 'compression';
import cors from 'cors';
import express, { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { createAuthRoutes } from './routes/authRoutes';
import { createHealthRoutes } from './routes/healthRoutes';
import { createMetricsRoutes } from './routes/metrics.routes';
import { createDepositRoutes } from './routes/depositRoutes';
import { createProjectRoutes } from './routes/projectRoutes';
import { createDonationRoutes } from './routes/donationRoutes';
import { createRankingRoutes } from './routes/rankingRoutes';
import { createSybilRoutes } from './routes/sybilRoutes';
import { createDisbursementRoutes } from './routes/disbursementRoutes';
import { createAdminDashboardRoutes } from './routes/adminDashboardRoutes';
import { createManualReviewRoutes } from './routes/manualReviewRoutes';
import { createNotificationRoutes } from './routes/notificationRoutes';
import { createOracleRoutes } from './routes/oracleRoutes';
import { createSbtRoutes } from './routes/sbt.routes';
import { createGuestRoutes } from './routes/guestRoutes';
import { createPayosWebhookRoutes } from './routes/webhooks/payos.webhook';
import { createTransparencyRoutes } from './routes/transparencyRoutes';
import { createVerificationRoutes } from './routes/verification.routes';
import { createFeedbackRoutes } from './routes/feedback.routes';
import { createPublicFeedbackRoutes } from './routes/public-feedback.routes';
import { createTileProxyRoutes } from './routes/tileProxyRoutes';
import { createAuditLogRoutes } from './routes/audit-log.routes';
import { validateGuestJwtConfig } from './config/guestJsonWebToken';
import { applySeoAndCacheHeaders } from './middleware/seoCacheMiddleware';
import { API_GUEST_PREFIX } from './config/apiPrefixes';
import { getLogger } from './config/logger';
import { getCacheHmacKey } from './utils/cacheIntegrity';
import { metricsMiddleware } from './middleware/metrics.middleware';
import { requestContextMiddleware } from './middleware/requestContext.middleware';
import { validateMetricsAuthConfig } from './config/metricsAuthConfig';
import { getSentryConfigWarning } from './config/sentryConfig';
import { reportTerminalError } from './utils/sentryReporter';

const application = express();

// Fail-fast: kiểm tra GUEST_JWT_SECRET ngay khi app khởi động.
// Nếu thiếu hoặc quá ngắn → crash ngay lập tức thay vì đợi request đầu tiên.
// Giúp dev phát hiện thiếu .env sớm nhất có thể.
validateGuestJwtConfig();

/**
 * Kiểm tra cấu hình HMAC cache ngay khi process khởi động trong production.
 * Fail-fast giúp health check không báo xanh trong khi các endpoint transparency
 * chỉ có thể trả lỗi 500 khi bắt đầu đọc hoặc ghi cache.
 */
function validateCacheHmacConfig(): void {
  if (process.env.NODE_ENV !== 'production') return;

  try {
    getCacheHmacKey();
  } catch (error) {
    getLogger().error('[Bootstrap] Cache HMAC key chưa được cấu hình.', {
      errorMessage: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}

validateCacheHmacConfig();
validateMetricsAuthConfig();

// Sentry là tầng quan sát: thiếu DSN thì cảnh báo, không biến production thành outage.
const sentryConfigWarning = getSentryConfigWarning();
if (sentryConfigWarning) {
  getLogger().error(`[Bootstrap] ${sentryConfigWarning}`);
}

/** Hàm cấu hình middleware chính cho ứng dụng. Mục đích: áp dụng bảo mật, tối ưu hiệu năng và parse request body cho toàn hệ thống. */
function configureMiddlewares(): void {
  const allowedOriginsEnv = process.env.CORS_ALLOWED_ORIGINS || 'http://localhost:3000';
  const allowedOriginList = allowedOriginsEnv.split(',').map(origin => origin.trim());
  const requestBodyLimit = getRequestBodyLimit();

  application.disable('x-powered-by');
  application.set('trust proxy', 1);

  // Đăng ký đầu tiên để cả request bị CORS reject cũng có correlation ID.
  application.use(requestContextMiddleware);

  application.use(
    cors({
      origin: (incomingOrigin, callback) => {
        // Cho phép null origin: mobile apps (React Native), Electron, server-to-server.
        // Trade-off: file:// pages gửi Origin: null có thể exploit, nhưng các app này không có token nên risk thấp.
        // Ref: https://portswigger.net/web-security/cors/null-origin
        if (!incomingOrigin || allowedOriginList.includes(incomingOrigin)) {
          callback(null, true);
        } else {
          callback(new Error(`CORS: origin '${incomingOrigin}' not allowed`));
        }
      },
      credentials: true
    })
  );
  application.use(
    helmet({
      // CORP = false: không set header CORP → browser default restrictive (không cho phép cross-origin embedding).
      // Chấp nhận trade-off: FE proxy qua /api rewrite → cùng origin → không ảnh hưởng.
      crossOriginResourcePolicy: false,
      contentSecurityPolicy: false,  // API-only backend, không serve HTML
      noSniff: true,
      xFrameOptions: { action: 'deny' },
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
      strictTransportSecurity: { maxAge: 63072000, includeSubDomains: true, preload: true },
      xPermittedCrossDomainPolicies: { permittedPolicies: 'none' }
    })
  );
  application.use(compression());
  application.use(applyApiResponseTimeHeader);
  application.use(metricsMiddleware);
  application.use(applySeoAndCacheHeaders);

  // Logic này giữ giới hạn body thống nhất giữa local và production để tránh OOM trên VPS ít RAM.
  application.use(express.json({ limit: requestBodyLimit }));
  application.use(express.urlencoded({ extended: true, limit: requestBodyLimit }));
}

/** Hàm lấy giới hạn body request từ biến môi trường. Mục đích: tách cấu hình local và production mà không hardcode trong code. */
function getRequestBodyLimit(): string {
  return process.env.REQUEST_BODY_LIMIT || '5mb';
}

/** Hàm gắn header đo thời gian phản hồi. Mục đích: hỗ trợ theo dõi hiệu năng API trong production và qua reverse proxy. */
function applyApiResponseTimeHeader(request: Request, response: Response, next: NextFunction): void {
  const requestStartTime = process.hrtime.bigint();
  const originalWriteHead = response.writeHead.bind(response) as Response['writeHead'];

  response.writeHead = ((...argumentsList: unknown[]) => {
    const responseTimeInMilliseconds = Number(process.hrtime.bigint() - requestStartTime) / 1_000_000;
    response.setHeader('Server-Timing', `app;dur=${responseTimeInMilliseconds.toFixed(2)}`);
    response.setHeader('X-Response-Time', `${responseTimeInMilliseconds.toFixed(2)}ms`);
    return originalWriteHead(...(argumentsList as Parameters<Response['writeHead']>));
  }) as Response['writeHead'];

  next();
}

/** Hàm khai báo các tuyến chính của ứng dụng. Mục đích: tách riêng các module theo chuẩn MVC. */
function registerRoutes(): void {
  application.use('/auth', createAuthRoutes());
  application.use(createHealthRoutes()); // → /health, /ready, /live
  application.use(createMetricsRoutes());
  application.use('/api/deposit', createDepositRoutes());
  application.use('/projects', createProjectRoutes());
  application.use('/donations', createDonationRoutes());
  application.use('/rankings', createRankingRoutes());
  application.use('/api/sybil', createSybilRoutes());
  application.use('/api/disbursement', createDisbursementRoutes());
  application.use('/api/admin/dashboard', createAdminDashboardRoutes());
  application.use('/api/audit-logs', createAuditLogRoutes());
  application.use('/api/disbursements', createManualReviewRoutes());
  application.use('/api/oracle', createOracleRoutes());
  application.use('/api/sbt', createSbtRoutes());
  application.use('/api/notifications', createNotificationRoutes());
  application.use('/api/webhooks/payos', createPayosWebhookRoutes());
  application.use('/api/transparency', createTransparencyRoutes());
  application.use('/api/transparency', createVerificationRoutes());
  application.use('/api/feedback', createFeedbackRoutes());
  application.use('/api/feedback', createPublicFeedbackRoutes());
  application.use('/api/tiles', createTileProxyRoutes()); // [A-NEW3 fix] Tile proxy để tránh lộ GPS ra third-party
  application.use(API_GUEST_PREFIX, createGuestRoutes());
}

configureMiddlewares();
registerRoutes();

/**
 * Xử lý lỗi cuối chuỗi và phân loại lỗi terminal với lỗi payload hợp lệ.
 * Mục đích: giữ Winston-first cho 5xx và không capture lỗi 413 lên Sentry.
 */
function handleApplicationError(err: Error, _req: Request, res: Response, _next: NextFunction): void {
  void _next;
  const errorWithStatus = err as Error & { status?: number; type?: string };
  const isPayloadTooLarge = errorWithStatus.status === 413 || errorWithStatus.type === 'entity.too.large';
  const responseStatusCode = isPayloadTooLarge ? 413 : 500;

  if (isPayloadTooLarge) {
    // 413 là lỗi client hợp lệ: Winston có, Sentry không theo bảng E6.
    getLogger().error('Unhandled error in request', {
      errorMessage: err.message,
      errorStack: err.stack
    });
  } else {
    // Reporter đảm bảo Winston ghi trước rồi mới capture Sentry.
    reportTerminalError('Unhandled error in request', err, { errorSource: 'http-5xx' });
  }

  // Không leak stack trace ở production
  const isDevelopment = process.env.NODE_ENV === 'development';
  // Giữ mã lỗi 413 chuẩn để client và metrics phân biệt payload quá lớn với lỗi server nội bộ.
  res.status(responseStatusCode).json({
    success: false,
    message: isPayloadTooLarge
      ? 'Payload vượt quá giới hạn cho phép.'
      : 'Đã xảy ra lỗi nội bộ. Vui lòng thử lại sau.',
    errorCode: isPayloadTooLarge ? 'PAYLOAD_TOO_LARGE' : 'INTERNAL_ERROR',
    details: isDevelopment && err.stack ? [{ field: 'stack', message: err.stack }] : []
  });
}

// Đăng ký handler sau toàn bộ routes để Express chuyển mọi lỗi cuối chuỗi vào đây.
application.use(handleApplicationError);

export { handleApplicationError };

export default application;
