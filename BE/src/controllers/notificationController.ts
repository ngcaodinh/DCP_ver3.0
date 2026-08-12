import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/authenticationMiddleware';
import {
  getUserNotifications,
  markAllUserNotificationsAsRead,
  markNotificationAsRead,
  getUserPreferences,
  updateUserPreferences,
  deleteUserNotification,
  getUnreadCount,
  processUnsubscribe
} from '../services/notificationService';
import { sendErrorFromUnknown, sendErrorResponse, sendSuccessResponse } from '../utils/apiResponse';
import { getLogger } from '../config/logger';
import { notificationEvents } from '../events/notificationEvents';
import { VISIBLE_NOTIFICATION_TYPES, NotificationValidationError } from '../services/constants/notification.constants';
import { NotificationModel, NOTIFICATION_PUBLIC_PROJECTION } from '../models/notificationModel';
import type { NotificationPreferencesMap } from '../models/notificationPreferenceModel';

const logger = getLogger();

/**
 * Giới hạn số lượng notification mỗi trang theo spec E3.
 * Spec yêu cầu max 20 items/page.
 */
const NOTIFICATION_PAGE_SIZE_MAX = 20;

/**
 * Hàm lấy userId đã xác thực. Mục đích: chặn request thiếu thông tin đăng nhập trước khi truy vấn thông báo.
 */
function getAuthenticatedUserId(request: AuthenticatedRequest, response: Response): string | null {
  const authenticatedUserId = request.authenticatedUser?.userId;
  if (!authenticatedUserId) {
    sendErrorResponse(response, 401, 'Thiếu thông tin xác thực người dùng.', 'UNAUTHENTICATED');
    return null;
  }
  return authenticatedUserId;
}

/**
 * Hàm controller lấy thông báo với pagination.
 * Spec E3: paginated list, max 20/page, sorted by createdAt DESC.
 * Query params: page (default 1), limit (default 10, max 20).
 */
export async function getNotificationsController(request: AuthenticatedRequest, response: Response): Promise<void> {
  const authenticatedUserId = getAuthenticatedUserId(request, response);
  if (!authenticatedUserId) {
    return;
  }

  try {
    const rawPage = request.query['page'];
    const rawLimit = request.query['limit'];
    const page = Math.max(1, parseInt(String(rawPage ?? '1'), 10) || 1);
    const limit = Math.min(
      Math.max(1, parseInt(String(rawLimit ?? String(NOTIFICATION_PAGE_SIZE_MAX)), 10) || NOTIFICATION_PAGE_SIZE_MAX),
      NOTIFICATION_PAGE_SIZE_MAX
    );
    const skip = (page - 1) * limit;

    const notificationResult = await getUserNotificationsPaginated(authenticatedUserId, skip, limit);
    sendSuccessResponse(response, 200, 'Lấy danh sách thông báo thành công.', notificationResult);
  } catch (error: unknown) {
    sendErrorFromUnknown(response, error, 'Không thể lấy danh sách thông báo.');
  }
}

/**
 * Hàm lấy thông báo phân trang.
 * Tách riêng để reuse trong SSE stream controller.
 */
async function getUserNotificationsPaginated(userId: string, skip: number, limit: number): Promise<{
  notifications: import('../models/notificationModel').Notification[];
  unreadCount: number;
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNextPage: boolean;
  };
}> {
  const query = {
    userId,
    notificationType: { $in: VISIBLE_NOTIFICATION_TYPES },
    $or: [{ channels: 'IN_APP' }, { channels: { $exists: false } }]
  };

  const [notifications, total, unreadCount] = await Promise.all([
    NotificationModel
      .find(query, NOTIFICATION_PUBLIC_PROJECTION)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean<import('../models/notificationModel').Notification[]>()
      .exec(),
    NotificationModel.countDocuments(query).exec(),
    NotificationModel.countDocuments({
      userId,
      notificationType: { $in: VISIBLE_NOTIFICATION_TYPES },
      $or: [{ channels: 'IN_APP' }, { channels: { $exists: false } }],
      isRead: false
    }).exec()
  ]);

  const totalPages = Math.ceil(total / limit);
  return {
    notifications,
    unreadCount,
    pagination: {
      page: skip / limit + 1,
      limit,
      total,
      totalPages,
      hasNextPage: skip + limit < total
    }
  };
}

/**
 * Controller đánh dấu 1 notification là đã đọc.
 * Spec E3: PATCH /api/notifications/:id/read → set isRead = true.
 * Emit notification:read event sau khi mark-read để update realtime UI (SSE).
 */
