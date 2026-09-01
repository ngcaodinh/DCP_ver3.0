import Queue from 'bull';
import { getRedisClientIfReady } from '../config/redis';

export type DonationCertificateJobData =
  | { kind: 'VERIFY_AND_ISSUE'; certificateId: string; checkSequence: number }
  | { kind: 'SEND_ISSUED_EMAIL'; certificateId: string; attemptNumber: 1 | 2 | 3 | 4 }
  | { kind: 'SEND_REVOKED_EMAIL'; certificateId: string; attemptNumber: 1 | 2 | 3 | 4 }
  | { kind: 'REVERIFY_ISSUED'; certificateId: string; checkSequence: number };

let certificateQueue: Queue.Queue<DonationCertificateJobData> | null = null;
let certificateDlqQueue: Queue.Queue<DonationCertificateJobData> | null = null;

/** Lấy URL Redis đã sẵn sàng, không khởi động queue ở API khi Redis chưa kết nối. */
function getRedisUrl(): string | null { return getRedisClientIfReady()?.options?.url ?? (process.env.REDIS_URL?.trim() || null); }

/** Tạo queue certificate lazy để test và API không mở thêm kết nối Redis vô ích. */
function getQueue(): Queue.Queue<DonationCertificateJobData> | null {
  if (certificateQueue) return certificateQueue;
  const redisUrl = getRedisUrl();
  if (!redisUrl) return null;
  certificateQueue = new Queue<DonationCertificateJobData>('donation-certificate', redisUrl, { defaultJobOptions: { attempts: 1, removeOnComplete: 100, removeOnFail: 200 } });
  certificateDlqQueue = new Queue<DonationCertificateJobData>('donation-certificate:dlq', redisUrl, { defaultJobOptions: { attempts: 1, removeOnComplete: true, removeOnFail: 30 * 24 * 60 } });
  return certificateQueue;
}

/** Sinh deterministic job ID để Bull không thêm hai job active cùng certificate/attempt. */
export function getDonationCertificateJobId(data: DonationCertificateJobData): string { return `certificate:${data.kind}:${data.certificateId}:${'checkSequence' in data ? data.checkSequence : data.attemptNumber}`; }

/** Enqueue job certificate với delay, trả false khi Redis/queue chưa khả dụng để reconciliation phục hồi. */
export async function enqueueDonationCertificateJob(data: DonationCertificateJobData, delayMs: number): Promise<{ enqueued: boolean; jobId?: string | number }> {
  const queue = getQueue();
  if (!queue) return { enqueued: false };
  const job = await queue.add(data, { jobId: getDonationCertificateJobId(data), delay: delayMs, attempts: 1 });
  return { enqueued: true, jobId: job.id };
}

/** Cung cấp queue cho worker mà không export chi tiết khởi tạo. */
export function getDonationCertificateQueue(): Queue.Queue<DonationCertificateJobData> | null { return getQueue(); }

/** Gửi job thất bại vĩnh viễn vào DLQ phục vụ điều tra, không chứa email hoặc PII. */
export async function moveDonationCertificateJobToDlq(data: DonationCertificateJobData): Promise<void> { await certificateDlqQueue?.add(data); }

/** Đóng hai queue khi process worker shutdown graceful. */
export async function closeDonationCertificateQueues(): Promise<void> { await Promise.all([certificateQueue?.close(), certificateDlqQueue?.close()]); certificateQueue = null; certificateDlqQueue = null; }
