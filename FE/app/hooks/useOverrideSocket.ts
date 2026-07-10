'use client';

// =============================================================================
// useOverrideSocket — B4: Real-time Socket.io hook cho Override GPS events
// Pattern giống useTransferSocket: kết nối admin room, lắng nghe override:new,
// polling fallback 30s nếu socket ngắt, và DỪNG polling khi drawer đóng
// để tránh waste CPU và cascade re-render.
// =============================================================================

import { useEffect, useRef, useCallback, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { readAuthSession } from '@/app/utils/authSession';
import { OVERRIDE_POLLING_SIGNAL_ID } from '@/app/components/systemAdmin/tailwind/overrideVoting.types';

export type OverrideSocketEvent =
  | { type: 'override:new'; overrideRequestId: string; projectId: string; reason: string; timestamp: string }
  | { type: 'override:resolved'; overrideRequestId: string; status: 'APPROVED' | 'REJECTED' | 'EXPIRED'; timestamp: string };

type UseOverrideSocketOptions = {
  /** Callback nhận event — giữ stable ref tránh reconnect loop */
  onEvent: (event: OverrideSocketEvent) => void;
  onConnectionChange?: (connected: boolean) => void;
  /** Bật polling fallback khi socket ngắt (mặc định true). */
  enablePolling?: boolean;
  /**
   * Khoảng polling (ms) khi socket ngắt. Mặc định 30s — chỉ nên giảm khi SLA yêu cầu realtime cao.
   * Polling fallback phải coi là best-effort không thay thế được socket chính.
   */
  pollingIntervalMs?: number;
};

/**
 * Hook kết nối Socket.io cho admin override voting (B4).
 * - override:new  → có override request PENDING mới cần biểu quyết
 * - override:resolved → request đã được resolve (APPROVED/REJECTED/EXPIRED)
 * - Polling fallback 30s khi socket disconnect để không miss data
 *   (TẮT polling khi `enablePolling === false` để tiết kiệm CPU khi drawer đóng).
 *
 * [B4-fix #4] Hook chỉ trigger polling khi caller chủ động bật — tránh re-render liên tục
 * và waste CPU cycles khi admin không có nhu cầu xem real-time.
 */
export function useOverrideSocket({
  onEvent,
  onConnectionChange,
  enablePolling = true,
  pollingIntervalMs = 30_000
}: UseOverrideSocketOptions): {
  isConnected: boolean;
  isUsingFallback: boolean;
} {
  const socketRef = useRef<Socket | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const onEventRef = useRef(onEvent);
  const onConnectionChangeRef = useRef(onConnectionChange);
  const enablePollingRef = useRef(enablePolling);
  const pollingIntervalMsRef = useRef(pollingIntervalMs);
  const [isConnected, setIsConnected] = useState(false);
  const [isUsingFallback, setIsUsingFallback] = useState(false);

  // Giữ callback refs mới nhất tránh stale closure — không trigger reconnect
  useEffect(() => { onEventRef.current = onEvent; }, [onEvent]);
  useEffect(() => { onConnectionChangeRef.current = onConnectionChange; }, [onConnectionChange]);
  useEffect(() => { enablePollingRef.current = enablePolling; }, [enablePolling]);
  useEffect(() => { pollingIntervalMsRef.current = pollingIntervalMs; }, [pollingIntervalMs]);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    setIsUsingFallback(false);
  }, []);

  /**
   * Bật polling fallback khi socket ngắt VÀ caller cho phép.
   * Nếu enablePolling=false → KHÔNG bật interval (tránh waste CPU).
   * [P4-fix] Thêm random jitter ±5s để tránh thundering herd khi nhiều users reconnect đồng thời.
   */
  const startPollingIfAllowed = useCallback(() => {
    if (!enablePollingRef.current) return;
    if (pollTimerRef.current) return;
    setIsUsingFallback(true);
    // Jitter: interval cơ bản ± 5s random
    const jitter = Math.random() * 10_000 - 5_000;
    const intervalWithJitter = Math.max(5_000, pollingIntervalMsRef.current + jitter);
    pollTimerRef.current = setInterval(() => {
      onEventRef.current({
        type: 'override:new',
        overrideRequestId: OVERRIDE_POLLING_SIGNAL_ID,
        projectId: '',
        reason: '',
        timestamp: new Date().toISOString()
      });
    }, intervalWithJitter);
  }, []);

  useEffect(() => {
    const session = readAuthSession();
    if (!session?.accessToken) return;

    const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000';

    const socket = io(apiBaseUrl, {
      path: '/socket.io',
      auth: { token: session.accessToken },
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000
    });

    socketRef.current = socket;

    socket.on('connect', () => {
      setIsConnected(true);
      stopPolling();
      onConnectionChangeRef.current?.(true);
    });

    socket.on('disconnect', () => {
      setIsConnected(false);
      onConnectionChangeRef.current?.(false);
      // Bật polling fallback để admin biết refresh danh sách khi socket ngắt
      startPollingIfAllowed();
    });

    socket.on('override:new', (data: Omit<OverrideSocketEvent & { type: 'override:new' }, 'type'>) => {
      onEventRef.current({ type: 'override:new', ...data });
    });

    socket.on('override:resolved', (data: Omit<OverrideSocketEvent & { type: 'override:resolved' }, 'type'>) => {
      onEventRef.current({ type: 'override:resolved', ...data });
    });

    socket.on('connect_error', (err) => {
      // Lỗi auth → dừng retry vô hạn, tránh spam request
      if (err.message === 'UNAUTHORIZED' || err.message === 'FORBIDDEN') {
        socket.disconnect();
      }
    });

    return () => {
      stopPolling();
      socket.disconnect();
      socketRef.current = null;
    };
  }, [startPollingIfAllowed, stopPolling]);

  return { isConnected, isUsingFallback };
}
