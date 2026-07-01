import Queue from 'bull';
import { getLogger } from '../config/logger';
import { getRedisClientIfReady } from '../config/redis';
import { extractErrorMessage } from '../utils/extractErrorMessage';
import type { NotificationChannel, NotificationPriority, NotificationType } from '../models/notificationModel';
import type { Job } from 'bull';

const logger = getLogger();
export const NOTIFICATION_QUEUE_NAME = 'notification';
export const NOTIFICATION_DLQ_QUEUE_NAME = 'notification:dlq';

// Redis config cho DLQ queue (tái sử dụng từ main queue pattern).
let redisConfig: string | undefined;

/**
 * Lấy redis config từ connection hiện tại.
 */
function getRedisConfig(): string {
  if (!redisConfig) {
    const redisClient = getRedisClientIfReady();
    redisConfig = redisClient?.options?.url ?? process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
  }
  return redisConfig;
}

/**
 * DLQ queue cho notification thất bại vĩnh viễn sau khi hết retries.
 * Job trong DLQ được giữ 30 ngày để admin có thể investigate.
 */
export const notificationDlqQueue = new Queue(NOTIFICATION_DLQ_QUEUE_NAME, getRedisConfig(), {
  defaultJobOptions: { removeOnComplete: true, removeOnFail: 30 * 24 * 60 }
});

/**
 * Map từ NotificationPriority → Bull priority (Bull: thấp hơn = chạy trước).
 * CRITICAL (1) chạy trước LOW (4).
 */
export const NOTIFICATION_BULL_PRIORITY: Record<NotificationPriority, number> = {
  CRITICAL: 1,
  HIGH: 2,
  NORMAL: 3,
  LOW: 4
};

/**
 * Số lần retry tối đa cho một notification job trước khi vào DLQ.
 * Theo spec E1: "fail sau 3 attempts → move to DLQ".
 */
export const NOTIFICATION_MAX_ATTEMPTS = 3;

/**
 * Delay giữa các retry (exponential backoff, ms).
 * Retry 1: 30s, Retry 2: 2 phút, Retry 3: 5 phút.
 */
export const NOTIFICATION_RETRY_DELAYS_MS = [
  30_000,      // Retry 1: 30s
  120_000,     // Retry 2: 2 phút
  300_000      // Retry 3: 5 phút
] as const;

/**
 * Throttle: tối đa N notification / user / 60 giây. Spec E1: max 5 notif/người/phút.
 */
export const NOTIFICATION_THROTTLE_MAX_PER_MINUTE = 5;
export const NOTIFICATION_THROTTLE_WINDOW_MS = 60_000;

/**
 * Delay áp dụng khi user vượt throttle — worker moveToDelayed(jobId, delayMs).
 * Đẩy job ra ngoài cửa sổ throttle (60s) để worker lúc đó xử lý lại.
 */
export const NOTIFICATION_THROTTLE_DELAY_MS = NOTIFICATION_THROTTLE_WINDOW_MS;

/**
 * Channel allowlist theo spec E2 — quy định channel nào được phép cho mỗi event type.
 * E1 dùng để skip channel không hợp lệ ngay từ lúc enqueue.
 * Lưu ý: E2 mới implement delivery thật cho EMAIL/PUSH/SMS.
 */
export const NOTIFICATION_ALLOWLIST: Record<NotificationType, NotificationChannel[]> = {
  DONATION_RECEIVED: ['IN_APP'],
  DISBURSEMENT_SIGNED: ['IN_APP', 'EMAIL'],
  PROJECT_APPROVED: ['IN_APP', 'EMAIL'],
  KYC_EXPIRING: ['IN_APP', 'EMAIL'],
  LARGE_DONATION: ['IN_APP', 'EMAIL', 'PUSH'],
  DISBURSEMENT_COMPLETED: ['IN_APP', 'EMAIL', 'PUSH'],
  MANUAL_REVIEW_ESCALATION: ['IN_APP', 'EMAIL', 'PUSH'],
  OVERRIDE_APPROVED: ['IN_APP', 'EMAIL', 'PUSH'],
  SBT_MINT_FAILED: ['IN_APP', 'EMAIL', 'PUSH'],
  SYSTEM: ['IN_APP']
};

