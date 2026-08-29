import { getLogger } from '../config/logger';
import { runWithWorkerContext } from '../config/requestContext';
import { expireOverdueDisbursementCommitteeCases } from '../services/disbursementCommitteeVoting.service';

const logger = getLogger();
const POLL_INTERVAL_MS = 60_000;
let intervalId: ReturnType<typeof setInterval> | null = null;

/** Chạy một vòng dọn case giải ngân quá hạn để test và scheduler cùng dùng một hành vi CAS idempotent. */
async function runDisbursementCommitteeExpiryCycleInternal(): Promise<void> {
  const expiredCount = await expireOverdueDisbursementCommitteeCases();
  if (expiredCount > 0) {
    logger.info('Đã đóng các case giải ngân quá hạn.', { context: { expiredCount } });
  }
}

/** Chạy công khai một vòng expiry với request context của worker. */
export function runDisbursementCommitteeExpiryCycle(): Promise<void> {
  return runWithWorkerContext('disbursement-committee-expiry', runDisbursementCommitteeExpiryCycleInternal);
}

/** Khởi động polling expiry độc lập; CAS ở service cho phép nhiều instance cùng chạy an toàn. */
export function startDisbursementCommitteeExpiryWorker(): void {
  if (intervalId) return;
  void runDisbursementCommitteeExpiryCycle();
  intervalId = setInterval(() => { void runDisbursementCommitteeExpiryCycle(); }, POLL_INTERVAL_MS);
}

/** Dừng polling expiry khi graceful shutdown. */
export function stopDisbursementCommitteeExpiryWorker(): void {
  if (!intervalId) return;
  clearInterval(intervalId);
  intervalId = null;
}
