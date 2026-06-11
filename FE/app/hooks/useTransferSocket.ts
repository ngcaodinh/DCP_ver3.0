'use client';

// =============================================================================
// useTransferSocket — A4: Real-time Socket.io hook cho Admin Transfer page
// Kết nối admin room, lắng nghe transfer events, tự reconnect,
// polling fallback 30s nếu socket ngắt kết nối.
// =============================================================================

import { useEffect, useRef, useCallback, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { readAuthSession } from '@/app/utils/authSession';

export type TransferSocketEvent =
  | { type: 'transfer:manual-review-required'; requestId: string; projectId: string; amount: number; requestMode?: string; timestamp: string }
  | { type: 'transfer:updated'; requestId: string; payosTransferStatus?: string; status?: string; updatedAt: string };

type UseTransferSocketOptions = {
  onEvent: (event: TransferSocketEvent) => void;
  /** Callback khi socket connected/disconnected — để FE hiển thị trạng thái kết nối */
  onConnectionChange?: (connected: boolean) => void;
};

/**
 * Hook quản lý kết nối Socket.io cho trang admin transfers.
 * - Tự động reconnect với exponential backoff (socket.io-client built-in)
 * - Polling fallback 30s khi socket ngắt để không miss data
 * - Cleanup đầy đủ khi unmount
 */
export function useTransferSocket({ onEvent, onConnectionChange }: UseTransferSocketOptions): {
  isConnected: boolean;
  isUsingFallback: boolean;
} {
  const socketRef = useRef<Socket | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const onEventRef = useRef(onEvent);
  const onConnectionChangeRef = useRef(onConnectionChange);
  const [isConnected, setIsConnected] = useState(false);
  const [isUsingFallback, setIsUsingFallback] = useState(false);

  // Giữ callback refs mới nhất tránh stale closure
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
      // Reconnect tự động với backoff — socket.io-client default
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
      // Bật polling fallback 30s khi socket disconnect
      if (!pollTimerRef.current) {
        setIsUsingFallback(true);
        pollTimerRef.current = setInterval(() => {
          // Signal cho component cha poll lại data
          onEventRef.current({ type: 'transfer:updated', requestId: '__poll__', updatedAt: new Date().toISOString() });
        }, 30_000);
      }
    });

    socket.on('transfer:manual-review-required', (data: Omit<TransferSocketEvent & { type: 'transfer:manual-review-required' }, 'type'>) => {
      onEventRef.current({ type: 'transfer:manual-review-required', ...data });
    });

    socket.on('transfer:updated', (data: Omit<TransferSocketEvent & { type: 'transfer:updated' }, 'type'>) => {
      onEventRef.current({ type: 'transfer:updated', ...data });
    });

    socket.on('connect_error', (err) => {
      // Lỗi auth (UNAUTHORIZED/FORBIDDEN) → không retry vô hạn
      if (err.message === 'UNAUTHORIZED' || err.message === 'FORBIDDEN') {
        socket.disconnect();
      }
    });

    return () => {
      stopPolling();
      socket.disconnect();
      socketRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps — chỉ mount một lần

  return { isConnected, isUsingFallback };
}
