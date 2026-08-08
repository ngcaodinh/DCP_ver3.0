import { Server as SocketIOServer } from 'socket.io';
import type { Server as HttpServer } from 'http';
import jwt from 'jsonwebtoken';
import { getJsonWebTokenSecret, getJsonWebTokenConfig } from './jsonWebToken';
import { getLogger } from './logger';
import { oracleEvents } from '../events/oracleEvents';
import type { OverrideRequestedEventPayload, OverrideExecutedEventPayload } from '../events/oracleEvents';
import { findPendingManualReviewQueues } from '../models/manualReviewQueueModel';
import { findDisbursementsByRequestIds } from '../models/disbursementModel';
import { findUserById } from '../models/authModel';
import { getRedisClientIfReady } from './redis';

const logger = getLogger();

type JwtClaims = { userId: string; role: string; authVersion?: number };

const AUTH_VERSION_CACHE_KEY_PREFIX = 'auth_version:';
const AUTH_VERSION_CACHE_TTL_S = 10; // TTL ngắn để phát hiện revoke nhanh

/**
 * Lấy authVersion hiện tại của user từ Redis cache hoặc DB.
 * Trả về null nếu user không tồn tại.
 * [S-NEW2 fix]
 */
async function getCachedAuthVersion(userId: string): Promise<number | null> {
  const redis = getRedisClientIfReady();
  const cacheKey = `${AUTH_VERSION_CACHE_KEY_PREFIX}${userId}`;
  
  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) return parseInt(cached, 10);
      
      // Cache miss → query DB
      const user = await findUserById(userId);
      if (!user) return null;
      
      const authVersion = user.authVersion ?? 1;
      await redis.setEx(cacheKey, AUTH_VERSION_CACHE_TTL_S, String(authVersion));
      return authVersion;
    } catch {
      // Redis lỗi → fallback DB
    }
  }
  
  // Không có Redis hoặc Redis lỗi → query DB trực tiếp
  const user = await findUserById(userId);
  return user ? (user.authVersion ?? 1) : null;
}

/**
 * Ngắt tất cả socket connections của một user cụ thể.
 * Gọi khi role thay đổi hoặc quyền bị thu hồi.
 * [S-NEW2 fix]
 */
export function disconnectUserSockets(userId: string): void {
  if (!io) return;
  
  const userRoom = `user:${userId}`;
  const sockets = io.in(userRoom).fetchSockets();
  
  void sockets.then(socketList => {
    for (const socket of socketList) {
      socket.disconnect(true); // true = close transport connection ngay lập tức
    }
    logger.info('Đã ngắt socket connections của user.', { userId, count: socketList.length });
  });
}

let io: SocketIOServer | null = null;
// Theo dõi các queueId đã biết để polling recovery không emit trùng.
let knownManualReviewQueueIds = new Set<string>();
let pollingIntervalId: ReturnType<typeof setInterval> | null = null;

// Lưu reference listener để có thể removeListener khi hot-reload tránh tích lũy
let _overrideRequestedListener: ((p: OverrideRequestedEventPayload) => void) | null = null;
let _overrideExecutedListener: ((p: OverrideExecutedEventPayload) => void) | null = null;

/**
 * Khởi tạo Socket.io server gắn vào HTTP server.
 * Mục đích: cung cấp kênh real-time cho admin nhận thông báo MANUAL_REVIEW.
 * Pattern bridge: queue service emit sau persist, polling 15s chỉ dùng làm recovery fallback.
 */
