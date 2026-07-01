/**
 * Notification Dispatcher — điều phối multi-channel delivery.
 * Quản lý allowlist, threshold check, retry, và fallback chain.
 */
import { getLogger } from '../config/logger';
import {
  EMAIL_ALLOWLIST_EVENT_TYPES,
  DEFAULT_LARGE_DONATION_THRESHOLD_VND,
  NOTIFICATION_EMAIL_TEMPLATE_MAP
} from './constants/notification.constants';
import type { DeliveryResult, DispatchContext } from './types/delivery.types';
import { sendEmail, isEmailServiceReady } from './email.service';
import { sendPushNotificationByContext, isPushServiceReady } from './push.service';
import { sendNotificationSms, isSmsServiceReady } from './sms.service';
import type { NotificationChannel, NotificationType } from '../models/notificationModel';

const logger = getLogger();

// Re-export shared map for callers that import this module.
export { NOTIFICATION_EMAIL_TEMPLATE_MAP };

/**
 * Kết quả dispatch của 1 notification.
 */
export type DispatchOutcome = {
  notificationId: string;
  channelResults: Array<{
    channel: NotificationChannel;
    result: DeliveryResult;
  }>;
  deliveryState: 'DELIVERED' | 'PARTIAL' | 'FAILED';
  totalAttempts: number;
};

/**
 * Kiểm tra notification type có trong EMAIL allowlist hay không.
 * Chỉ các event types cụ thể mới được gửi email.
 */
export function isEmailAllowed(notificationType: NotificationType): boolean {
  return EMAIL_ALLOWLIST_EVENT_TYPES.includes(notificationType as typeof EMAIL_ALLOWLIST_EVENT_TYPES[number]);
}

/**
 * Kiểm tra LARGE_DONATION có đủ threshold để gửi email hay không.
 * Threshold có thể được override qua LARGE_DONATION_THRESHOLD_VND env var.
 */
export function isLargeDonationThresholdMet(metadata?: Record<string, unknown>): boolean {
  const thresholdEnv = process.env.LARGE_DONATION_EMAIL_THRESHOLD_VND;
  const threshold = thresholdEnv ? parseInt(thresholdEnv, 10) : DEFAULT_LARGE_DONATION_THRESHOLD_VND;

  const donationAmount = metadata?.donationAmountVnd as number | undefined;
  if (donationAmount === undefined) {
    return true;
  }

  const met = donationAmount >= threshold;
  logger.info('LARGE_DONATION threshold check.', { donationAmount, threshold, thresholdMet: met });

  return met;
}

/**
 * Lấy các channel được phép gửi cho notification type cụ thể.
 * Filter channel không trong allowlist.
 */
export function getAllowedChannels(
  notificationType: NotificationType,
  requestedChannels: NotificationChannel[]
): NotificationChannel[] {
  if (!isEmailAllowed(notificationType)) {
    return requestedChannels.filter(ch => ch === 'IN_APP');
  }
  return requestedChannels;
}

// Map notification type → email template name.
// Chia sẻ qua NOTIFICATION_EMAIL_TEMPLATE_MAP từ constants; xem notification.constants.ts.
function mapNotificationTypeToTemplate(notificationType: NotificationType): string {
  return NOTIFICATION_EMAIL_TEMPLATE_MAP[notificationType] ?? 'generic-notification';
}

/**
 * Dispatch EMAIL channel với retry và fallback to IN_APP.
 * EMAIL retry đã được xử lý trong email.service (3 lần, 1 phút interval).
 * Khi EMAIL fail sau retries → return failure để caller xử lý.
 */
