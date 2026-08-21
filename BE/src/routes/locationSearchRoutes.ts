import { Router } from 'express';
import { searchLocations } from '../controllers/locationSearchController';
import { createRateLimitMiddleware } from '../middleware/rateLimitMiddleware';

/** Tạo route tìm địa điểm có giới hạn theo IP để bảo vệ nhà cung cấp geocoding. */
export function createLocationSearchRoutes(): Router {
  const router = Router();
  const locationSearchRateLimit = createRateLimitMiddleware(20, 60 * 1000, {
    bucketName: 'location-search'
  });

  router.get('/', locationSearchRateLimit, searchLocations);
  return router;
}
