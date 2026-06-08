import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/authenticationMiddleware';
import { getUserNotifications, markAllUserNotificationsAsRead } from '../services/notificationService';
import { sendErrorFromUnknown, sendErrorResponse, sendSuccessResponse } from '../utils/apiResponse';
import { getLogger } from '../config/logger';

const logger = getLogger();

/** Hàm lấy userId đã xác thực. Mục đích: chặn request thiếu thông tin đăng nhập trước khi truy vấn thông báo. */
function getAuthenticatedUserId(request: AuthenticatedRequest, response: Response): string | null {
  const authenticatedUserId = request.authenticatedUser?.userId;
  if (!authenticatedUserId) {
    sendErrorResponse(response, 401, 'Thiếu thông tin xác thực người dùng.', 'UNAUTHENTICATED');
    return null;
  }

  return authenticatedUserId;
}

/** Hàm controller lấy thông báo. Mục đích: trả danh sách thông báo thật và số chưa đọc cho frontend. */
export async function getNotificationsController(request: AuthenticatedRequest, response: Response): Promise<void> {
  const authenticatedUserId = getAuthenticatedUserId(request, response);
  if (!authenticatedUserId) {
    return;
  }

  try {
    const notificationResult = await getUserNotifications(authenticatedUserId);
    sendSuccessResponse(response, 200, 'Lấy danh sách thông báo thành công.', notificationResult);
  } catch (error: unknown) {
    sendErrorFromUnknown(response, error, 'Không thể lấy danh sách thông báo.');
  }
}

/** Hàm controller đánh dấu đã đọc. Mục đích: cập nhật toàn bộ thông báo chưa đọc của user thành đã đọc. */
export async function markAllNotificationsAsReadController(request: AuthenticatedRequest, response: Response): Promise<void> {
  const authenticatedUserId = getAuthenticatedUserId(request, response);
  if (!authenticatedUserId) {
    return;
  }

  try {
    const notificationResult = await markAllUserNotificationsAsRead(authenticatedUserId);
    sendSuccessResponse(response, 200, 'Đã đánh dấu toàn bộ thông báo là đã đọc.', notificationResult);
  } catch (error: unknown) {
    sendErrorFromUnknown(response, error, 'Không thể đánh dấu thông báo đã đọc.');
  }
}

/** Hàm controller stream thông báo realtime. Mục đích: đẩy snapshot mới cho frontend qua Server-Sent Events. */
export async function streamNotificationsController(request: AuthenticatedRequest, response: Response): Promise<void> {
  const authenticatedUserId = getAuthenticatedUserId(request, response);
  if (!authenticatedUserId) {
    return;
  }

  response.setHeader('Content-Type', 'text/event-stream');
  response.setHeader('Cache-Control', 'no-cache, no-transform');
  response.setHeader('Connection', 'keep-alive');
  response.setHeader('X-Accel-Buffering', 'no');
  response.flushHeaders?.();

  /** Hàm gửi snapshot thông báo. Mục đích: đồng bộ realtime bằng dữ liệu MongoDB mới nhất. */
  const sendNotificationSnapshot = async (): Promise<void> => {
    try {
      const notificationResult = await getUserNotifications(authenticatedUserId);
      response.write(`event: notifications\n`);
      response.write(`data: ${JSON.stringify(notificationResult)}\n\n`);
    } catch (error) {
      logger.warn(`Không thể gửi snapshot thông báo SSE. userId=${authenticatedUserId} error=${(error as Error).message}`);
      response.write(`event: heartbeat\n`);
      response.write(`data: {}\n\n`);
    }
  };

  await sendNotificationSnapshot();
  const notificationInterval = setInterval(() => {
    void sendNotificationSnapshot();
  }, 5000);

  request.on('close', () => {
    clearInterval(notificationInterval);
    response.end();
  });
}
