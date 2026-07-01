import { Router } from 'express';
import {
  getNotificationsController,
  markNotificationAsReadController,
  markAllNotificationsAsReadController,
  streamNotificationsController,
  unsubscribeController,
  getNotificationPreferencesController,
  updateNotificationPreferencesController
} from '../controllers/notificationController';
import { createAuthenticationMiddleware } from '../middleware/authenticationMiddleware';

/**
 * Hàm tạo routes thông báo cho E3 - Notification API Endpoints.
 *
 * Spec E3 yêu cầu 4 endpoints chính:
 * 1. GET    /api/notifications                        - paginated list (max 20/page, sorted createdAt DESC)
 * 2. PATCH  /api/notifications/:id/read              - mark 1 notification as read
 * 3. PATCH  /api/notifications/read-all             - mark all as read
 * 4. GET    /api/notifications/preferences           - get user preferences
 * 5. PUT    /api/notifications/preferences           - update user preferences
 *
 * Các endpoints bổ sung:
 * - GET /unsubscribe          - unsubscribe via token (no auth)
 * - GET /stream               - SSE realtime stream
 */
export function createNotificationRoutes(): Router {
  const router = Router();
  const authenticationMiddleware = createAuthenticationMiddleware();

  // Không auth — token đã đủ identity (entropy 256-bit)
  router.get('/unsubscribe', unsubscribeController);

  // Authenticated endpoints theo spec E3
  router.get('/', authenticationMiddleware, getNotificationsController);
  router.patch('/read-all', authenticationMiddleware, markAllNotificationsAsReadController);
  router.patch('/:id/read', authenticationMiddleware, markNotificationAsReadController);
  router.get('/preferences', authenticationMiddleware, getNotificationPreferencesController);
  router.put('/preferences', authenticationMiddleware, updateNotificationPreferencesController);

  // SSE realtime stream (authentication required)
  router.get('/stream', authenticationMiddleware, streamNotificationsController);

  return router;
}
