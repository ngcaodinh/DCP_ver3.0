'use client';

import { useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { readAuthSession } from '@/app/utils/authSession';

export type TransferSocketEvent =
  | {
      type: 'transfer:manual-review-required';
      requestId: string;
      queueId?: string;
      reviewCycle?: number;
      projectId: string;
      amount: number;
      requestMode?: string;
      timestamp: string;
    }
  | {
      type: 'transfer:updated';
      requestId: string;
      queueId?: string;
      reviewCycle?: number;
      payosTransferStatus?: string;
      status?: string;
      updatedAt: string;
    }
  | {
      type: 'transfer:escalation-alert';
      requestId: string;
      queueId?: string;
      reviewCycle?: number;
      hoursOverdue?: number;
      timestamp: string;
    };

type UseTransferSocketOptions = {
  onEvent: (event: TransferSocketEvent) => void;
  onPollTick?: () => void;
  onReconnect?: () => void;
  onConnectionChange?: (connected: boolean) => void;
};

const FALLBACK_START_DELAY_MS = 5_000;
const FALLBACK_POLL_INTERVAL_MS = 30_000;
const EVENT_DEDUP_WINDOW_MS = 15_000;
const MAX_TRACKED_EVENTS = 500;

/** Hook kết nối room admin, dedup event theo queueId và luôn có polling fallback bounded. */
export function useTransferSocket({
  onEvent,
  onPollTick,
  onReconnect,
  onConnectionChange
}: UseTransferSocketOptions): { isConnected: boolean; isUsingFallback: boolean } {
  const onEventRef = useRef(onEvent);
  const onPollTickRef = useRef(onPollTick);
  const onReconnectRef = useRef(onReconnect);
  const onConnectionChangeRef = useRef(onConnectionChange);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isUsingFallback, setIsUsingFallback] = useState(false);

  useEffect(() => {
    onEventRef.current = onEvent;
    onPollTickRef.current = onPollTick;
    onReconnectRef.current = onReconnect;
    onConnectionChangeRef.current = onConnectionChange;
  }, [onEvent, onPollTick, onReconnect, onConnectionChange]);

  useEffect(() => {
    let socket: Socket | null = null;
    let fallbackStartTimer: ReturnType<typeof setTimeout> | null = null;
    let isCleanedUp = false;
    let hasConnected = false;
    let hasDisconnected = false;
    const deduplicatedEvents = new Map<string, number>();

    /** Dừng timer polling và chỉ tắt badge fallback khi socket đã hoạt động. */
    const stopPolling = () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      setIsUsingFallback(false);
    };

    /** Bật fallback ngay cả khi socket chưa từng connect hoặc auth socket thất bại. */
    const startPolling = () => {
      if (isCleanedUp) return;
      setIsUsingFallback(true);
      if (document.hidden || pollTimerRef.current) return;
      pollTimerRef.current = setInterval(() => {
        if (!document.hidden) {
          onPollTickRef.current?.();
        }
      }, FALLBACK_POLL_INTERVAL_MS);
    };

    /** Bỏ qua event trùng trong recovery window để tránh double toast/refetch. */
    const shouldHandleEvent = (event: TransferSocketEvent): boolean => {
      if (!event.queueId) return true;
      const deduplicationKey = `${event.type}:${event.queueId}`;
      const now = Date.now();
      const previousTimestamp = deduplicatedEvents.get(deduplicationKey);
      if (previousTimestamp && now - previousTimestamp < EVENT_DEDUP_WINDOW_MS) {
        return false;
      }
      deduplicatedEvents.set(deduplicationKey, now);
      if (deduplicatedEvents.size > MAX_TRACKED_EVENTS) {
        const oldestKey = deduplicatedEvents.keys().next().value;
        if (oldestKey) deduplicatedEvents.delete(oldestKey);
      }
      return true;
    };

    /** Nhận event từ Socket.io sau khi đã dedup theo queueId/type. */
    const forwardEvent = (event: TransferSocketEvent) => {
      if (shouldHandleEvent(event)) {
        onEventRef.current(event);
      }
    };

    /** Đồng bộ trạng thái fallback khi tab chuyển nền hoặc quay lại foreground. */
    const handleVisibilityChange = () => {
      if (document.hidden) {
        if (pollTimerRef.current) {
          clearInterval(pollTimerRef.current);
          pollTimerRef.current = null;
        }
        return;
      }
      if (!hasConnected || hasDisconnected) startPolling();
    };

    /** Dọn listener/timer/socket dùng chung cho mọi nhánh khởi tạo của hook. */
    const cleanup = () => {
      isCleanedUp = true;
      if (fallbackStartTimer) {
        clearTimeout(fallbackStartTimer);
        fallbackStartTimer = null;
      }
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      stopPolling();
      socket?.disconnect();
      socket = null;
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    const session = readAuthSession();
    onConnectionChangeRef.current?.(false);

    if (!session.accessToken) {
      startPolling();
      return cleanup;
    }

    const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL;
    if (!apiBaseUrl) {
      // Thiếu env build-time thì chỉ polling, tuyệt đối không gửi token tới localhost không xác định.
      startPolling();
      return cleanup;
    }

    socket = io(apiBaseUrl, {
      path: '/socket.io',
      auth: { token: session.accessToken },
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000
    });

    // Nếu không có connect trong thời gian chờ, list API vẫn phải tiếp tục cập nhật.
    fallbackStartTimer = setTimeout(startPolling, FALLBACK_START_DELAY_MS);

    socket.on('connect', () => {
      if (fallbackStartTimer) {
        clearTimeout(fallbackStartTimer);
        fallbackStartTimer = null;
      }
      if (hasConnected && hasDisconnected) {
        onReconnectRef.current?.();
      }
      hasConnected = true;
      hasDisconnected = false;
      setIsConnected(true);
      stopPolling();
      onConnectionChangeRef.current?.(true);
    });

    socket.on('disconnect', () => {
      hasDisconnected = true;
      setIsConnected(false);
      onConnectionChangeRef.current?.(false);
      startPolling();
    });

    socket.on('transfer:manual-review-required', (data: Omit<Extract<TransferSocketEvent, { type: 'transfer:manual-review-required' }>, 'type'>) => {
      forwardEvent({ type: 'transfer:manual-review-required', ...data });
    });

    socket.on('transfer:updated', (data: Omit<Extract<TransferSocketEvent, { type: 'transfer:updated' }>, 'type'>) => {
      forwardEvent({ type: 'transfer:updated', ...data });
    });

    socket.on('transfer:escalation-alert', (data: Omit<Extract<TransferSocketEvent, { type: 'transfer:escalation-alert' }>, 'type'>) => {
      forwardEvent({ type: 'transfer:escalation-alert', ...data });
    });

    socket.on('connect_error', (error) => {
      setIsConnected(false);
      onConnectionChangeRef.current?.(false);
      startPolling();
      if (error.message === 'UNAUTHORIZED' || error.message === 'FORBIDDEN') {
        socket?.disconnect();
      }
    });

    return cleanup;
  }, []);

  return { isConnected, isUsingFallback };
}
