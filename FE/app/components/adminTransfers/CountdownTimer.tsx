'use client';

// =============================================================================
// CountdownTimer — A4: hiển thị đếm ngược đến lần retry tiếp theo
// Tính từ updatedAt + delay theo attemptCount (1m / 5m / 30m)
// =============================================================================

import { useState, useEffect, useRef } from 'react';

// Phản ánh PAYOS_TRANSFER_RETRY_DELAYS_MS trong BE (ms)
const RETRY_DELAYS_MS = [60_000, 300_000, 1_800_000] as const;

type CountdownTimerProps = {
  /** Thời điểm cập nhật lần cuối (ISO string) */
  updatedAt: string;
  /** Số lần đã retry — dùng để tính delay tiếp theo */
  attemptCount: number;
};

function formatDuration(ms: number): string {
  if (ms <= 0) return 'Sắp retry...';
  const totalSecs = Math.floor(ms / 1000);
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  if (mins > 0) return `${mins}p ${secs}s`;
  return `${secs}s`;
}

/**
 * Đếm ngược real-time đến lần retry tiếp theo dựa trên attemptCount + updatedAt.
 * Mục đích: cho admin biết khi nào transfer sẽ được retry tự động (nếu chưa MANUAL_REVIEW).
 */
export default function CountdownTimer({ updatedAt, attemptCount }: CountdownTimerProps) {
  const delayMs = RETRY_DELAYS_MS[Math.min(attemptCount, RETRY_DELAYS_MS.length - 1)] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
  const nextRetryAt = new Date(updatedAt).getTime() + delayMs;

  const [remaining, setRemaining] = useState(() => nextRetryAt - Date.now());
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (nextRetryAt - Date.now() <= 0) return; // Đã hết giờ, không cần interval
    intervalRef.current = setInterval(() => {
      const rem = nextRetryAt - Date.now();
      setRemaining(rem);
      if (rem <= 0 && intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    }, 1000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [nextRetryAt]);

  if (remaining <= 0) {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-semibold text-amber-600">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
        Sắp retry...
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1 font-mono text-xs text-slate-600">
      <svg width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" strokeLinecap="round" />
      </svg>
      {formatDuration(remaining)}
    </span>
  );
}
