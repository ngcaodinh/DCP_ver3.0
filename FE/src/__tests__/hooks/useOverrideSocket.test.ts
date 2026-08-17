/**
 * Tests cho useOverrideSocket — gate enablePolling, OVERRIDE_POLLING_SIGNAL_ID,
 * fallback interval, auto-reconnect dừng retry khi UNAUTHORIZED.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Mock socket.io-client trước khi import hook
const eventHandlers: Record<string, Array<(payload: unknown) => void>> = {};
const mockSocketInstance = {
  on: vi.fn((event: string, handler: (payload: unknown) => void) => {
    if (!eventHandlers[event]) {
      eventHandlers[event] = [];
    }
    eventHandlers[event].push(handler);
  }),
  disconnect: vi.fn(),
  emit: vi.fn()
};

vi.mock('socket.io-client', () => ({
  io: vi.fn(() => mockSocketInstance)
}));

vi.mock('@/app/utils/authSession', () => ({
  readAuthSession: vi.fn()
}));

import { readAuthSession } from '@/app/utils/authSession';
import { useOverrideSocket } from '@/app/hooks/useOverrideSocket';
import { OVERRIDE_POLLING_SIGNAL_ID } from '@/app/components/systemAdmin/tailwind/overrideVoting.types';

describe('useOverrideSocket', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    Object.keys(eventHandlers).forEach((k) => delete eventHandlers[k]);
    vi.mocked(readAuthSession).mockReturnValue({
      accessToken: 'mock-token',
      userId: 'admin-1',
      userRole: 'admin'
    } as never);
    // [Determinism] Mock Math.random để tránh jitter ±5s làm timer fire sai thời điểm.
    // Hook dùng Math.random() để chống thundering herd ở production — không phù hợp test.
    // Trả 0.5 → jitter = 0 → interval chính xác = pollingIntervalMs.
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.mocked(Math.random).mockRestore();
  });

  it('enablePolling=false: KHÔNG gọi onEvent với OVERRIDE_POLLING_SIGNAL_ID khi socket ngắt', () => {
    const onEvent = vi.fn();
    renderHook(() =>
      useOverrideSocket({ onEvent, enablePolling: false })
    );

    // Trigger disconnect
    const disconnectHandlers = eventHandlers['disconnect'] ?? [];
    expect(disconnectHandlers.length).toBeGreaterThan(0);
    act(() => {
      disconnectHandlers.forEach((h) => h(new Error('transport close')));
    });

    // Advance timer by 30s — polling interval KHÔNG được set vì enablePolling=false
    act(() => {
      vi.advanceTimersByTime(31_000);
    });

    // onEvent KHÔNG được gọi với polling signal
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('enablePolling=true: gọi onEvent với OVERRIDE_POLLING_SIGNAL_ID mỗi 30s khi disconnected', () => {
    const onEvent = vi.fn();
    renderHook(() =>
      useOverrideSocket({ onEvent, enablePolling: true, pollingIntervalMs: 30_000 })
    );

    const disconnectHandlers = eventHandlers['disconnect'] ?? [];
    act(() => {
      disconnectHandlers.forEach((h) => h(new Error('transport close')));
    });

    // Trigger interval 1 lần
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'override:new',
        overrideRequestId: OVERRIDE_POLLING_SIGNAL_ID
      })
    );

    onEvent.mockClear();
    // Trigger interval lần 2
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ overrideRequestId: OVERRIDE_POLLING_SIGNAL_ID })
    );
  });

  it('dừng interval khi enablePolling chuyển từ true sang false', () => {
    const onEvent = vi.fn();
    const { rerender } = renderHook(
      ({ enabled }) => useOverrideSocket({ onEvent, enablePolling: enabled }),
      { initialProps: { enabled: true } }
    );

    const disconnectHandlers = eventHandlers['disconnect'] ?? [];
    act(() => {
      disconnectHandlers.forEach((h) => h(new Error('transport close')));
      vi.advanceTimersByTime(30_000);
    });
    expect(onEvent).toHaveBeenCalledTimes(1);

    onEvent.mockClear();
    rerender({ enabled: false });
    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    expect(onEvent).not.toHaveBeenCalled();
  });

  it('reconnect: polling interval bị dừng khi socket connect lại', () => {
    const onEvent = vi.fn();
    renderHook(() => useOverrideSocket({ onEvent, enablePolling: true }));

    // Disconnect → bật polling
    const disconnectHandlers = eventHandlers['disconnect'] ?? [];
    act(() => {
      disconnectHandlers.forEach((h) => h(new Error('transport close')));
    });

    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    const callsAfterDisconnect = onEvent.mock.calls.length;
    expect(callsAfterDisconnect).toBeGreaterThanOrEqual(1);

    // Connect lại → polling bị stop
    const connectHandlers = eventHandlers['connect'] ?? [];
    act(() => {
      connectHandlers.forEach((h) => h(undefined));
    });

    onEvent.mockClear();
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    // KHÔNG còn poll event sau khi reconnect
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('override:new event từ server được forward trực tiếp tới onEvent (không qua polling)', () => {
    const onEvent = vi.fn();
    renderHook(() => useOverrideSocket({ onEvent, enablePolling: false }));

    const newHandlers = eventHandlers['override:new'] ?? [];
    act(() => {
      newHandlers.forEach((h) => h({
        overrideRequestId: 'real-req-123',
        projectId: 'proj-001',
        reason: 'OUT_OF_GEOFENCE',
        timestamp: '2026-07-10T12:00:00.000Z'
      }));
    });

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'override:new',
        overrideRequestId: 'real-req-123',
        projectId: 'proj-001'
      })
    );
  });

  it('UNAUTHORIZED kết nối lỗi → socket.disconnect được gọi để dừng retry vô hạn', () => {
    const onEvent = vi.fn();
    renderHook(() => useOverrideSocket({ onEvent, enablePolling: true }));

    const errorHandlers = eventHandlers['connect_error'] ?? [];
    act(() => {
      errorHandlers.forEach((h) => h(new Error('UNAUTHORIZED') as Error));
    });

    expect(mockSocketInstance.disconnect).toHaveBeenCalled();
  });
});
