import { Server as SocketIOServer } from 'socket.io';
import type { Server as HttpServer } from 'http';
import jwt from 'jsonwebtoken';
import { getJsonWebTokenSecret, getJsonWebTokenConfig } from './jsonWebToken';
import { getLogger } from './logger';
import { webhookEvents } from '../events/webhookEvents';
import { findDisbursementsInManualReview } from '../models/disbursementModel';

const logger = getLogger();

type JwtClaims = { userId: string; role: string };

let io: SocketIOServer | null = null;
// Theo dõi các requestId đã biết để phát hiện item mới
let knownManualReviewIds = new Set<string>();
let pollingIntervalId: ReturnType<typeof setInterval> | null = null;

/**
 * Khởi tạo Socket.io server gắn vào HTTP server.
 * Mục đích: cung cấp kênh real-time cho admin nhận thông báo MANUAL_REVIEW.
 * Pattern bridge: lắng nghe webhookEvents + polling 15s để bắt cả 2 trigger (webhook + worker).
 */
export function initSocketServer(httpServer: HttpServer): SocketIOServer {
  io = new SocketIOServer(httpServer, {
    cors: {
      origin: process.env.CORS_ALLOWED_ORIGINS?.split(',').map(o => o.trim()) ?? ['http://localhost:3000'],
      credentials: true
    },
    path: '/socket.io'
  });

  // Auth middleware: chỉ admin mới được kết nối
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
    if (!token) return next(new Error('UNAUTHORIZED'));
    try {
      const cfg = getJsonWebTokenConfig();
      const secret = getJsonWebTokenSecret();
      const payload = jwt.verify(token, secret, {
        issuer: cfg.issuer,
        audience: cfg.audience
      }) as JwtClaims;
      if (payload.role !== 'admin') return next(new Error('FORBIDDEN'));
      socket.data.userId = payload.userId;
      socket.data.role = payload.role;
      next();
    } catch {
      next(new Error('UNAUTHORIZED'));
    }
  });

  io.on('connection', (socket) => {
    void socket.join('admin');
    logger.info('Admin connected via Socket.io.', {
      userId: socket.data.userId as string
    });
    socket.on('disconnect', (reason) => {
      logger.info('Admin disconnected from Socket.io.', {
        reason
      });
    });
  });

  // Bridge 1: webhookEvents → socket (near-real-time cho trường hợp webhook fail)
  webhookEvents.on('DISBURSEMENT_TRANSFER_FAILED', (payload) => {
    io?.to('admin').emit('transfer:manual-review-required', {
      requestId: (payload as { requestId: string }).requestId,
      projectId: (payload as { projectId: string }).projectId,
      amount: (payload as { amount: number }).amount,
      timestamp: new Date().toISOString()
    });
  });

  // Bridge 2: polling 15s — bắt trường hợp worker set MANUAL_REVIEW không qua webhook
  startManualReviewPollingBridge();

  logger.info('Socket.io server khởi tạo thành công.');
  return io;
}

/** Singleton getter — dùng trong service để emit event. */
export function getSocketServer(): SocketIOServer | null {
  return io;
}

/** Dọn dẹp khi server shutdown — tránh memory leak. */
export function shutdownSocketServer(): void {
  if (pollingIntervalId) {
    clearInterval(pollingIntervalId);
    pollingIntervalId = null;
  }
  io?.close();
  io = null;
  knownManualReviewIds.clear();
}

/**
 * Polling bridge phát hiện disbursement mới vào MANUAL_REVIEW qua worker path.
 * Worker set MANUAL_REVIEW không emit event → polling là cách duy nhất không sửa code worker.
 */
function startManualReviewPollingBridge(): void {
  pollingIntervalId = setInterval(() => {
    void (async () => {
      try {
        const items = await findDisbursementsInManualReview();
        const currentIds = new Set(items.map(d => d.requestId));
        const newIds = [...currentIds].filter(id => !knownManualReviewIds.has(id));
        if (newIds.length > 0 && io) {
          for (const requestId of newIds) {
            const item = items.find(d => d.requestId === requestId);
            if (!item) continue;
            io.to('admin').emit('transfer:manual-review-required', {
              requestId: item.requestId,
              projectId: item.projectId,
              amount: item.amount,
              requestMode: item.requestMode,
              timestamp: new Date().toISOString()
            });
          }
          logger.info('Socket.io: phát hiện MANUAL_REVIEW item mới.', { context: { count: newIds.length } });
        }
        knownManualReviewIds = currentIds;
      } catch (err) {
        logger.warn('Socket.io polling bridge lỗi.', { errorMessage: String(err) });
      }
    })();
  }, 15_000);
}