export async function markNotificationAsReadController(request: AuthenticatedRequest, response: Response): Promise<void> {
  const authenticatedUserId = getAuthenticatedUserId(request, response);
  if (!authenticatedUserId) {
    return;
  }

  const { id } = request.params;
  if (!id || typeof id !== 'string') {
    sendErrorResponse(response, 400, 'Notification ID không hợp lệ.', 'INVALID_NOTIFICATION_ID');
    return;
  }

  try {
    const notification = await markNotificationAsRead(id, authenticatedUserId);
    if (!notification) {
      sendErrorResponse(response, 404, 'Thông báo không tìm thấy hoặc đã được đánh dấu là đã đọc.', 'NOTIFICATION_NOT_FOUND');
      return;
    }

    // Emit event để SSE stream controller gửi snapshot cập nhật tới client
    emitNotificationReadEvent(authenticatedUserId);

    sendSuccessResponse(response, 200, 'Đã đánh dấu thông báo là đã đọc.', { notificationId: id });
  } catch (error: unknown) {
    sendErrorFromUnknown(response, error, 'Không thể đánh dấu thông báo đã đọc.');
  }
}

/**
 * Hàm controller đánh dấu đã đọc toàn bộ thông báo.
 * Spec E3: PATCH /api/notifications/read-all → set isRead = true cho tất cả.
 * Emit notification:read event sau khi mark-all để update realtime UI (SSE).
 */
export async function markAllNotificationsAsReadController(request: AuthenticatedRequest, response: Response): Promise<void> {
  const authenticatedUserId = getAuthenticatedUserId(request, response);
  if (!authenticatedUserId) {
    return;
  }

  try {
    const notificationResult = await markAllUserNotificationsAsRead(authenticatedUserId);

    // Emit event để SSE stream controller gửi snapshot cập nhật tới client
    emitNotificationReadEvent(authenticatedUserId);

    sendSuccessResponse(response, 200, 'Đã đánh dấu toàn bộ thông báo là đã đọc.', notificationResult);
  } catch (error: unknown) {
    sendErrorFromUnknown(response, error, 'Không thể đánh dấu thông báo đã đọc.');
  }
}

/**
 * Gửi event notification:read qua EventEmitter nội bộ để SSE stream controller xử lý.
 * Dùng user-scoped channel để tránh listener leak khi client reconnect nhanh.
 */
function emitNotificationReadEvent(userId: string): void {
  notificationEvents.emit(`notification:read:${userId}`, { userId });
}

/**
 * Controller xóa 1 notification của user.
 * Spec E3: DELETE /api/notifications/:id → xóa notification.
 * IDOR protection: chỉ cho phép user xóa notification thuộc về mình.
 */
export async function deleteNotificationController(request: AuthenticatedRequest, response: Response): Promise<void> {
  const authenticatedUserId = getAuthenticatedUserId(request, response);
  if (!authenticatedUserId) {
    return;
  }

  const { id } = request.params;
  if (!id || typeof id !== 'string') {
    sendErrorResponse(response, 400, 'Notification ID không hợp lệ.', 'INVALID_NOTIFICATION_ID');
    return;
  }

  try {
    const deleted = await deleteUserNotification(id, authenticatedUserId);
    if (!deleted) {
      sendErrorResponse(response, 404, 'Thông báo không tìm thấy hoặc không thuộc về bạn.', 'NOTIFICATION_NOT_FOUND');
      return;
    }

    emitNotificationReadEvent(authenticatedUserId);
    sendSuccessResponse(response, 200, 'Đã xóa thông báo.', { notificationId: id });
  } catch (error: unknown) {
    sendErrorFromUnknown(response, error, 'Không thể xóa thông báo.');
  }
}

/**
 * Controller lấy số notification chưa đọc.
 * Spec E3: GET /api/notifications/unread-count → badge count.
 * Nhanh, không cần pagination.
 */
export async function getUnreadCountController(request: AuthenticatedRequest, response: Response): Promise<void> {
  const authenticatedUserId = getAuthenticatedUserId(request, response);
  if (!authenticatedUserId) {
    return;
  }

  try {
    const unreadCount = await getUnreadCount(authenticatedUserId);
    sendSuccessResponse(response, 200, 'Lấy số thông báo chưa đọc thành công.', { unreadCount });
  } catch (error: unknown) {
    sendErrorFromUnknown(response, error, 'Không thể lấy số thông báo chưa đọc.');
  }
}

/**
 * Controller lấy notification preferences của user.
 * Spec E3: GET /api/notifications/preferences.
 */
export async function getNotificationPreferencesController(
  request: AuthenticatedRequest,
  response: Response
): Promise<void> {
  const authenticatedUserId = getAuthenticatedUserId(request, response);
  if (!authenticatedUserId) {
    return;
  }

  try {
    const prefs = await getUserPreferences(authenticatedUserId);
    sendSuccessResponse(response, 200, 'Lấy preferences thành công.', prefs);
  } catch (error: unknown) {
    sendErrorFromUnknown(response, error, 'Không thể lấy preferences.');
  }
}

/**
 * Controller cập nhật notification preferences của user.
 * Spec E3: PUT /api/notifications/preferences → validate payload + update.
 * Return 400 nếu preference không hợp lệ.
 */
