import compression from 'compression';
import cors from 'cors';
import express, { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { createAuthRoutes } from './routes/authRoutes';
import { createHealthRoutes } from './routes/healthRoutes';
import { createDepositRoutes } from './routes/depositRoutes';
import { createProjectRoutes } from './routes/projectRoutes';
import { createDonationRoutes } from './routes/donationRoutes';
import { createRankingRoutes } from './routes/rankingRoutes';
import { createSybilRoutes } from './routes/sybilRoutes';
import { createDisbursementRoutes } from './routes/disbursementRoutes';
import { createAdminDashboardRoutes } from './routes/adminDashboardRoutes';
import { createNotificationRoutes } from './routes/notificationRoutes';
import { createGuestRoutes } from './routes/guestRoutes';
import { createPayosWebhookRoutes } from './routes/webhooks/payos.webhook';
import { createTransparencyRoutes } from './routes/transparencyRoutes';
import { validateGuestJwtConfig } from './config/guestJsonWebToken';
import { applySeoAndCacheHeaders } from './middleware/seoCacheMiddleware';
import { API_GUEST_PREFIX } from './config/apiPrefixes';

const application = express();

// Fail-fast: kiểm tra GUEST_JWT_SECRET ngay khi app khởi động.
// Nếu thiếu hoặc quá ngắn → crash ngay lập tức thay vì đợi request đầu tiên.
// Giúp dev phát hiện thiếu .env sớm nhất có thể.
validateGuestJwtConfig();

/** Hàm cấu hình middleware chính cho ứng dụng. Mục đích: áp dụng bảo mật, tối ưu hiệu năng và parse request body cho toàn hệ thống. */
function configureMiddlewares(): void {
  const allowedOriginsEnv = process.env.CORS_ALLOWED_ORIGINS || 'http://localhost:3000';
  const allowedOriginList = allowedOriginsEnv.split(',').map(origin => origin.trim());
  const requestBodyLimit = getRequestBodyLimit();

  application.disable('x-powered-by');
  application.set('trust proxy', 1);

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
  application.use('/api/deposit', createDepositRoutes());
  application.use('/projects', createProjectRoutes());
  application.use('/donations', createDonationRoutes());
  application.use('/rankings', createRankingRoutes());
  application.use('/api/sybil', createSybilRoutes());
  application.use('/api/disbursement', createDisbursementRoutes());
  application.use('/api/admin/dashboard', createAdminDashboardRoutes());
  application.use('/api/notifications', createNotificationRoutes());
  application.use('/api/webhooks/payos', createPayosWebhookRoutes());
  application.use('/api/transparency', createTransparencyRoutes());
  application.use(API_GUEST_PREFIX, createGuestRoutes());
}

configureMiddlewares();
registerRoutes();

export default application;