async function dispatchEmailChannel(
  notificationId: string,
  notificationType: NotificationType,
  title: string,
  content: string,
  metadata: Record<string, unknown> | undefined,
  dispatchContext: DispatchContext
): Promise<DeliveryResult> {
  // 1. Kiểm tra email allowlist
  if (!isEmailAllowed(notificationType)) {
    logger.info('EMAIL channel skipped — notification type không thuộc allowlist.', {
      notificationId,
      notificationType
    });
    return {
      success: false,
      channel: 'EMAIL',
      errorMessage: 'Notification type không thuộc email allowlist',
      retryable: false
    };
  }

  // 2. Kiểm tra LARGE_DONATION threshold
  if (notificationType === 'LARGE_DONATION' && !isLargeDonationThresholdMet(metadata)) {
    logger.info('EMAIL channel skipped — LARGE_DONATION chưa đủ threshold.', {
      notificationId
    });
    return {
      success: false,
      channel: 'EMAIL',
      errorMessage: 'LARGE_DONATION chưa đủ threshold',
      retryable: false
    };
  }

  // 3. Kiểm tra user email
  if (!dispatchContext.userEmail) {
    logger.warn('EMAIL channel skipped — user không có email.', {
      notificationId,
      userId: dispatchContext.userId
    });
    return {
      success: false,
      channel: 'EMAIL',
      errorMessage: 'User không có email',
      retryable: false
    };
  }

  // 4. Gửi email với retry (3 lần, 1 phút interval) — email.service đã xử lý
  const result = await sendEmail({
    to: dispatchContext.userEmail,
    templateName: mapNotificationTypeToTemplate(notificationType),
    subject: title,
    templateContext: {
      title,
      content,
      notificationId,
      notificationType,
      metadata: metadata ?? {},
      donationAmountVnd: dispatchContext.donationAmountVnd
    },
    unsubscribeToken: dispatchContext.unsubscribeToken
  });

  return result;
}

/**
 * Dispatch PUSH channel với fallback to EMAIL.
 */
async function dispatchPushChannel(
  notificationId: string,
  title: string,
  content: string,
  notificationType: NotificationType,
  metadata: Record<string, unknown> | undefined,
  dispatchContext: DispatchContext
): Promise<DeliveryResult> {
  if (!dispatchContext.fcmDeviceToken) {
    return {
      success: false,
      channel: 'PUSH',
      errorMessage: 'User không có FCM device token',
      retryable: false
    };
  }

  const result = await sendPushNotificationByContext(
    { userId: dispatchContext.userId, fcmDeviceToken: dispatchContext.fcmDeviceToken },
    { notificationId, title, content, notificationType, metadata }
  );

  // PUSH fallback to EMAIL khi FCM fail
  if (!result.success) {
    logger.info('PUSH channel failed — thử fallback to EMAIL.', {
      notificationId,
      userId: dispatchContext.userId,
      errorMessage: result.errorMessage
    });

    if (dispatchContext.userEmail && isEmailAllowed(notificationType)) {
      const emailFallback = await sendEmail({
        to: dispatchContext.userEmail,
        templateName: mapNotificationTypeToTemplate(notificationType),
        subject: title,
        templateContext: { title, content, notificationId, notificationType, metadata: metadata ?? {}, pushFailed: true },
        unsubscribeToken: dispatchContext.unsubscribeToken
      });

      if (emailFallback.success) {
        logger.info('PUSH fallback EMAIL thành công.', { notificationId, userId: dispatchContext.userId });
        return { success: true, channel: 'PUSH', providerMessageId: emailFallback.providerMessageId, latencyMs: emailFallback.latencyMs };
      }
    }

    return result;
  }

  return result;
}

/**
 * Dispatch SMS channel với fallback to EMAIL.
 */
async function dispatchSmsChannel(
  notificationId: string,
  title: string,
  content: string,
  notificationType: NotificationType,
  dispatchContext: DispatchContext
): Promise<DeliveryResult> {
  if (!dispatchContext.phoneNumber) {
    return {
      success: false,
      channel: 'SMS',
      errorMessage: 'User không có số điện thoại',
      retryable: false
    };
  }

  const result = await sendNotificationSms(
    { userId: dispatchContext.userId, phoneNumber: dispatchContext.phoneNumber },
    { notificationId, title, content, notificationType }
  );

  // SMS fallback to EMAIL khi Twilio fail
  if (!result.success) {
    logger.info('SMS channel failed — thử fallback to EMAIL.', {
      notificationId,
      userId: dispatchContext.userId,
      errorMessage: result.errorMessage
    });

    if (dispatchContext.userEmail && isEmailAllowed(notificationType)) {
      const emailFallback = await sendEmail({
        to: dispatchContext.userEmail,
        templateName: mapNotificationTypeToTemplate(notificationType),
        subject: title,
        templateContext: {
          title,
          content,
          notificationId,
          notificationType,
          metadata: metadata ?? {},
          smsFailed: true,
          donationAmountVnd: dispatchContext.donationAmountVnd
        },
        unsubscribeToken: dispatchContext.unsubscribeToken
      });

      if (emailFallback.success) {
        logger.info('SMS fallback EMAIL thành công.', { notificationId, userId: dispatchContext.userId });
        return { success: true, channel: 'SMS', providerMessageId: emailFallback.providerMessageId, latencyMs: emailFallback.latencyMs };
      }
    }

    return result;
  }

  return result;
}

