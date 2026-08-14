import { Job } from 'bull';
import { getLogger } from '../config/logger';
import { runWithWorkerContext } from '../config/requestContext';
import {
  getNotificationQueue,
  enqueueNotification,
  NOTIFICATION_MAX_ATTEMPTS,
  NOTIFICATION_RETRY_DELAYS_MS,
  isUserThrottled,
  NOTIFICATION_THROTTLE_DELAY_MS,
  moveNotificationToDLQ,
  type NotificationJobData
} from '../queues/notificationQueue';
import {
  findNotificationById,
  updateNotificationDeliveryStatus,
  updateChannelStatus,
  computeDeliveryState,
  getUnsubscribeTokenForUser,
  type NotificationDeliveryStatusMap
} from '../services/notificationService';
import { notificationEvents } from '../events/notificationEvents';
import { findUserNotificationContext } from '../models/authModel';
import { dispatchNotification } from '../services/notificationDispatcher.service';
import type { NotificationChannel, NotificationDeliveryState } from '../models/notificationModel';
import { extractErrorMessage } from '../utils/extractErrorMessage';
import { reportTerminalError } from '../utils/sentryReporter';

const logger = getLogger();

/**
 * Concurrency cho notification worker.
 * Cao hơn SBT mint (1-2) vì channel routing rẻ (ghi DB + log + event emit).
 */
const NOTIFICATION_WORKER_CONCURRENCY = 5;

/**
 * Sentinel value — dùng cho việc phát hiện "worker đã xử lý xong, không cần retry" trong catch.
 */
const SUCCESS_RESULT_TOKEN = 'SUCCESS';

/**
 * Ham dispatch 1 channel — thuc hien side-effect delivery cho channel cu the.
 *
 * Theo spec E2: goi E2 dispatcher cho EMAIL/PUSH/SMS, emit event cho IN_APP.
 * E2 dispatcher xu ly Nodemailer (EMAIL), FCM (PUSH), Twilio (SMS) + fallback chain.
 */
async function dispatchChannel(
  channel: NotificationChannel,
  job: NotificationJobData,
  userContext: { userEmail?: string; fcmDeviceToken?: string; phoneNumber?: string; unsubscribeToken?: string } | null
): Promise<{ success: boolean; errorMessage?: string }> {
  try {
    // IN_APP: emit event de E3 SSE consumer xu ly (khong goi dispatcher)
    if (channel === 'IN_APP') {
      notificationEvents.emit('notification.delivered', {
        notificationId: job.notificationId,
        userId: job.userId,
        notificationType: job.notificationType,
        channel: 'IN_APP',
        title: job.title,
        content: job.content,
        deliveredAt: new Date()
      });
      return { success: true };
    }

    // EMAIL/PUSH/SMS: goi E2 dispatcher de xu ly transport thuc te
    if (channel === 'EMAIL' || channel === 'PUSH' || channel === 'SMS') {
      if (!userContext) {
        logger.warn('User context khong co — skip channel dispatch.', {
          notificationId: job.notificationId,
          userId: job.userId,
          channels: [channel]
        });
        return { success: false, errorMessage: 'User context not available' };
      }

      const result = await dispatchNotification(
        {
          notificationId: job.notificationId,
          notificationType: job.notificationType,
          title: job.title,
          content: job.content,
          channels: [channel],
          metadata: job.metadata
        },
        {
          userId: job.userId,
          userEmail: userContext.userEmail,
          fcmDeviceToken: userContext.fcmDeviceToken,
          phoneNumber: userContext.phoneNumber,
          unsubscribeToken: userContext.unsubscribeToken,
          // Dùng metadata.donationAmountVnd làm nguồn duy nhất — threshold check dùng cùng metadata.
          donationAmountVnd: (job.metadata?.donationAmountVnd as number | undefined)
        }
      );

      const channelResult = result.channelResults[0]?.result;
      return {
        success: channelResult?.success ?? false,
        errorMessage: channelResult?.success === false ? channelResult.errorMessage : undefined
      };
    }

    return { success: false, errorMessage: `Unknown channel: ${channel}` };
  } catch (error) {
    return { success: false, errorMessage: extractErrorMessage(error) };
  }
}