export function initSocketServer(httpServer: HttpServer): SocketIOServer {
  io = new SocketIOServer(httpServer, {
    cors: {
      origin: process.env.CORS_ALLOWED_ORIGINS?.split(',').map(o => o.trim()) ?? ['http://localhost:3000'],
      credentials: true
    },
    path: '/socket.io'
  });

  // Auth middleware: validate JWT và check authVersion từ DB/Redis cache
  // [S-NEW2 fix] So sánh authVersion trong JWT với giá trị hiện tại trong DB để phát hiện token đã bị revoke
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
    if (!token) return next(new Error('UNAUTHORIZED'));
    
    try {
      const cfg = getJsonWebTokenConfig();
      const secret = getJsonWebTokenSecret();
      const payload = jwt.verify(token, secret, {
        issuer: cfg.issuer,
        audience: cfg.audience
      }) as JwtClaims;
      
      const userId = payload.userId;
      const tokenAuthVersion = payload.authVersion ?? 1; // JWT cũ không có authVersion → mặc định 1
      
      // Lấy authVersion hiện tại từ Redis cache (TTL 10s) hoặc DB
      const currentAuthVersion = await getCachedAuthVersion(userId);
      
      if (currentAuthVersion === null) {
        // User không tồn tại trong DB → từ chối
        return next(new Error('UNAUTHORIZED'));
      }
      
      if (tokenAuthVersion < currentAuthVersion) {
        // Token đã bị revoke (authVersion trong DB đã tăng lên) → từ chối
        logger.warn('Socket connection từ chối: JWT authVersion lỗi thời.', {
          userId,
          tokenAuthVersion,
          currentAuthVersion
        });
        return next(new Error('UNAUTHORIZED'));
      }
      
      socket.data.userId = userId;
      socket.data.role = payload.role;
      next();
    } catch (err) {
      logger.warn('Socket JWT verification thất bại.', { errorMessage: String(err) });
      next(new Error('UNAUTHORIZED'));
    }
  });

  io.on('connection', (socket) => {
    const userId = socket.data.userId as string;
    const role = socket.data.role as string;

    // Room isolation theo role:
    // - admin: join 'admin' (transfer alerts) + 'commissioners' (override alerts) + 'user:${userId}'
    // - regulatory: join 'commissioners' (override alerts) + 'user:${userId}'
    // - regular user (donor/organization): chỉ join 'user:${userId}' — KHÔNG nhận override/transfer events
    //
    // Đây là E3 extension: trước đó chỉ admin/regulatory được connect. Sau khi mở cho tất cả
    // authenticated users, phải giới hạn room access để tránh information disclosure
    // (regular user không được thấy override:new / override:resolved events).
    if (role === 'admin') {
      void socket.join('admin');
      void socket.join('commissioners');
    } else if (role === 'regulatory') {
      void socket.join('commissioners');
    }
    void socket.join(`user:${userId}`);
    logger.info('User connected via Socket.io.', {
      userId,
      context: { role }
    });
    socket.on('disconnect', (reason) => {
      logger.info('User disconnected from Socket.io.', {
        context: { reason, userId }
      });
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
  knownManualReviewQueueIds.clear();
}

/**
 * Polling bridge phát hiện queue pending bị miss event do restart/crash giữa các process.
 * Seed queueId lần đầu để tránh flood notification khi server restart.
 */
function startManualReviewPollingBridge(): void {
  // Seed ngay lập tức để các item đã tồn tại trước khi khởi động không bị emit lại
  void (async () => {
    try {
      const existing = await findPendingManualReviewQueues();
      knownManualReviewQueueIds = new Set(existing.map(item => item.queueId));
    } catch {
      // Không block startup nếu DB chưa sẵn sàng — lần poll tiếp theo sẽ seed lại
    }
  })();

  pollingIntervalId = setInterval(() => {
    void (async () => {
      try {
        const items = await findPendingManualReviewQueues();
        const currentQueueIds = new Set(items.map(item => item.queueId));
        const newQueueIds = [...currentQueueIds].filter(queueId => !knownManualReviewQueueIds.has(queueId));
        if (newQueueIds.length > 0 && io) {
          const newItems = items.filter(item => newQueueIds.includes(item.queueId));
          const disbursements = await findDisbursementsByRequestIds(
            newItems.map(item => item.disbursementRequestId)
          );
          const disbursementByRequestId = new Map(
            disbursements.map(disbursement => [disbursement.requestId, disbursement])
          );

          for (const queueId of newQueueIds) {
            const item = items.find(queueItem => queueItem.queueId === queueId);
            if (!item) continue;
            const disbursement = disbursementByRequestId.get(item.disbursementRequestId);
            if (!disbursement) continue;
            io.to('admin').emit('transfer:manual-review-required', {
              requestId: item.disbursementRequestId,
              queueId: item.queueId,
              projectId: item.projectId,
              amount: disbursement.amount,
              requestMode: disbursement.requestMode,
              timestamp: new Date().toISOString()
            });
          }
          logger.info('Socket.io: phát hiện MANUAL_REVIEW item mới.', { context: { count: newQueueIds.length } });
        }
        knownManualReviewQueueIds = currentQueueIds;
      } catch (err) {
        logger.warn('Socket.io polling bridge lỗi.', { errorMessage: String(err) });
      }
    })();
  }, 15_000);
}