/**
 * Dispatch notification qua tất cả các channel.
 * Quản lý fallback chain:
 * - EMAIL → retry 3x/1min → fallback to IN_APP
 * - PUSH → on fail → fallback to EMAIL
 * - SMS → on fail → fallback to EMAIL
 * - Tất cả fail → status FAILED + log error
 *
 * @param notificationData Dữ liệu notification cần dispatch
 * @param dispatchContext Thông tin user context
 * @returns DispatchOutcome với kết quả từng channel
 */
export async function dispatchNotification(
  notificationData: {
    notificationId: string;
    notificationType: NotificationType;
    title: string;
    content: string;
    channels: NotificationChannel[];
    metadata?: Record<string, unknown>;
  },
  dispatchContext: DispatchContext
): Promise<DispatchOutcome> {
  const { notificationId, notificationType, title, content, channels, metadata } = notificationData;
  const startTime = Date.now();

  logger.info('Bắt đầu dispatch notification qua multi-channel.', {
    notificationId,
    notificationType,
    channels,
    userId: dispatchContext.userId
  });

  const channelResults: Array<{ channel: NotificationChannel; result: DeliveryResult }> = [];

  // Dispatch parallel qua Promise.all — mỗi channel là I/O-bound độc lập.
  // IN_APP là pure sync, vẫn wrap trong Promise để code đồng nhất.
  const dispatchPromises = channels.map(async (channel) => {
    let result: DeliveryResult;

    switch (channel) {
      case 'EMAIL':
        result = await dispatchEmailChannel(notificationId, notificationType, title, content, metadata, dispatchContext);
        break;
      case 'PUSH':
        result = await dispatchPushChannel(notificationId, title, content, notificationType, metadata, dispatchContext);
        break;
      case 'SMS':
        result = await dispatchSmsChannel(notificationId, title, content, notificationType, dispatchContext);
        break;
      case 'IN_APP':
        // IN_APP: success ngay (DB record đã được tạo bởi notificationService)
        result = { success: true, channel: 'IN_APP', latencyMs: 0 };
        break;
      default:
        result = { success: false, channel, errorMessage: `Unknown channel: ${channel}`, retryable: false };
    }

    if (result.success) {
      logger.info(`Channel ${channel} dispatch thành công.`, {
        notificationId,
        userId: dispatchContext.userId,
        channel,
        providerMessageId: result.providerMessageId
      });
    } else {
      logger.warn(`Channel ${channel} dispatch thất bại.`, {
        notificationId,
        userId: dispatchContext.userId,
        channel,
        errorMessage: result.errorMessage,
        retryable: result.retryable
      });
    }

    return { channel, result };
  });

  // Promise.allSettled để 1 channel fail không block logging/aggregation của channels khác
  const settled = await Promise.allSettled(dispatchPromises);
  for (const s of settled) {
    if (s.status === 'fulfilled') {
      channelResults.push(s.value);
    } else {
      // Tạo result cho channel bị throw (không nên xảy ra — dispatch* đều trả DeliveryResult)
      logger.error('Channel dispatch threw unhandled exception.', {
        notificationId,
        userId: dispatchContext.userId,
        errorMessage: (s.reason as Error)?.message ?? String(s.reason)
      });
    }
  }

  // Tính delivery state
  const succeededChannels = channelResults.filter(r => r.result.success);
  const failedChannels = channelResults.filter(r => !r.result.success);

  let deliveryState: 'DELIVERED' | 'PARTIAL' | 'FAILED';
  if (succeededChannels.length === channelResults.length) {
    deliveryState = 'DELIVERED';
  } else if (succeededChannels.length > 0) {
    deliveryState = 'PARTIAL';
  } else {
    deliveryState = 'FAILED';
    logger.error('Tất cả channels dispatch thất bại.', {
      notificationId,
      userId: dispatchContext.userId,
      failedChannels: failedChannels.map(r => r.channel)
    });
  }

  const durationMs = Date.now() - startTime;
  logger.info('Dispatch notification hoàn tất.', {
    notificationId,
    userId: dispatchContext.userId,
    deliveryState,
    durationMs,
    succeededChannels: succeededChannels.map(r => r.channel),
    failedChannels: failedChannels.map(r => r.channel)
  });

  return {
    notificationId,
    channelResults,
    deliveryState,
    totalAttempts: channelResults.length
  };
}

/**
 * Kiểm tra xem dispatcher có sẵn sàng hay không.
 * Dùng cho health check.
 */
export function isDispatcherReady(): boolean {
  return isEmailServiceReady() || isPushServiceReady() || isSmsServiceReady();
}