/**
 * Hàm xử lý 1 notification job — entry point của worker.
 *
 * Flow:
 * 1. Throttle check: nếu user vượt 5 notif/phút → delay job 60s, return success (không retry).
 * 2. Notification record lookup: nếu không tìm thấy (admin xóa) → return success (skip).
 * 3. Per-channel dispatch: với mỗi channel trong job.channels → gọi dispatchChannel.
 * 4. Update DB với deliveryStatus + deliveryState mới.
 * 5. Nếu tất cả channel fail → throw để Bull retry (worker catch sẽ schedule next attempt).
 * 6. Nếu partial success → return success (coi như đã delivered một phần).
 *
 * @throws Error khi tất cả channel fail → Bull retry/DLQ.
 */
async function processNotificationJobInternal(job: Job<NotificationJobData>): Promise<{
  notificationId: string;
  deliveryState: NotificationDeliveryState;
  deliveredChannels: NotificationChannel[];
  failedChannels: NotificationChannel[];
}> {
  const { notificationId, userId, channels, attemptNumber } = job.data;
  const startTime = Date.now();

  logger.info('Notification job bắt đầu.', {
    notificationId,
    userId,
    channels,
    priority: job.data.priority,
    attemptNumber,
    jobId: job.id
  });

  // 1. Throttle check.
  const throttled = await isUserThrottled(userId);
  if (throttled) {
    logger.warn('User vượt throttle — delay job 60s để xử lý sau.', {
      notificationId,
      userId,
      attemptNumber,
      jobId: job.id
    });

    // Delay job 60s để worker xử lý lại sau khi window reset.
    // Dùng moveToDelayed (giống pattern sbtMintWorker).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (job as any).moveToDelayed(NOTIFICATION_THROTTLE_DELAY_MS);
    // Reset attemptNumber về 1 vì throttle không phải là failure.
    job.data = { ...job.data, attemptNumber: 1 };
    return {
      notificationId,
      deliveryState: 'PENDING',
      deliveredChannels: [],
      failedChannels: []
    };
  }

  // 2. Notification record lookup.
  const notification = await findNotificationById(notificationId);
  if (!notification) {
    logger.warn('Notification record không tìm thấy (có thể đã bị admin xóa), skip job.', {
      notificationId,
      userId,
      jobId: job.id
    });
    return {
      notificationId,
      deliveryState: 'SKIPPED',
      deliveredChannels: [],
      failedChannels: []
    };
  }

  // 2. Fetch user context + unsubscribe token for E2 dispatcher.
  const userContext = await findUserNotificationContext(userId);
  if (!userContext) {
    logger.warn('User not found (deleted) — skip notification job.', {
      notificationId,
      userId,
      jobId: job.id
    });
    return {
      notificationId,
      deliveryState: 'SKIPPED',
      deliveredChannels: [],
      failedChannels: []
    };
  }
  const unsubscribeToken = await getUnsubscribeTokenForUser(userId);

  // 3. Per-channel dispatch.
  let deliveryStatus: NotificationDeliveryStatusMap = notification.deliveryStatus || {
    IN_APP: 'PENDING',
    EMAIL: 'PENDING',
    PUSH: 'PENDING',
    SMS: 'PENDING'
  };
  const deliveredChannels: NotificationChannel[] = [];
  const failedChannels: NotificationChannel[] = [];

  for (const channel of channels) {
    const dispatchResult = await dispatchChannel(channel, job.data, {
      userEmail: userContext?.userEmail,
      fcmDeviceToken: userContext?.fcmDeviceToken,
      phoneNumber: userContext?.phoneNumber,
      unsubscribeToken: unsubscribeToken ?? undefined
    });
    if (dispatchResult.success) {
      deliveryStatus = updateChannelStatus(deliveryStatus, channel, 'SENT');
      deliveredChannels.push(channel);
    } else {
      deliveryStatus = updateChannelStatus(deliveryStatus, channel, 'FAILED');
      failedChannels.push(channel);
      notificationEvents.emit('notification.failed', {
        notificationId,
        userId,
        notificationType: job.data.notificationType,
        channel,
        errorMessage: dispatchResult.errorMessage || 'unknown',
        failedAt: new Date()
      });
    }
  }

  // 4. Compute delivery state và update DB.
  const deliveryState = computeDeliveryState(deliveryStatus, channels);
  await updateNotificationDeliveryStatus({
    notificationId,
    deliveryStatus,
    deliveryState,
    attempts: attemptNumber,
    ...(failedChannels.length > 0 && { lastError: `${failedChannels.length} channel(s) failed` })
  });

  const durationMs = Date.now() - startTime;
  logger.info('Notification job xử lý xong.', {
    notificationId,
    userId,
    deliveryState,
    deliveredChannels,
    failedChannels,
    attemptNumber,
    durationMs,
    jobId: job.id
  });

  // 5. Nếu tất cả channel fail → throw để Bull retry.
  if (deliveredChannels.length === 0 && failedChannels.length > 0) {
    throw new Error(
      `All channels failed for notification ${notificationId}: ${failedChannels.join(', ')}`
    );
  }

  return { notificationId, deliveryState, deliveredChannels, failedChannels };
}

