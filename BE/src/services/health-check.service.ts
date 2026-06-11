import mongoose from 'mongoose';
import { getRedisClientIfReady } from '../config/redis';
import { getLogger } from '../config/logger';

const logger = getLogger();

const HEALTH_CHECK_TIMEOUT_MS = 3000;

type DependencyStatus = {
  status: 'up' | 'down' | 'degraded';
  responseTimeMs: number | null;
  errorMessage?: string;
};

export type HealthStatus = {
  status: 'ok' | 'degraded' | 'unhealthy';
  serviceName: string;
  timestamp: string;
  uptimeSeconds: number;
  dependencies: {
    mongodb: DependencyStatus;
    redis: DependencyStatus;
    payos: DependencyStatus;
  };
};

export type ReadinessStatus = {
  status: 'ready' | 'not_ready';
  serviceName: string;
  timestamp: string;
  checks: {
    mongodb: DependencyStatus;
    redis: DependencyStatus;
    payos: DependencyStatus;
  };
};

export type LivenessStatus = {
  status: 'alive';
  serviceName: string;
  timestamp: string;
  uptimeSeconds: number;
};

const processStartTimeMs = Date.now();

/**
 * Hàm kiểm tra kết nối MongoDB và đo response time.
 * Mục đích: xác định trạng thái MongoDB sẵn sàng phục vụ request.
 */
async function checkMongoDb(): Promise<DependencyStatus> {
  const startTimeMs = Date.now();
  try {
    const mongoConnectionState = mongoose.connection.readyState;
    if (mongoConnectionState !== 1) {
      return {
        status: 'down',
        responseTimeMs: Date.now() - startTimeMs,
        errorMessage: `MongoDB readyState = ${mongoConnectionState} (1=connected)`
      };
    }

    await Promise.race([
      mongoose.connection.db!.admin().ping(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Ping timeout')), HEALTH_CHECK_TIMEOUT_MS)
      )
    ]);

    return {
      status: 'up',
      responseTimeMs: Date.now() - startTimeMs
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.warn('MongoDB health check failed.', { errorMessage });
    return {
      status: 'down',
      responseTimeMs: Date.now() - startTimeMs,
      errorMessage
    };
  }
}

/**
 * Hàm kiểm tra kết nối Redis và đo response time.
 * Mục đích: xác định trạng thái Redis sẵn sàng phục vụ caching/queue.
 * Redis không bắt buộc → degraded thay vì down khi không kết nối được.
 */
async function checkRedis(): Promise<DependencyStatus> {
  const startTimeMs = Date.now();
  try {
    const redisClient = getRedisClientIfReady();
    if (!redisClient) {
      return {
        status: 'degraded',
        responseTimeMs: null,
        errorMessage: 'Redis client not connected (graceful degradation)'
      };
    }

    const pingPromise = redisClient.ping();
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Redis ping timeout')), HEALTH_CHECK_TIMEOUT_MS)
    );

    await Promise.race([pingPromise, timeoutPromise]);

    return {
      status: 'up',
      responseTimeMs: Date.now() - startTimeMs
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.warn('Redis health check failed.', { errorMessage });
    return {
      status: 'degraded',
      responseTimeMs: null,
      errorMessage
    };
  }
}

/**
 * Hàm kiểm tra kết nối PayOS API bằng cách ping endpoint health.
 * Mục đích: xác định PayOS API có sẵn sàng xử lý transfer hay không.
 * PayOS không bắt buộc → degraded khi không kiểm tra được.
 */
async function checkPayOs(): Promise<DependencyStatus> {
  const startTimeMs = Date.now();
  const payosApiUrl = process.env.PAYOS_API_HEALTH_URL || 'https://api-merchant.payos.vn/v1/health';

  try {
    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => abortController.abort(), HEALTH_CHECK_TIMEOUT_MS);

    try {
      const response = await fetch(payosApiUrl, {
        method: 'GET',
        signal: abortController.signal
      });

      if (response.ok || response.status === 404 || response.status === 401) {
        return {
          status: 'up',
          responseTimeMs: Date.now() - startTimeMs
        };
      }

      return {
        status: 'down',
        responseTimeMs: Date.now() - startTimeMs,
        errorMessage: `PayOS API returned HTTP ${response.status}`
      };
    } finally {
      clearTimeout(timeoutHandle);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const isAbortError = error instanceof DOMException && error.name === 'AbortError';
    logger.warn('PayOS health check failed.', { errorMessage });
    return {
      status: 'degraded',
      responseTimeMs: null,
      errorMessage: isAbortError ? `PayOS API timeout (>${HEALTH_CHECK_TIMEOUT_MS}ms)` : errorMessage
    };
  }
}

/**
 * Hàm lấy trạng thái health tổng hợp.
 * Mục đích: endpoint /health check toàn bộ dependencies và trả thông tin chi tiết.
 * Trả 200 khi MongoDB up, 503 khi MongoDB down (HTTP 200 body vẫn chứa status).
 */
export async function getFullHealthStatus(): Promise<HealthStatus> {
  const [mongoStatus, redisStatus, payosStatus] = await Promise.all([
    checkMongoDb(),
    checkRedis(),
    checkPayOs()
  ]);

  const uptimeSeconds = Math.floor((Date.now() - processStartTimeMs) / 1000);

  let overallStatus: HealthStatus['status'] = 'ok';
  if (mongoStatus.status === 'down') {
    overallStatus = 'unhealthy';
  } else if (mongoStatus.status === 'up' && (redisStatus.status === 'degraded' || payosStatus.status === 'degraded')) {
    overallStatus = 'degraded';
  }

  return {
    status: overallStatus,
    serviceName: 'dcp-backend',
    timestamp: new Date().toISOString(),
    uptimeSeconds,
    dependencies: {
      mongodb: mongoStatus,
      redis: redisStatus,
      payos: payosStatus
    }
  };
}

/**
 * Hàm lấy trạng thái readiness — tất cả dependencies phải sẵn sàng.
 * Mục đích: k8s readiness probe chỉ return 200 khi service thực sự sẵn sàng nhận traffic.
 * Chỉ require MongoDB (bắt buộc); Redis và PayOS là degraded acceptable.
 */
export async function getReadinessStatus(): Promise<ReadinessStatus> {
  const [mongoStatus, redisStatus, payosStatus] = await Promise.all([
    checkMongoDb(),
    checkRedis(),
    checkPayOs()
  ]);

  const isReady = mongoStatus.status === 'up';

  return {
    status: isReady ? 'ready' : 'not_ready',
    serviceName: 'dcp-backend',
    timestamp: new Date().toISOString(),
    checks: {
      mongodb: mongoStatus,
      redis: redisStatus,
      payos: payosStatus
    }
  };
}

/**
 * Hàm lấy trạng thái liveness — process đang chạy.
 * Mục đích: k8s liveness probe chỉ cần kiểm tra process alive, không cần dependencies.
 * Luôn trả 200 nếu process đang chạy.
 */
export function getLivenessStatus(): LivenessStatus {
  const uptimeSeconds = Math.floor((Date.now() - processStartTimeMs) / 1000);

  return {
    status: 'alive',
    serviceName: 'dcp-backend',
    timestamp: new Date().toISOString(),
    uptimeSeconds
  };
}
