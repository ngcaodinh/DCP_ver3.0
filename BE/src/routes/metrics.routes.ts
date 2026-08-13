import { Router, Request, Response, NextFunction } from 'express';
import { getMetricsRegistry } from '../config/metricsRegistry';
import { createMetricsAuthMiddleware } from '../middleware/metricsAuthMiddleware';
import { createRateLimitMiddleware } from '../middleware/rateLimitMiddleware';

/** Trả payload metrics theo định dạng text exposition của Prometheus. */
async function handleMetricsRequest(_request: Request, response: Response, next: NextFunction): Promise<void> {
  try {
    const metricsRegistry = getMetricsRegistry();
    response.setHeader('Content-Type', metricsRegistry.contentType);
    response.end(await metricsRegistry.metrics());
  } catch (error) {
    next(error);
  }
}

/** Khởi tạo route root /metrics dành cho Prometheus scrape. */
export function createMetricsRoutes(): Router {
  const router = Router();
  const metricsRateLimitMiddleware = createRateLimitMiddleware(120, 60 * 1000, {
    bucketName: 'metrics:exposition'
  });

  // Rate limit chạy trước auth để cả request thiếu/sai token cũng không thể dùng endpoint làm điểm serialize registry không giới hạn.
  router.get('/metrics', metricsRateLimitMiddleware, createMetricsAuthMiddleware(), handleMetricsRequest);
  return router;
}