export type NotificationJobData = {
  notificationId: string;
  userId: string;
  notificationType: NotificationType;
  title: string;
  content: string;
  channels: NotificationChannel[];
  priority: NotificationPriority;
  metadata: Record<string, unknown>;
  deduplicationKey?: string;
  /** Attempt hiện tại (1-indexed) — worker dùng để tính retry delay. */
  attemptNumber: number;
  /** Người/enqueue source — 'bridge' | 'api' | 'system' (cho audit log). */
  enqueuedBy: string;
};

export type NotificationJobResult = {
  notificationId: string;
  deliveryState: 'DELIVERED' | 'PARTIAL' | 'FAILED' | 'SKIPPED';
  deliveredChannels: NotificationChannel[];
  skippedChannels: NotificationChannel[];
  failedChannels: NotificationChannel[];
};

/**
 * Hàm tạo Bull queue cho notification.
 * Mục đích: cung cấp hàng đợi async với retry pattern tùy chỉnh.
 *
 * Cấu hình:
 * - limiter: max 50 job / 10s (channel routing rẻ, nên throttle nhẹ để tránh spike DB writes).
 * - maxStalledCount=2: nếu worker crash mid-job, Bull tự retry tối đa 2 lần.
 * - attempts=1: worker tự quản lý retry qua moveToDelayed (giống pattern sbtMintQueue).
 * - DLQ: queue phụ `notification:dlq` — job fail sau 3 attempts sẽ được move sang.
 */
function createNotificationQueue(): Queue.Queue<NotificationJobData> | null {
  const redisClient = getRedisClientIfReady();
  if (!redisClient) {
    logger.warn('Redis chưa sẵn sàng. Không thể tạo Bull queue cho notification.');
    return null;
  }

  const redisUrl = redisClient.options?.url ?? process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';

  return new Queue<NotificationJobData>(NOTIFICATION_QUEUE_NAME, redisUrl, {
    limiter: { max: 50, duration: 10_000 },
    maxStalledCount: 2,
    stalledInterval: 30_000,
    defaultJobOptions: {
      removeOnComplete: 100,
      removeOnFail: 200,
      attempts: 1
    }
  } as Parameters<typeof Queue>[2]);
}

let cachedQueue: Queue.Queue<NotificationJobData> | null = null;

/**
 * Hàm lấy queue singleton.
 * Mục đích: tái sử dụng queue instance xuyên suốt ứng dụng.
 */
export function getNotificationQueue(): Queue.Queue<NotificationJobData> | null {
  if (!cachedQueue) {
    cachedQueue = createNotificationQueue();
  }
  return cachedQueue;
}

/**
 * Hàm đẩy job notification vào queue.
 * Mục đích: trigger delivery bất đồng bộ qua worker.
 *
 * @param options.delay — override delay (ms), dùng cho throttle retry
 * @param options.priority — override priority (Bull: thấp = chạy trước)
 * @returns jobId nếu enqueue thành công, undefined nếu queue không khả dụng
 */
