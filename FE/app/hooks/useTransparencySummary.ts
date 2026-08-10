'use client';

// =============================================================================
// useTransparencySummary — D4: TanStack Query hook fetch tổng hợp dòng tiền
// của một dự án (GET /api/transparency/summary/:projectId).
// Endpoint PUBLIC, luôn trả 200 (project rỗng → giá trị 0) nên không cần auth header.
// =============================================================================

import { useQuery } from '@tanstack/react-query';
import { buildApiUrl, fetchApi, type ApiErrorResponse } from '@/app/utils/apiClient';
import type { ProjectSummary } from '@/app/components/transparency/types';
import { parseProjectSummary } from '@/app/components/transparency/parseResponse';

/** Chu kỳ đọc lại dashboard để phản ánh dữ liệu sau mỗi lần data mapper sync. */
const TRANSPARENCY_REFRESH_INTERVAL_MS = 30_000;

/**
 * Gọi GET /api/transparency/summary/:projectId.
 * Backend trả raw object (KHÔNG bọc {success, data}) nên validate + chuẩn hóa res
 * qua parseProjectSummary thay vì đọc res.data (res.data sẽ là undefined).
 *
 * @param projectId ID dự án cần tổng hợp
 */
async function fetchProjectSummary(projectId: string): Promise<ProjectSummary> {
  const res = await fetchApi<unknown>(
    buildApiUrl(`/api/transparency/summary/${encodeURIComponent(projectId)}`),
    { method: 'GET', cache: 'no-store' }
  );

  // Envelope nằm ở chính res vì endpoint trả raw object → validate shape tại ranh giới.
  return parseProjectSummary(res);
}

/**
 * Hook lấy tổng hợp dòng tiền của một dự án cho DonutChart + số liệu.
 * staleTime 5 phút khớp TTL cache backend (dashboard chấp nhận eventual consistency).
 * Disabled khi chưa chọn dự án.
 *
 * @param projectId ID dự án đang chọn; undefined khi chưa chọn
 */
export function useTransparencySummary(projectId: string | undefined) {
  return useQuery<ProjectSummary, ApiErrorResponse>({
    queryKey: ['transparencySummary', projectId],
    queryFn: () => fetchProjectSummary(projectId as string),
    enabled: Boolean(projectId),
    staleTime: 5 * 60 * 1000,
    refetchInterval: TRANSPARENCY_REFRESH_INTERVAL_MS,
    refetchIntervalInBackground: false,
    retry: (failureCount, error) => {
      if (error?.statusCode && error.statusCode >= 400 && error.statusCode < 500) return false;
      return failureCount < 1;
    }
  });
}
