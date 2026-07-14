'use client';

// =============================================================================
// useTransparencyTimeline — D4: TanStack Query hook fetch dòng tiền hợp nhất
// theo projectId, dùng useInfiniteQuery để khớp cơ chế cursor-based của backend D1.
// Endpoint PUBLIC nên KHÔNG gắn Authorization header. Validate shape tại ranh giới.
// =============================================================================

import { useInfiniteQuery } from '@tanstack/react-query';
import { buildApiUrl, fetchApi, type ApiErrorResponse } from '@/app/utils/apiClient';
import type { UnifiedTimelineResponse } from '@/app/components/transparency/types';
import { parseUnifiedTimeline } from '@/app/components/transparency/parseResponse';

/** Số sự kiện tối đa mỗi trang — khớp giới hạn MAX_PAGE_SIZE=50 của backend. */
const TIMELINE_PAGE_SIZE = 50;

/**
 * Gọi GET /api/transparency/unified-timeline cho một trang.
 * Backend trả raw object {timeline, ...} (KHÔNG bọc {success, data}),
 * nên validate + chuẩn hóa res qua parseUnifiedTimeline thay vì đọc res.data.
 *
 * @param projectId ID dự án cần xem dòng tiền
 * @param cursor Con trỏ keyset cho trang tiếp theo (undefined cho trang đầu)
 */
async function fetchTimelinePage(
  projectId: string,
  cursor?: string
): Promise<UnifiedTimelineResponse> {
  const searchParams = new URLSearchParams();
  searchParams.set('projectId', projectId);
  searchParams.set('pageSize', String(TIMELINE_PAGE_SIZE));
  if (cursor) {
    searchParams.set('cursor', cursor);
  }

  const res = await fetchApi<unknown>(
    buildApiUrl(`/api/transparency/unified-timeline?${searchParams.toString()}`),
    { method: 'GET', cache: 'no-store' }
  );

  // Envelope nằm ở chính res (không phải res.data) vì endpoint trả raw object → validate shape.
  return parseUnifiedTimeline(res);
}

/**
 * Hook lấy dòng tiền hợp nhất của một dự án với phân trang "Xem thêm".
 * Disabled khi chưa chọn dự án (projectId undefined/rỗng) → trang hiển thị hướng dẫn chọn dự án.
 *
 * @param projectId ID dự án đang chọn; undefined khi chưa chọn
 */
export function useTransparencyTimeline(projectId: string | undefined) {
  return useInfiniteQuery<UnifiedTimelineResponse, ApiErrorResponse>({
    queryKey: ['transparencyTimeline', projectId],
    queryFn: ({ pageParam }) => fetchTimelinePage(projectId as string, pageParam as string | undefined),
    initialPageParam: undefined as string | undefined,
    // nextCursor === null nghĩa là đã hết trang → dừng fetchNextPage
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: Boolean(projectId),
    staleTime: 2 * 60 * 1000,
    retry: (failureCount, error) => {
      // Không retry lỗi client 4xx (vd 400 do projectId sai) — chỉ retry lỗi tạm thời
      if (error?.statusCode && error.statusCode >= 400 && error.statusCode < 500) return false;
      return failureCount < 1;
    }
  });
}
