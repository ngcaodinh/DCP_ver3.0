/**
 * ⚠️ NGỪNG SỬ DỤNG từ 2026-08-27 — chức năng ghi đè GPS đã khai tử.
 * Lý do: minh chứng nay chụp trực tiếp qua camera nên luôn có tọa độ.
 * Giữ file để đọc lại dữ liệu lịch sử. Xem ADR-2026-08-27.
 */
'use client';

// =============================================================================
// useOverrideDrawerController — B4: Bộ điều khiển drawer ghi đè GPS dùng chung
// Tách logic socket + đã xử lý (Set dedupe) + mở drawer + sync badge ra khỏi
// AdminPage và RegulatoryPage để tránh trùng lặp (review-B4-fix #1).
// =============================================================================

import { useCallback, useRef } from 'react';
import { useOverrideSocket, type OverrideSocketEvent } from '@/app/hooks/useOverrideSocket';
import { OVERRIDE_POLLING_SIGNAL_ID } from '@/app/components/systemAdmin/tailwind/overrideVoting.types';

/** Số lượng tối đa ID được giữ trong Set chống trùng để tránh phình to vô hạn. */
const MAX_PROCESSED_OVERRIDE_IDS = 100;

/** Số lượng ID được giữ lại sau khi trim để cân bằng giữa memory và độ bao phủ. */
const TRIMMED_PROCESSED_OVERRIDE_IDS = 50;

/** Tone của toast phù hợp với cả admin và regulatory. */
export type OverrideDrawerToastTone = 'info' | 'success' | 'warning' | 'error';

/** Payload toast truyền cho caller render qua hệ thống toast hiện có. */
export type OverrideDrawerToastPayload = {
  titleText: string;
  bodyText: string;
  tone: OverrideDrawerToastTone;
};

export type UseOverrideDrawerControllerOptions = {
  /** Drawer đang mở để gate polling fallback. */
  isDrawerOpen: boolean;
  /** Callback mở drawer với ID override request cụ thể. */
  onOpenDrawer: (overrideRequestId: string) => void;
  /** Callback phát toast khi nhận sự kiện override:new. */
  onToast: (toast: OverrideDrawerToastPayload) => void;
  /** Callback đồng bộ lại cache khi nhận override:resolved. */
  onSyncCount: () => void;
};

/**
 * Hook tập trung xử lý sự kiện socket override ghi đè GPS cho cả Admin và Regulatory.
 * - Duy trì `processedOverrideIdsRef` để chống trùng lặp từ socket reconnect.
 * - Lắng nghe `override:new` (mở drawer + toast) và `override:resolved` (sync badge).
 * - Polling fallback chỉ chạy khi drawer đang mở (gate qua `isDrawerOpen`).
 *
 * @param options Cấu hình callbacks (isDrawerOpen, onOpenDrawer, onToast, onSyncCount).
 * @returns Trạng thái kết nối socket: `isSocketConnected` và `isUsingFallback`.
 */
export function useOverrideDrawerController({
  isDrawerOpen,
  onOpenDrawer,
  onToast,
  onSyncCount
}: UseOverrideDrawerControllerOptions): {
  isSocketConnected: boolean;
  isUsingFallback: boolean;
} {
  /** Set các overrideRequestId đã xử lý để chống drawer/toast trùng lặp khi reconnect. */
  const processedOverrideIdsRef = useRef<Set<string>>(new Set());

  /** Hàm xử lý sự kiện socket — đóng gói để truyền cho useOverrideSocket. */
  const handleOverrideEvent = useCallback(
    (event: OverrideSocketEvent) => {
      if (event.type === 'override:new') {
        // Polling signal từ fallback interval — không mở drawer, chỉ sync badge cache.
        if (event.overrideRequestId === OVERRIDE_POLLING_SIGNAL_ID) {
          onSyncCount();
          return;
        }
        // Skip nếu đã xử lý request này rồi (tránh duplicate từ socket reconnect).
        if (processedOverrideIdsRef.current.has(event.overrideRequestId)) {
          return;
        }
        processedOverrideIdsRef.current.add(event.overrideRequestId);
        // Trim Set khi vượt ngưỡng để tránh phình to vô hạn.
        if (processedOverrideIdsRef.current.size > MAX_PROCESSED_OVERRIDE_IDS) {
          processedOverrideIdsRef.current = new Set(
            Array.from(processedOverrideIdsRef.current).slice(-TRIMMED_PROCESSED_OVERRIDE_IDS)
          );
        }
        onOpenDrawer(event.overrideRequestId);
        onToast({
          titleText: 'Yêu cầu ghi đè GPS mới',
          bodyText: `Dự án ${event.projectId} cần biểu quyết.`,
          tone: 'info'
        });
        return;
      }
      if (event.type === 'override:resolved') {
        // Sync badge từ cache TanStack Query thay vì optimistic decrement.
        onSyncCount();
      }
    },
    [onOpenDrawer, onSyncCount, onToast]
  );

  const { isConnected: isSocketConnected, isUsingFallback } = useOverrideSocket({
    onEvent: handleOverrideEvent,
    enablePolling: isDrawerOpen
  });

  return { isSocketConnected, isUsingFallback };
}
