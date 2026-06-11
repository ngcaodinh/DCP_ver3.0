import { Router } from 'express';
import {
  handleHealthCheck,
  handleReadinessCheck,
  handleLivenessCheck
} from '../controllers/healthController';

/**
 * Hàm khởi tạo route cho module health.
 * Mục đích: cung cấp 3 endpoints cho k8s probes và monitoring:
 * - GET /health  : comprehensive health check (MongoDB, Redis, PayOS)
 * - GET /ready   : k8s readiness probe
 * - GET /live    : k8s liveness probe
 */
export function createHealthRoutes(): Router {
  const router = Router();

  router.get('/health', handleHealthCheck);
  router.get('/ready', handleReadinessCheck);
  router.get('/live', handleLivenessCheck);

  return router;
}
