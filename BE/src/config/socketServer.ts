import { Server as SocketIOServer } from 'socket.io';
import type { Server as HttpServer } from 'http';
import jwt from 'jsonwebtoken';
import { getJsonWebTokenSecret, getJsonWebTokenConfig } from './jsonWebToken';
import { getLogger } from './logger';
import { webhookEvents } from '../events/webhookEvents';
import { oracleEvents } from '../events/oracleEvents';
import type { OverrideRequestedEventPayload, OverrideExecutedEventPayload } from '../events/oracleEvents';
import { findDisbursementsInManualReview } from '../models/disbursementModel';

const logger = getLogger();

type JwtClaims = { userId: string; role: string };

let io: SocketIOServer | null = null;
// Theo dõi các requestId đã biết để phát hiện item mới
let knownManualReviewIds = new Set<string>();
let pollingIntervalId: ReturnType<typeof setInterval> | null = null;

// Lưu reference listener để có thể removeListener khi hot-reload tránh tích lũy
let _overrideRequestedListener: ((p: OverrideRequestedEventPayload) => void) | null = null;
let _overrideExecutedListener: ((p: OverrideExecutedEventPayload) => void) | null = null;

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
      // Cho phép cả admin và regulatory kết nối — cả hai đều là commissioner có thể vote override
      if (payload.role !== 'admin' && payload.role !== 'regulatory') return next(new Error('FORBIDDEN'));
      socket.data.userId = payload.userId;
      socket.data.role = payload.role;
      next();
    } catch {
      next(new Error('UNAUTHORIZED'));
    }
  });

  io.on('connection', (socket) => {
    const role = socket.data.role as string;
    // Admin tham gia cả 'admin' room (nhận transfer alerts) và 'commissioners' (nhận override alerts)
    // Regulatory chỉ tham gia 'commissioners' — không cần transfer alerts
    if (role === 'admin') void socket.join('admin');
    void socket.join('commissioners');
    logger.info('User connected via Socket.io.', {
      userId: socket.data.userId as string,
      context: { role }
    });
    socket.on('disconnect', (reason) => {
      logger.info('User disconnected from Socket.io.', {
        context: { reason, role }
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

  // Bridge 2b: oracleEvents → socket (override vote notifications cho commissioners)
  // Xoá listener cũ trước khi đăng ký mới — tránh tích lũy khi initSocketServer bị gọi lại (hot-reload)
  if (_overrideRequestedListener) oracleEvents.removeListener('override.requested', _overrideRequestedListener);
  if (_overrideExecutedListener) oracleEvents.removeListener('override.executed', _overrideExecutedListener);

  _overrideRequestedListener = (payload: OverrideRequestedEventPayload) => {
    io?.to('commissioners').emit('override:new', {
      overrideRequestId: payload.overrideRequestId,
      projectId: payload.projectId,
      reason: payload.reason,
      timestamp: new Date().toISOString()
    });
  };

  _overrideExecutedListener = (payload: OverrideExecutedEventPayload) => {
    io?.to('commissioners').emit('override:resolved', {
      overrideRequestId: payload.overrideRequestId,
      status: payload.status,  // APPROVED hoặc REJECTED — không hardcode
      timestamp: new Date().toISOString()
    });
  };

  oracleEvents.on('override.requested', _overrideRequestedListener);
  oracleEvents.on('override.executed', _overrideExecutedListener);

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
  if (_overrideRequestedListener) {
    oracleEvents.removeListener('override.requested', _overrideRequestedListener);
    _overrideRequestedListener = null;
  }
  if (_overrideExecutedListener) {
    oracleEvents.removeListener('override.executed', _overrideExecutedListener);
    _overrideExecutedListener = null;
  }
  io?.close();
  io = null;
  knownManualReviewIds.clear();
}

/**
 * Polling bridge phát hiện disbursement mới vào MANUAL_REVIEW qua worker path.
 * Worker set MANUAL_REVIEW không emit event → polling là cách duy nhất không sửa code worker.
 * Seed knownManualReviewIds lần đầu để tránh flood notification khi server restart.
 */
function startManualReviewPollingBridge(): void {
  // Seed ngay lập tức để các item đã tồn tại trước khi khởi động không bị emit lại
  void (async () => {
    try {
      const existing = await findDisbursementsInManualReview();
      knownManualReviewIds = new Set(existing.map(d => d.requestId));
    } catch {
      // Không block startup nếu DB chưa sẵn sàng — lần poll tiếp theo sẽ seed lại
    }
  })();

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