/** Chạy processor notification trong correlation context riêng của queue job. */
export async function processNotificationJob(job: Job<NotificationJobData>): Promise<{
  notificationId: string;
  deliveryState: NotificationDeliveryState;
  deliveredChannels: NotificationChannel[];
  failedChannels: NotificationChannel[];
}> {
  return runWithWorkerContext(
    'notification',
    () => processNotificationJobInternal(job),
    job.id
  );
}

/**
 * Hàm schedule retry attempt tiếp theo với exponential backoff.
 * Mục đích: thay vì dùng Bull built-in attempts (vì cần control delay cụ thể),
 * worker tự moveToDelayed + add job mới với attemptNumber+1.
 */
async function scheduleNextAttempt(
  job: Job<NotificationJobData>,
  errorMessage: string
): Promise<void> {
  const { notificationId, attemptNumber } = job.data;

  if (attemptNumber >= NOTIFICATION_MAX_ATTEMPTS) {
    // Đã hết retry → move to DLQ.
    // Terminal: ghi Winston và capture Sentry theo bảng E6.
    reportTerminalError(
      'Notification job đã hết retry — chuyển sang DLQ.',
      new Error(errorMessage),
      {
        errorSource: 'job-dlq',
        metadata: {
          notificationId,
          userId: job.data.userId,
          attempts: attemptNumber,
          jobId: job.id,
          errorMessage
        }
      }
    );

    await updateNotificationDeliveryStatus({
      notificationId,
      deliveryStatus: job.data.channels.reduce<NotificationDeliveryStatusMap>(
        (acc, ch) => ({ ...acc, [ch]: 'FAILED' }),
        { IN_APP: 'FAILED', EMAIL: 'FAILED', PUSH: 'FAILED', SMS: 'FAILED' }
      ),
      deliveryState: 'FAILED',
      attempts: attemptNumber,
      lastError: errorMessage
    });

    // Chuyển job sang DLQ queue thay vì throw — DLQ được giữ 30 ngày để admin investigate.
    await moveNotificationToDLQ(job);
    return;
  }

  // Schedule retry.
  const nextAttempt = attemptNumber + 1;
  const delayMs = NOTIFICATION_RETRY_DELAYS_MS[attemptNumber - 1] ?? NOTIFICATION_RETRY_DELAYS_MS[0];
  const enqueueResult = await enqueueNotification(
    { ...job.data, attemptNumber: nextAttempt },
    { delay: delayMs, priority: job.opts.priority }
  );

  if (enqueueResult.enqueued) {
    logger.info('Đã schedule retry cho notification job.', {
      notificationId,
      userId: job.data.userId,
      nextAttempt,
      delayMs
    });
    // Update DB attempt count.
    await updateNotificationDeliveryStatus({
      notificationId,
      deliveryStatus: job.data.channels.reduce<NotificationDeliveryStatusMap>(
        (acc, ch) => ({ ...acc, [ch]: 'PENDING' }),
        { IN_APP: 'PENDING', EMAIL: 'PENDING', PUSH: 'PENDING', SMS: 'PENDING' }
      ),
      deliveryState: 'PENDING',
      attempts: attemptNumber,
      lastError: errorMessage
    });
  } else {
    logger.error('Không thể enqueue retry — không có queue khả dụng.', {
      notificationId,
      userId: job.data.userId
    });
  }
}

