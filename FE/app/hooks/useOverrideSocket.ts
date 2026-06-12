'use client';

// =============================================================================
// useOverrideSocket — B4: Real-time Socket.io hook cho Override GPS events
// Pattern giống useTransferSocket: kết nối admin room, lắng nghe override:new,
// polling fallback 30s nếu socket ngắt.
// =============================================================================

import { useEffect, useRef, useCallback, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { readAuthSession } from '@/app/utils/authSession';

export type OverrideSocketEvent =
  | { type: 'override:new'; overrideRequestId: string; projectId: string; reason: string; timestamp: string }
  | { type: 'override:resolved'; overrideRequestId: string; status: 'APPROVED' | 'REJECTED' | 'EXPIRED'; timestamp: string };

type UseOverrideSocketOptions = {
  /** Callback nhận event — giữ stable ref tránh reconnect loop */
  onEvent: (event: OverrideSocketEvent) => void;
  onConnectionChange?: (connected: boolean) => void;
};

/**
 * Hook kết nối Socket.io cho admin override voting (B4).
 * - override:new  → có override request PENDING mới cần biểu quyết
 * - override:resolved → request đã được resolve (APPROVED/REJECTED/EXPIRED)
 * - Polling fallback 30s khi socket disconnect để không miss data
 */
export function useOverrideSocket({ onEvent, onConnectionChange }: UseOverrideSocketOptions): {
  isConnected: boolean;
  isUsingFallback: boolean;
} {
  const socketRef = useRef<Socket | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const onEventRef = useRef(onEvent);
  const onConnectionChangeRef = useRef(onConnectionChange);
  const [isConnected, setIsConnected] = useState(false);
  const [isUsingFallback, setIsUsingFallback] = useState(false);

  // Giữ callback refs mới nhất tránh stale closure — không trigger reconnect
  useEffect(() => { onEventRef.current = onEvent; }, [onEvent]);
  useEffect(() => { onConnectionChangeRef.current = onConnectionChange; }, [onConnectionChange]);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    setIsUsingFallback(false);
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
      if (!pollTimerRef.current) {
        setIsUsingFallback(true);
        pollTimerRef.current = setInterval(() => {
          onEventRef.current({
            type: 'override:new',
            overrideRequestId: '__poll__',
            projectId: '',
            reason: '',
            timestamp: new Date().toISOString()
          });
        }, 30_000);
      }
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
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return { isConnected, isUsingFallback };
}
