import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useNotificationPolling } from '@/app/hooks/useNotificationPolling';

describe('useNotificationPolling REST fallback', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  });

  it('dọn interval 30 giây khi unmount lúc polling vẫn đang hoạt động', async () => {
    const refetchNotifications = vi.fn(() => Promise.resolve());
    const { unmount } = renderHook(() => useNotificationPolling({ refetchNotifications, enabled: true }));

    await act(async () => {
      vi.advanceTimersByTime(30_000);
      await Promise.resolve();
    });
    expect(refetchNotifications).toHaveBeenCalledTimes(1);

    unmount();
    act(() => vi.advanceTimersByTime(30_000));
    expect(refetchNotifications).toHaveBeenCalledTimes(1);
  });

  it('không ép refetch trong năm giây đầu sau lần fetch ban đầu của query', () => {
    const refetchNotifications = vi.fn(() => Promise.resolve());
    renderHook(() => useNotificationPolling({ refetchNotifications, enabled: true }));

    act(() => vi.advanceTimersByTime(5_000));

    expect(refetchNotifications).not.toHaveBeenCalled();
  });

  it('revalidate khi focus nhưng không tạo request concurrent', async () => {
    let resolveRefetch: (() => void) | undefined;
    const refetchNotifications = vi.fn(() => new Promise<void>((resolve) => {
      resolveRefetch = resolve;
    }));
    renderHook(() => useNotificationPolling({ refetchNotifications, enabled: true }));

    act(() => {
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('focus'));
    });
    expect(refetchNotifications).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveRefetch?.();
      await Promise.resolve();
    });
    act(() => window.dispatchEvent(new Event('focus')));
    expect(refetchNotifications).toHaveBeenCalledTimes(2);
  });

  it('giải phóng khóa khi request fallback bị từ chối', async () => {
    const refetchNotifications = vi.fn()
      .mockRejectedValueOnce(new Error('network failure'))
      .mockResolvedValueOnce({});
    renderHook(() => useNotificationPolling({ refetchNotifications, enabled: true }));

    act(() => window.dispatchEvent(new Event('focus')));
    await act(async () => {
      await Promise.resolve();
    });
    act(() => window.dispatchEvent(new Event('focus')));

    expect(refetchNotifications).toHaveBeenCalledTimes(2);
  });

  it('không polling hoặc refetch khi query bị disable do thiếu phiên đăng nhập', () => {
    const refetchNotifications = vi.fn(() => Promise.resolve());
    renderHook(() => useNotificationPolling({ refetchNotifications, enabled: false }));

    act(() => {
      window.dispatchEvent(new Event('focus'));
      vi.advanceTimersByTime(30_000);
    });

    expect(refetchNotifications).not.toHaveBeenCalled();
  });
});
