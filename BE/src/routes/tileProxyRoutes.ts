import { Router } from 'express';
import { proxyAdministrativeMapTile, proxyMapTile } from '../controllers/tileProxyController';
import { createRateLimitMiddleware } from '../middleware/rateLimitMiddleware';

/**
 * Tạo router cho tile proxy endpoints.
 * Browser không gọi Carto trực tiếp, nhưng provider vẫn nhận z/x/y từ backend.
 */
export function createTileProxyRoutes(): Router {
  const router = Router();
  const tileProxyRateLimit = createRateLimitMiddleware(120, 60 * 1000, {
    bucketName: 'tiles:proxy'
  });

  // Public cho Leaflet; giới hạn theo IP để bảo vệ quota và outbound capacity của Carto.
  router.get('/administrative/:z/:x/:y.png', tileProxyRateLimit, proxyAdministrativeMapTile);
  router.get('/:z/:x/:y.png', tileProxyRateLimit, proxyMapTile);

  return router;
}