export async function updateNotificationPreferencesController(
  request: AuthenticatedRequest,
  response: Response
): Promise<void> {
  const authenticatedUserId = getAuthenticatedUserId(request, response);
  if (!authenticatedUserId) {
    return;
  }

  try {
    const rawPayload: unknown = request.body;
    if (rawPayload === null || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
      sendErrorResponse(response, 400, 'Payload preferences phải là object.', 'VALIDATION_ERROR');
      return;
    }

    const payload = rawPayload as {
      globalEnabled?: boolean;
      preferences?: NotificationPreferencesMap;
      version?: number;
    };

    // Validate payload
    if (payload.globalEnabled !== undefined && typeof payload.globalEnabled !== 'boolean') {
      sendErrorResponse(response, 400, 'globalEnabled phải là boolean.', 'VALIDATION_ERROR');
      return;
    }

    if (
      payload.preferences !== undefined &&
      (payload.preferences === null || typeof payload.preferences !== 'object' || Array.isArray(payload.preferences))
    ) {
      sendErrorResponse(response, 400, 'preferences phải là object.', 'VALIDATION_ERROR');
      return;
    }

    if (payload.version !== undefined && (!Number.isInteger(payload.version) || payload.version < 0)) {
      sendErrorResponse(response, 400, 'version phải là số nguyên không âm.', 'VALIDATION_ERROR');
      return;
    }

    const updated = await updateUserPreferences(authenticatedUserId, payload);
    sendSuccessResponse(response, 200, 'Cập nhật preferences thành công.', updated);
  } catch (error: unknown) {
    if (error instanceof NotificationValidationError) {
      sendErrorResponse(response, error.code === 'CONFLICT' ? 409 : 400, error.message, error.code);
      return;
    }
    sendErrorFromUnknown(response, error, 'Không thể cập nhật preferences.');
  }
}

/**
 * Controller xử lý hủy đăng ký notification qua token từ email.
 * Endpoint không yêu cầu auth — token đã đủ identity (entropy 256-bit).
 */
export async function unsubscribeController(request: { query: { token?: string } }, response: Response): Promise<void> {
  const { token } = request.query;

  if (!token || typeof token !== 'string' || token.length !== 64) {
    sendErrorResponse(response, 400, 'Token không hợp lệ.', 'INVALID_TOKEN');
    return;
  }

  if (!/^[a-f0-9]{64}$/i.test(token)) {
    sendErrorResponse(response, 400, 'Token không hợp lệ.', 'INVALID_TOKEN');
    return;
  }

  try {
    const success = await processUnsubscribe(token);
    if (success) {
      sendSuccessResponse(response, 200, 'Đã hủy đăng ký nhận thông báo thành công.', { unsubscribed: true });
    } else {
      // Trả 404 cho token không hợp lệ/hết hạn — token là 256-bit nên không khả thi brute-force,
      // lợi ích UX cho user hợp lệ lớn hơn rủi ro status-code oracle. Rate limit ở route
      // đã mitigate phần lớn brute-force attacks.
      sendErrorResponse(response, 404, 'Token không tồn tại hoặc đã hết hạn.', 'TOKEN_NOT_FOUND');
    }
  } catch (error: unknown) {
    sendErrorFromUnknown(response, error, 'Không thể xử lý hủy đăng ký.');
  }
}

/**
 * Hàm controller stream thông báo realtime.
 * Mục đích: đẩy snapshot mới cho frontend qua Server-Sent Events.
 * Sync realtime: dùng EventEmitter để nhận notification:read events
 * và push snapshot cập nhật tới client ngay lập tức.
 *
 * Memory leak prevention: dùng user-scoped event channel ('notification:read:${userId}')
 * thay vì global channel. Mỗi SSE connection chỉ lắng nghe event channel riêng,
 * nên listener không tích lũy kể cả khi client reconnect nhanh.
 */
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

  const userEventChannel = `notification:read:${authenticatedUserId}`;

  // Gửi unread count thay vì full list để giảm bandwidth — SSE poll mỗi 5s.
  const sendUnreadCount = async (): Promise<void> => {
    try {
      const unreadCount = await getUnreadCount(authenticatedUserId);
      response.write(`event: unread-count\n`);
      response.write(`data: ${JSON.stringify({ unreadCount })}\n\n`);
    } catch (error) {
      logger.warn(`Không thể gửi unread count SSE. userId=${authenticatedUserId} error=${(error as Error).message}`);
      response.write(`event: heartbeat\n`);
      response.write(`data: {}\n\n`);
    }
  };

  // Gửi unread count ngay khi kết nối
  await sendUnreadCount();

  // Poll định kỳ mỗi 5 giây (fallback khi event bị miss)
  const pollInterval = setInterval(() => {
    void sendUnreadCount();
  }, 5000);

  // Lắng nghe user-scoped event — không cần filter userId vì channel đã là riêng
  const onNotificationRead = (): void => {
    void sendUnreadCount();
  };
  notificationEvents.on(userEventChannel, onNotificationRead);

  // Cleanup khi connection đóng
  request.on('close', () => {
    clearInterval(pollInterval);
    notificationEvents.removeListener(userEventChannel, onNotificationRead);
    response.end();
  });
}