/**
 * Khởi động Notification worker.
 * Mục đích: consume job từ Bull queue và xử lý channel routing + retry/DLQ logic.
 */
export function startNotificationWorker(): void {
  const queue = getNotificationQueue();
  if (!queue) {
    logger.warn('Notification queue không khả dụng. Worker không khởi động.');
    return;
  }

  queue.process(NOTIFICATION_WORKER_CONCURRENCY, async (job: Job<NotificationJobData>) => {
    return runWithWorkerContext('notification', async () => {
      try {
        return await processNotificationJobInternal(job);
      } catch (error) {
        const errorMessage = extractErrorMessage(error);
        logger.warn('Notification job fail — xử lý retry/DLQ.', {
          notificationId: job.data.notificationId,
          userId: job.data.userId,
          attemptNumber: job.data.attemptNumber,
          errorMessage
        });
        await scheduleNextAttempt(job, errorMessage);
        // Return SUCCESS token để Bull không catch lại error này — error đã được handle.
        return { success: SUCCESS_RESULT_TOKEN } as never;
      }
    }, job.id);
  });

  queue.on('completed', (job: Job<NotificationJobData>) => {
    runWithWorkerContext('notification', () => {
      logger.info('Notification job completed event.', {
        notificationId: job.data.notificationId,
        userId: job.data.userId,
        attemptNumber: job.data.attemptNumber,
        jobId: job.id
      });
    }, job.id);
  });

  queue.on('failed', (job, error) => {
    runWithWorkerContext('notification', () => {
      logger.error('Notification job failed event (DLQ).', {
        notificationId: job.data.notificationId,
        userId: job.data.userId,
        attemptNumber: job.data.attemptNumber,
        attemptsMade: job.attemptsMade,
        jobId: job.id,
        errorMessage: extractErrorMessage(error)
      });
    }, job.id);
  });

  queue.on('stalled', (job: Job<NotificationJobData>) => {
    runWithWorkerContext('notification', () => {
      logger.warn('Notification job bị stalled.', {
        notificationId: job.data.notificationId,
        userId: job.data.userId,
        jobId: job.id
      });
    }, job.id);
  });

  logger.info(`Notification worker đã khởi động (concurrency=${NOTIFICATION_WORKER_CONCURRENCY}, maxAttempts=${NOTIFICATION_MAX_ATTEMPTS}).`);
}

/**
 * Dừng notification worker — đóng queue connection để graceful shutdown.
 * Mục đích: Bull tự đợi active job xử lý xong trước khi close (finish current job before exit).
 */
export async function stopNotificationWorker(): Promise<void> {
  const queue = getNotificationQueue();
  if (queue) {
    await queue.close();
    logger.info('Notification worker đã dừng.');
  }
  notificationEvents.removeAllListeners();
}
