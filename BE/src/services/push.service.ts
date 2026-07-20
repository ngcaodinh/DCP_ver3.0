/**
 * Service gửi push notification qua Firebase Cloud Messaging (FCM).
 * Fallback sang EMAIL khi FCM fail.
 */
import { initializeApp, getApps, cert, type App, type ServiceAccount } from 'firebase-admin/app';
import { getMessaging, type Messaging } from 'firebase-admin/messaging';
import { getLogger } from '../config/logger';
import { PUSH_TIMEOUT_MS } from './constants/notification.constants';
import type { DeliveryResult } from './types/delivery.types';

const logger = getLogger();

// Firebase Admin app — singleton
let firebaseApp: App | null = null;
let messagingClient: Messaging | null = null;

/**
 * Kiểm tra FCM credentials có được cấu hình hay chưa.
 * @returns true nếu có đủ credentials
 */
function hasFcmCredentials(): boolean {
  return !!(
    process.env.FCM_PROJECT_ID &&
    process.env.FCM_PRIVATE_KEY &&
    process.env.FCM_CLIENT_EMAIL
  );
}

/**
 * Khởi tạo Firebase Admin SDK.
 * Credentials được đọc từ environment variables (service account JSON).
 *
 * Env vars bắt buộc:
 * - FCM_PROJECT_ID: project ID từ Firebase console
 * - FCM_PRIVATE_KEY: private key (PEM format, newline escaped)
 * - FCM_CLIENT_EMAIL: client email từ service account
 */
function initializeFirebase(): App | null {
  if (firebaseApp) return firebaseApp;

  if (!hasFcmCredentials()) {
    logger.warn('Thiếu FCM credentials trong environment variables.');
    return null;
  }

  try {
    // Parse private key — nó được lưu với escaped newlines trong env
    const privateKey = process.env.FCM_PRIVATE_KEY!
      .replace(/\\n/g, '\n');

    const serviceAccount: ServiceAccount = {
      projectId: process.env.FCM_PROJECT_ID,
      privateKey,
      clientEmail: process.env.FCM_CLIENT_EMAIL
    };

    // Check if already initialized
    const existingApps = getApps();
    if (existingApps.length > 0) {
      firebaseApp = existingApps[0];
    } else {
      firebaseApp = initializeApp({
        credential: cert(serviceAccount)
      });
    }

    messagingClient = getMessaging(firebaseApp);
    logger.info('Firebase Admin SDK đã được khởi tạo thành công.', {
      projectId: process.env.FCM_PROJECT_ID
    });

    return firebaseApp;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('Không thể khởi tạo Firebase Admin SDK.', {
      errorMessage
    });
    return null;
  }
}

/**
 * Lấy Firebase Messaging client (lazy initialization).
 */
function getMessagingClient(): Messaging | null {
  if (!messagingClient) {
    initializeFirebase();
  }
  return messagingClient;
}

/**
 * Reset Firebase app (dùng cho testing).
 */
export function resetFirebaseApp(): void {
  firebaseApp = null;
  messagingClient = null;
}

/**
 * Gửi push notification qua FCM.
 * Đây là entry point chính cho PUSH channel.
 *
 * @param options Các tham số gửi push notification
 * @returns DeliveryResult
 */
export async function sendPushNotification(options: {
  deviceToken: string;
  title: string;
  body: string;
  data?: Record<string, string>;
}): Promise<DeliveryResult> {
  const messaging = getMessagingClient();

  if (!messaging) {
    return {
      success: false,
      channel: 'PUSH',
      errorMessage: 'FCM không khả dụng (thiếu credentials hoặc chưa init)',
      retryable: false
    };
  }

  const startTime = Date.now();

  try {
    const message = {
      token: options.deviceToken,
      notification: {
        title: options.title,
        body: options.body
      },
      data: options.data ?? {},
      // Ưu tiên cao cho notification quan trọng
      android: {
        priority: 'high' as const,
        notification: {
          channelId: 'dcp_notifications',
          priority: 'high' as const,
          defaultSound: true,
          defaultVibrateTimings: true
        }
      },
      apns: {
        payload: {
          aps: {
            badge: 1,
            sound: 'default'
          }
        }
      },
      webpush: {
        headers: {
          Urgency: 'high'
        }
      }
    };

    const messageId = await Promise.race([
      messaging.send(message),
      new Promise<'timeout'>((_, reject) =>
        setTimeout(() => reject(new Error('FCM timeout')), PUSH_TIMEOUT_MS)
      )
    ]);

    const latencyMs = Date.now() - startTime;

    logger.info('Push notification đã được gửi thành công qua FCM.', {
      messageId,
      deviceToken: options.deviceToken.substring(0, 20) + '...',
      latencyMs
    });

    return {
      success: true,
      channel: 'PUSH',
      providerMessageId: messageId,
      latencyMs
    };
  } catch (error) {
    const latencyMs = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);

    logger.error('Push notification thất bại qua FCM.', {
      deviceToken: options.deviceToken.substring(0, 20) + '...',
      errorMessage,
      latencyMs
    });

    // FCM errors có thể retry được (rate limit, server error)
    const retryable = isRetryableFcmError(error);

    return {
      success: false,
      channel: 'PUSH',
      errorMessage,
      retryable
    };
  }
}

/**
 * Kiểm tra xem lỗi FCM có retryable hay không.
 */
function isRetryableFcmError(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    // Lỗi không retry: invalid token, unregistered device
    if (message.includes('invalid registration token')) return false;
    if (message.includes('not registered')) return false;
    if (message.includes('messaging/invalid-argument')) return false;
    // Timeout thì retry
    if (message.includes('timeout')) return true;
  }
  // Mặc định retry
  return true;
}

/**
 * Gửi push notification dựa trên dispatch context.
 * Dùng bởi notificationDispatcher.
 *
 * @param dispatchContext Thông tin user context cho dispatch
 * @param notificationData Dữ liệu notification cần gửi
 * @returns DeliveryResult
 */
export async function sendPushNotificationByContext(
  dispatchContext: { userId: string; fcmDeviceToken?: string },
  notificationData: {
    notificationId: string;
    title: string;
    content: string;
    notificationType: string;
    metadata?: Record<string, unknown>;
  }
): Promise<DeliveryResult> {
  if (!dispatchContext.fcmDeviceToken) {
    return {
      success: false,
      channel: 'PUSH',
      errorMessage: 'User không có FCM device token — skip PUSH channel',
      retryable: false
    };
  }

  return sendPushNotification({
    deviceToken: dispatchContext.fcmDeviceToken,
    title: notificationData.title,
    body: notificationData.content,
    data: {
      notificationId: notificationData.notificationId,
      notificationType: notificationData.notificationType,
      // Flatten metadata cho FCM data payload
      ...flattenMetadata(notificationData.metadata)
    }
  });
}

/**
 * Flatten metadata object thành string key-value pairs cho FCM data.
 * FCM data payload chỉ chấp nhận string values.
 */
function flattenMetadata(
  metadata?: Record<string, unknown>
): Record<string, string> {
  if (!metadata) return {};

  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (value !== undefined && value !== null) {
      result[key] = typeof value === 'string' ? value : JSON.stringify(value);
    }
  }
  return result;
}

/**
 * Kiểm tra xem push service có sẵn sàng hay không.
 */
export function isPushServiceReady(): boolean {
  return getMessagingClient() !== null;
}
