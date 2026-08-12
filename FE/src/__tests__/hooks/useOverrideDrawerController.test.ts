/**
 * Integration tests cho useOverrideDrawerController — B4.
 * Kiểm tra 4 paths quan trọng: polling signal, open drawer, deduplication, resolved sync.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { OVERRIDE_POLLING_SIGNAL_ID } from '@/app/components/systemAdmin/tailwind/overrideVoting.types';

// ─── Mock useOverrideSocket trước khi import hook ─────────────────────────────

let capturedOnEvent: ((event: import('@/app/hooks/useOverrideSocket').OverrideSocketEvent) => void) | null = null;

vi.mock('@/app/hooks/useOverrideSocket', () => ({
  useOverrideSocket: vi.fn((options: { onEvent: (e: unknown) => void; enablePolling: boolean }) => {
    // Lưu lại onEvent để test có thể gọi trực tiếp
    capturedOnEvent = options.onEvent as never;
    return { isConnected: true, isUsingFallback: false };
  })
}));

import { useOverrideDrawerController } from '@/app/hooks/useOverrideDrawerController';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Tạo mock callbacks cho UseOverrideDrawerControllerOptions.
 */
function buildCallbacks() {
  return {
    onOpenDrawer: vi.fn(),
    onToast: vi.fn(),
    onSyncCount: vi.fn()
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('useOverrideDrawerController', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedOnEvent = null;
  });

  it('[T1a] OVERRIDE_POLLING_SIGNAL_ID → gọi onSyncCount, KHÔNG gọi onOpenDrawer', () => {
    const { onOpenDrawer, onToast, onSyncCount } = buildCallbacks();

    renderHook(() =>
      useOverrideDrawerController({
        isDrawerOpen: true,
        onOpenDrawer,
        onToast,
        onSyncCount
      })
    );

    // Giả lập socket gửi polling signal (fallback interval)
    act(() => {
      capturedOnEvent?.({
        type: 'override:new',
        overrideRequestId: OVERRIDE_POLLING_SIGNAL_ID,
        projectId: '__poll__',
        reason: 'OUT_OF_GEOFENCE',
        timestamp: new Date().toISOString()
      });
    });

    expect(onSyncCount).toHaveBeenCalledTimes(1);
    // Polling signal KHÔNG được mở drawer hay hiển thị toast
    expect(onOpenDrawer).not.toHaveBeenCalled();
    expect(onToast).not.toHaveBeenCalled();
  });

  it('[T1b] Real overrideRequestId mới → gọi onOpenDrawer VÀ onToast', () => {
    const { onOpenDrawer, onToast, onSyncCount } = buildCallbacks();

    renderHook(() =>
      useOverrideDrawerController({
        isDrawerOpen: false,
        onOpenDrawer,
        onToast,
        onSyncCount
      })
    );

    act(() => {
      capturedOnEvent?.({
        type: 'override:new',
        overrideRequestId: 'real-req-abc123',
        projectId: 'proj-001',
        reason: 'OUT_OF_GEOFENCE',
        timestamp: new Date().toISOString()
      });
    });

    expect(onOpenDrawer).toHaveBeenCalledWith('real-req-abc123');
    expect(onToast).toHaveBeenCalledWith(
      expect.objectContaining({ tone: 'info' })
    );
    // Không phải polling signal → không gọi onSyncCount
    expect(onSyncCount).not.toHaveBeenCalled();
  });

  it('[T1c] Duplicate overrideRequestId → bị skip hoàn toàn (deduplication)', () => {
    const { onOpenDrawer, onToast, onSyncCount } = buildCallbacks();

    renderHook(() =>
      useOverrideDrawerController({
        isDrawerOpen: false,
        onOpenDrawer,
        onToast,
        onSyncCount
      })
    );

    const sameEvent = {
      type: 'override:new' as const,
      overrideRequestId: 'req-dedupe-001',
      projectId: 'proj-002',
      reason: 'GPS_EXIF_MISSING' as const,
      timestamp: new Date().toISOString()
    };

    // Lần 1 — phải được xử lý
    act(() => { capturedOnEvent?.(sameEvent); });
    // Lần 2 — duplicate từ socket reconnect → phải bị skip
    act(() => { capturedOnEvent?.(sameEvent); });
    // Lần 3 — vẫn duplicate
    act(() => { capturedOnEvent?.(sameEvent); });

    // Chỉ xử lý 1 lần duy nhất
    expect(onOpenDrawer).toHaveBeenCalledTimes(1);
    expect(onToast).toHaveBeenCalledTimes(1);
  });

  it('[T1d] override:resolved event → gọi onSyncCount, KHÔNG gọi onOpenDrawer', () => {
    const { onOpenDrawer, onToast, onSyncCount } = buildCallbacks();

    renderHook(() =>
      useOverrideDrawerController({
        isDrawerOpen: false,
        onOpenDrawer,
        onToast,
        onSyncCount
      })
    );

    act(() => {
      capturedOnEvent?.({
        type: 'override:resolved',
        overrideRequestId: 'req-resolved-789',
        status: 'APPROVED',
        timestamp: new Date().toISOString()
      });
    });

    expect(onSyncCount).toHaveBeenCalledTimes(1);
    expect(onOpenDrawer).not.toHaveBeenCalled();
    expect(onToast).not.toHaveBeenCalled();
  });

  it('[T1e] Set vượt MAX_PROCESSED_OVERRIDE_IDS (100) → trim về 50 gần nhất, ID cũ hết dedupe', () => {
    const { onOpenDrawer, onToast, onSyncCount } = buildCallbacks();

    renderHook(() =>
      useOverrideDrawerController({
        isDrawerOpen: false,
        onOpenDrawer,
        onToast,
        onSyncCount
      })
    );

    const buildEvent = (id: string) => ({
      type: 'override:new' as const,
      overrideRequestId: id,
      projectId: 'proj-trim',
      reason: 'OUT_OF_GEOFENCE' as const,
      timestamp: new Date().toISOString()
    });

    // Đẩy 101 ID khác nhau (id-0 .. id-100) để vượt ngưỡng trim (100)
    act(() => {
      for (let i = 0; i <= 100; i += 1) {
        capturedOnEvent?.(buildEvent(`id-${i}`));
      }
    });
    // Tất cả 101 event đều là ID mới lần đầu → phải mở drawer 101 lần
    expect(onOpenDrawer).toHaveBeenCalledTimes(101);

    onOpenDrawer.mockClear();

    // id-0 đã bị trim khỏi Set (chỉ giữ 50 ID gần nhất: id-51..id-100)
    // → gửi lại id-0 phải được xử lý như ID MỚI (mở drawer lần nữa)
    act(() => {
      capturedOnEvent?.(buildEvent('id-0'));
    });
    expect(onOpenDrawer).toHaveBeenCalledWith('id-0');
    expect(onOpenDrawer).toHaveBeenCalledTimes(1);

    onOpenDrawer.mockClear();

    // id-100 (gần nhất, còn trong 50 ID được giữ) → phải vẫn bị dedupe (KHÔNG mở lại)
    act(() => {
      capturedOnEvent?.(buildEvent('id-100'));
    });
    expect(onOpenDrawer).not.toHaveBeenCalled();
  });
});
