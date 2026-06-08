import { Router } from 'express';
import { getHealthStatus } from '../controllers/healthController';

/**
 * Hàm khởi tạo route cho module health.
 * Mục đích: cung cấp endpoint kiểm tra nhanh trạng thái hệ thống.
 */
export function createHealthRoutes(): Router {
  const router = Router();

  router.get('/', getHealthStatus);

  return router;
}

