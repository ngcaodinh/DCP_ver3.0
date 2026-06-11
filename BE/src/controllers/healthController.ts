import { Request, Response } from 'express';
import {
  getFullHealthStatus,
  getReadinessStatus,
  getLivenessStatus,
  HealthStatus,
  ReadinessStatus,
  LivenessStatus
} from '../services/health-check.service';

/**
 * Hàm xử lý endpoint /health — comprehensive health check.
 * Mục đích: kiểm tra toàn bộ dependencies (MongoDB, Redis, PayOS) và trả thông tin chi tiết.
 * Trả HTTP 200 khi MongoDB up, HTTP 503 khi MongoDB down.
 */
export async function handleHealthCheck(request: Request, response: Response): Promise<void> {
  const healthStatus: HealthStatus = await getFullHealthStatus();

  const httpStatus = healthStatus.status === 'unhealthy' ? 503 : 200;
  response.status(httpStatus).json(healthStatus);
}

/**
 * Hàm xử lý endpoint /ready — k8s readiness probe.
 * Mục đích: readiness probe chỉ trả 200 khi tất cả DB + queue sẵn sàng nhận traffic.
 * Chỉ require MongoDB (bắt buộc); Redis và PayOS degraded acceptable.
 */
export async function handleReadinessCheck(request: Request, response: Response): Promise<void> {
  const readinessStatus: ReadinessStatus = await getReadinessStatus();

  const httpStatus = readinessStatus.status === 'ready' ? 200 : 503;
  response.status(httpStatus).json(readinessStatus);
}

/**
 * Hàm xử lý endpoint /live — k8s liveness probe.
 * Mục đích: liveness probe chỉ kiểm tra process đang chạy, không cần dependencies.
 * Luôn trả HTTP 200 nếu process còn alive.
 */
export function handleLivenessCheck(request: Request, response: Response): void {
  const livenessStatus: LivenessStatus = getLivenessStatus();

  response.status(200).json(livenessStatus);
}
