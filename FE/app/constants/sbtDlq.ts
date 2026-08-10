import type { SbtDlqStatus, SbtMintDlqEntry } from '@/app/types/sbtRetry';

export const SBT_DLQ_PAGE_SIZE = 20;
export const SBT_DLQ_POLL_INTERVAL_MS = 10_000;
export const SBT_DLQ_RETRY_WATCH_TIMEOUT_MS = 180_000;
export const SBT_DLQ_ESCALATION_AGE_DAYS = 3;
export const SBT_DLQ_ESCALATION_RETRY_THRESHOLD = 3;

/** Danh sách tab trạng thái theo đúng enum mà BE nhận ở query string. */
export const SBT_DLQ_STATUS_TABS: ReadonlyArray<{ key: SbtDlqStatus; label: string }> = [
  { key: 'OPEN', label: 'Đang mở' },
  { key: 'RECOVERED', label: 'Đã khôi phục' },
  { key: 'ABANDONED', label: 'Đã bỏ qua' }
];

/** Xác định entry cần cảnh báo theo số lần retry hoặc tuổi bản ghi DLQ. */
export function isDlqEntryEscalated(entry: SbtMintDlqEntry, now: Date): boolean {
  const dlqTimestamp = new Date(entry.dlqAt).getTime();
  const escalationAgeMs = SBT_DLQ_ESCALATION_AGE_DAYS * 24 * 60 * 60 * 1000;

  return entry.recoveryAttemptNumber >= SBT_DLQ_ESCALATION_RETRY_THRESHOLD
    || (!Number.isNaN(dlqTimestamp) && now.getTime() - dlqTimestamp >= escalationAgeMs);
}
