import { Router } from 'express';
import {
  getNotificationsController,
  markAllNotificationsAsReadController,
  streamNotificationsController
} from '../controllers/notificationController';
import { createAuthenticationMiddleware } from '../middleware/authenticationMiddleware';

/** Hàm tạo routes thông báo. Mục đích: gom các endpoint đọc, realtime và đánh dấu đã đọc. */
export function createNotificationRoutes(): Router {
  const router = Router();
  const authenticationMiddleware = createAuthenticationMiddleware();

  router.get('/', authenticationMiddleware, getNotificationsController);
  router.patch('/read-all', authenticationMiddleware, markAllNotificationsAsReadController);
  router.get('/stream', authenticationMiddleware, streamNotificationsController);

  return router;
}

