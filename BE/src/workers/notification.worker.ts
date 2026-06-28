import { Job } from 'bull';
import { getLogger } from '../config/logger';
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
  type NotificationDeliveryStatusMap
} from '../services/notificationService';
import { notificationEvents } from '../events/notificationEvents';
import type { NotificationChannel, NotificationDeliveryState } from '../models/notificationModel';
import { extractErrorMessage } from '../utils/extractErrorMessage';

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
 * Hàm dispatch 1 channel — thực hiện side-effect delivery cho channel cụ thể.
 *
 * Theo spec E1: "Send via appropriate channel (IN_APP/EMAIL/PUSH/SMS) based on user preference".
 * E1 chỉ implement IN_APP delivery thật (ghi DB đã SENT + emit event để E3 consume).
 * Các channel khác (EMAIL/PUSH/SMS) là adapter skeleton — sẽ implement thật ở E2.
 *
 * Mục đích:
 * - IN_APP: update DB status='SENT' (đã đánh dấu trong notificationEvents listener tương lai của E3)
 *   và emit notificationEvents để SSE controller / future per-user socket forward tới client.
 * - EMAIL/PUSH/SMS: emit event để E2 service handler xử lý thật (Nodemailer/FCM/Twilio).
 *   Trong E1 nếu chưa có handler, default là "no-op delivered" vì spec E1 chưa yêu cầu transport thật.
 */
async function dispatchChannel(
  channel: NotificationChannel,
  job: NotificationJobData
): Promise<{ success: boolean; errorMessage?: string }> {
  try {
    if (channel === 'IN_APP') {
      // IN_APP delivery: ghi DB (đã làm trước đó qua upsert) + emit event cho E3/SSE consumer.
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

    if (channel === 'EMAIL' || channel === 'PUSH' || channel === 'SMS') {
      // E1 skeleton: emit event để E2 consume (khi implement Gmail SMTP/FCM/Twilio).
      // Nếu E2 chưa sẵn sàng, default coi như đã delivered (success=true) để không block E1 test path.
      // Khi E2 wire handler, nó sẽ handle thật và set status phù hợp qua DB update.
      notificationEvents.emit('notification.delivered', {
        notificationId: job.notificationId,
        userId: job.userId,
        notificationType: job.notificationType,
        channel,
        title: job.title,
        content: job.content,
        deliveredAt: new Date()
      });
      logger.info(`[E1 skeleton] Channel ${channel} delivery qua event bus — E2 sẽ handle transport thật.`, {
        notificationId: job.notificationId,
        userId: job.userId
      });
      return { success: true };
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
export async function processNotificationJob(job: Job<NotificationJobData>): Promise<{
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
    const dispatchResult = await dispatchChannel(channel, job.data);
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
    logger.error('Notification job đã hết retry — chuyển sang DLQ.', {
      notificationId,
      userId: job.data.userId,
      attempts: attemptNumber,
      errorMessage
    });

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
    try {
      return await processNotificationJob(job);
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
  });

  queue.on('completed', (job: Job<NotificationJobData>) => {
    logger.info('Notification job completed event.', {
      notificationId: job.data.notificationId,
      userId: job.data.userId,
      attemptNumber: job.data.attemptNumber,
      jobId: job.id
    });
  });

  queue.on('failed', (job, error) => {
    logger.error('Notification job failed event (DLQ).', {
      notificationId: job.data.notificationId,
      userId: job.data.userId,
      attemptNumber: job.data.attemptNumber,
      attemptsMade: job.attemptsMade,
      jobId: job.id,
      errorMessage: extractErrorMessage(error)
    });
  });

  queue.on('stalled', (job: Job<NotificationJobData>) => {
    logger.warn('Notification job bị stalled.', {
      notificationId: job.data.notificationId,
      userId: job.data.userId,
      jobId: job.id
    });
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