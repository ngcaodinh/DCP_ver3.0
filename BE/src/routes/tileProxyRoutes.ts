import { Router } from 'express';
import { proxyOsmTile } from '../controllers/tileProxyController';

/**
 * Tạo router cho tile proxy endpoints.
 * [A-NEW3 fix] Proxy OSM tiles qua backend để tránh lộ GPS coordinates ra third-party.
 */
export function createTileProxyRoutes(): Router {
  const router = Router();

  // GET /api/tiles/:z/:x/:y.png - Proxy OSM tile request
  router.get('/:z/:x/:y.png', proxyOsmTile);

  return router;
}
