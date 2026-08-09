import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTransferSocket } from '@/app/hooks/useTransferSocket';
import { readAuthSession } from '@/app/utils/authSession';
import { io } from 'socket.io-client';

const eventHandlers: Record<string, Array<(payload?: unknown) => void>> = {};
const mockSocket = {
  on: vi.fn((event: string, handler: (payload?: unknown) => void) => {
    eventHandlers[event] ??= [];
    eventHandlers[event].push(handler);
  }),
  disconnect: vi.fn()
};

vi.mock('socket.io-client', () => ({
  io: vi.fn(() => mockSocket)
}));

vi.mock('@/app/utils/authSession', () => ({
  readAuthSession: vi.fn()
}));

/** Phát một event tới toàn bộ listener mock giống Socket.io server. */
function emitSocketEvent(event: string, payload?: unknown) {
  eventHandlers[event]?.forEach((handler) => handler(payload));
}

describe('useTransferSocket', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    Object.keys(eventHandlers).forEach((event) => delete eventHandlers[event]);
    vi.mocked(readAuthSession).mockReturnValue({ accessToken: 'admin-token' });
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  });

  it('bật polling fallback dù socket chưa từng connect và dừng timer khi tab nền', () => {
    const onPollTick = vi.fn();
    const { result } = renderHook(() => useTransferSocket({ onEvent: vi.fn(), onPollTick }));

    act(() => vi.advanceTimersByTime(5_000));
    expect(result.current.isUsingFallback).toBe(true);

    act(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    act(() => vi.advanceTimersByTime(30_000));
    expect(onPollTick).not.toHaveBeenCalled();

    act(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: false });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    act(() => vi.advanceTimersByTime(30_000));
    expect(onPollTick).toHaveBeenCalledTimes(1);
  });

  it('auth socket fail vẫn fallback nhưng không reconnect vô hạn', () => {
    const { result } = renderHook(() => useTransferSocket({ onEvent: vi.fn(), onPollTick: vi.fn() }));

    act(() => emitSocketEvent('connect_error', new Error('UNAUTHORIZED')));
    expect(mockSocket.disconnect).toHaveBeenCalled();
    expect(result.current.isUsingFallback).toBe(true);
  });

  it('đóng socket khi auth bị FORBIDDEN và vẫn giữ fallback cho list', () => {
    const { result } = renderHook(() => useTransferSocket({ onEvent: vi.fn(), onPollTick: vi.fn() }));

    act(() => emitSocketEvent('connect_error', new Error('FORBIDDEN')));
    expect(mockSocket.disconnect).toHaveBeenCalledTimes(1);
    expect(result.current.isUsingFallback).toBe(true);
  });

  it('dedup queueId, surface escalation và refetch đúng một lần sau reconnect', () => {
    const onEvent = vi.fn();
    const onReconnect = vi.fn();
    renderHook(() => useTransferSocket({ onEvent, onReconnect }));

    act(() => emitSocketEvent('connect'));
    act(() => emitSocketEvent('disconnect'));
    act(() => emitSocketEvent('connect'));
    expect(onReconnect).toHaveBeenCalledTimes(1);

    const payload = { requestId: 'DS-001', queueId: 'MRQ-001', updatedAt: '2026-08-08T00:00:00.000Z' };
    act(() => {
      emitSocketEvent('transfer:updated', payload);
      emitSocketEvent('transfer:updated', payload);
      emitSocketEvent('transfer:escalation-alert', { requestId: 'DS-001', queueId: 'MRQ-001', timestamp: payload.updatedAt });
    });

    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'transfer:escalation-alert', queueId: 'MRQ-001' }));
  });

  it('không có session token vẫn bật fallback và cleanup timer khi unmount', () => {
    vi.mocked(readAuthSession).mockReturnValue({ accessToken: '' });
    const onPollTick = vi.fn();
    const { result, unmount } = renderHook(() => useTransferSocket({ onEvent: vi.fn(), onPollTick }));

    expect(result.current.isUsingFallback).toBe(true);
    unmount();
    act(() => vi.advanceTimersByTime(30_000));
    expect(onPollTick).not.toHaveBeenCalled();
  });

  it('uses polling when the socket API base URL is missing without opening a socket', () => {
    const previousApiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL;
    delete process.env.NEXT_PUBLIC_API_BASE_URL;

    try {
      const { result, unmount } = renderHook(() => useTransferSocket({ onEvent: vi.fn(), onPollTick: vi.fn() }));

      expect(io).not.toHaveBeenCalled();
      expect(result.current.isUsingFallback).toBe(true);
      unmount();
    } finally {
      if (previousApiBaseUrl === undefined) delete process.env.NEXT_PUBLIC_API_BASE_URL;
      else process.env.NEXT_PUBLIC_API_BASE_URL = previousApiBaseUrl;
    }
  });

  it('disconnect socket khi unmount sau khi đã kết nối và không để polling chạy tiếp', () => {
    const onPollTick = vi.fn();
    const { unmount } = renderHook(() => useTransferSocket({ onEvent: vi.fn(), onPollTick }));

    act(() => emitSocketEvent('connect_error', new Error('temporary network error')));
    unmount();
    expect(mockSocket.disconnect).toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(30_000));
    expect(onPollTick).not.toHaveBeenCalled();
  });

  it('cho phép cùng event xuất hiện lại sau khi hết dedup window', () => {
    const onEvent = vi.fn();
    renderHook(() => useTransferSocket({ onEvent }));
    const payload = { requestId: 'DS-001', queueId: 'MRQ-001', updatedAt: '2026-08-08T00:00:00.000Z' };

    act(() => emitSocketEvent('transfer:updated', payload));
    act(() => emitSocketEvent('transfer:updated', payload));
    expect(onEvent).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date(Date.now() + 15_001));
    act(() => emitSocketEvent('transfer:updated', payload));
    expect(onEvent).toHaveBeenCalledTimes(2);
  });
});