export async function enqueueNotification(
  jobData: NotificationJobData,
  options?: { delay?: number; priority?: number }
): Promise<{ jobId: string | number | undefined; enqueued: boolean }> {
  const queue = getNotificationQueue();
  if (!queue) {
    logger.warn('Notification queue không khả dụng. Bỏ qua enqueue job.', {
      notificationId: jobData.notificationId,
      userId: jobData.userId
    });
    return { jobId: undefined, enqueued: false };
  }

  const jobOptions: Queue.JobOptions = {
    attempts: 1,
    priority: options?.priority ?? NOTIFICATION_BULL_PRIORITY[jobData.priority]
  };
  if (options?.delay !== undefined) jobOptions.delay = options.delay;

  try {
    const job = await queue.add(jobData, jobOptions);
    logger.info('Notification job enqueued.', {
      notificationId: jobData.notificationId,
      userId: jobData.userId,
      notificationType: jobData.notificationType,
      channels: jobData.channels,
      priority: jobData.priority,
      attemptNumber: jobData.attemptNumber,
      enqueuedBy: jobData.enqueuedBy,
      jobId: job.id,
      delay: options?.delay ?? 0
    });
    return { jobId: job.id, enqueued: true };
  } catch (error) {
    logger.error('Enqueue notification job thất bại.', {
      notificationId: jobData.notificationId,
      userId: jobData.userId,
      errorMessage: extractErrorMessage(error)
    });
    return { jobId: undefined, enqueued: false };
  }
}

/**
 * Hàm kiểm tra throttle counter cho user dùng Redis INCR.
 * Mục đích: giới hạn tối đa N notif / user / phút — nếu vượt → return true.
 *
 * Pattern: dùng INCR + EXPIRE atomic. Lần INCR đầu set EXPIRE, các lần sau không reset TTL.
 * Nếu counter > MAX → throttle. Redis key tự xóa sau window → không cần cleanup.
 *
 * Trả về true nếu user ĐÃ vượt throttle (worker cần delay job).
 */
export async function isUserThrottled(userId: string): Promise<boolean> {
  const redisClient = getRedisClientIfReady();
  if (!redisClient) {
    // Không có Redis → không throttle (fail-open).
    // Tránh block delivery khi Redis chết — tradeoff availability > strict rate limit.
    return false;
  }

  const throttleKey = `notify:throttle:${userId}`;
  try {
    const currentCount = await redisClient.incr(throttleKey);
    if (currentCount === 1) {
      // Lần đầu trong window → set TTL.
      await redisClient.expire(throttleKey, Math.ceil(NOTIFICATION_THROTTLE_WINDOW_MS / 1000));
    }
    return currentCount > NOTIFICATION_THROTTLE_MAX_PER_MINUTE;
  } catch (error) {
    logger.warn('Không thể kiểm tra throttle counter, fail-open.', {
      userId,
      errorMessage: extractErrorMessage(error)
    });
    return false;
  }
}

/**
 * Hàm lấy số job đang chờ (waiting + delayed) cho một user.
 * Mục đích: query nhanh để monitor/admin view.
 */
export async function countPendingNotificationJobsByUserId(userId: string): Promise<number> {
  const queue = getNotificationQueue();
  if (!queue) return 0;

  const [waitingJobs, delayedJobs] = await Promise.all([
    queue.getWaiting(0, 99),
    queue.getDelayed(0, 99)
  ]);
  const allPendingJobs = [...waitingJobs, ...delayedJobs];
  return allPendingJobs.filter(job => job.data.userId === userId).length;
}

/**
 * Hàm đếm tổng job đang chờ trong queue.
 * Mục đích: health check + monitor.
 */
export async function getNotificationQueueStats(): Promise<{
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
}> {
  const queue = getNotificationQueue();
  if (!queue) {
    return { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 };
  }

  const [waiting, active, completed, failed, delayed] = await Promise.all([
    queue.getWaitingCount(),
    queue.getActiveCount(),
    queue.getCompletedCount(),
    queue.getFailedCount(),
    queue.getDelayedCount()
  ]);

  return { waiting, active, completed, failed, delayed };
}

/**
 * Chuyển job thất bại sang DLQ sau khi đã hết retries.
 * @param job Job gốc từ Bull queue
 */
export async function moveNotificationToDLQ(job: Job<NotificationJobData>): Promise<void> {
  await notificationDlqQueue.add(
    'failed-notification',
    job.data,
    {
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: 30 * 24 * 60 // giữ 30 ngày trong DLQ
    }
  );
  await job.remove();
}