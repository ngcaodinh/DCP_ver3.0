'use client';

import { useEffect, useRef, useState } from 'react';

type CountdownTimerProps = {
  /** SLA snapshot do backend cấp, không suy ra từ updatedAt ở client. */
  deadline: string;
  /** Thời điểm escalation đã được worker ghi nhận, nếu có. */
  escalatedAt: string | null;
  /** Chỗ cắm cho follow-up persist nextRetryAt; A4 chưa dùng field này. */
  nextRetryAt?: string | null;
};

/** Định dạng số mili-giây còn lại theo ngôn ngữ hiển thị của dashboard. */
function formatDuration(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(remainingMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours}g ${minutes}p ${seconds}s`;
}

/** Hiển thị SLA realtime từ deadline server và dọn interval đầy đủ khi hết hạn/unmount. */
export default function CountdownTimer({ deadline, escalatedAt }: CountdownTimerProps) {
  const deadlineTimestamp = new Date(deadline).getTime();
  const hasValidDeadline = Number.isFinite(deadlineTimestamp);
  const [remainingMs, setRemainingMs] = useState(() => hasValidDeadline ? deadlineTimestamp - Date.now() : 0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const updateRemaining = () => {
      const nextRemainingMs = hasValidDeadline ? deadlineTimestamp - Date.now() : 0;
      setRemainingMs(nextRemainingMs);
      if (nextRemainingMs <= 0 && intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };

    updateRemaining();
    if (hasValidDeadline && deadlineTimestamp > Date.now()) {
      intervalRef.current = setInterval(updateRemaining, 1000);
    }

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [deadlineTimestamp, hasValidDeadline]);

  if (escalatedAt) {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-semibold text-red-700">
        <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
        Đã escalate lúc {new Date(escalatedAt).toLocaleString('vi-VN')}
      </span>
    );
  }

  if (!hasValidDeadline) {
    return <span className="text-xs font-semibold text-amber-700">SLA không hợp lệ</span>;
  }

  if (remainingMs <= 0) {
    return <span className="text-xs font-semibold text-red-700">Quá hạn SLA</span>;
  }

  const isUrgent = remainingMs < 2 * 60 * 60 * 1000;
  return (
    <span className={`inline-flex items-center gap-1 font-mono text-xs ${isUrgent ? 'font-semibold text-red-600' : 'text-slate-600'}`}>
      <svg width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" strokeLinecap="round" />
      </svg>
      {formatDuration(remainingMs)}
    </span>
  );
}
