'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { normalizeImpactSbtGalleryPage, SBT_GALLERY_PAGE_SIZE } from '@/app/constants/impactSbtGallery';
import type { ImpactSbtGalleryResponse } from '@/app/types/impactSbt';
import { buildApiUrl, fetchApi, type ApiErrorResponse } from '@/app/utils/apiClient';

/** Dựng path gallery duy nhất cho cả chế độ toàn cục và lọc theo project. */
export function buildGalleryUrl(page: number, projectId?: string): string {
  const queryParts = [
    `page=${normalizeImpactSbtGalleryPage(page)}`,
    `limit=${SBT_GALLERY_PAGE_SIZE}`
  ];
  if (projectId) {
    queryParts.push(`projectId=${encodeURIComponent(projectId)}`);
  }

  return `/api/sbt/gallery?${queryParts.join('&')}`;
}

/** Tải một trang gallery qua envelope API chuẩn và giữ nguyên chuỗi confirmedAt từ JSON. */
async function fetchImpactSbtGallery(page: number, projectId?: string): Promise<ImpactSbtGalleryResponse> {
  const response = await fetchApi<ImpactSbtGalleryResponse>(
    buildApiUrl(buildGalleryUrl(page, projectId)),
    { method: 'GET', cache: 'no-store' }
  );
  return response.data;
}

/** Hook quản lý dữ liệu gallery SBT, cache 60 giây và giữ trang trước khi đổi pagination. */
export function useImpactSbtGallery(projectId?: string, page = 1) {
  const normalizedProjectId = projectId?.trim() || undefined;
  const normalizedPage = normalizeImpactSbtGalleryPage(page);

  return useQuery<ImpactSbtGalleryResponse, ApiErrorResponse>({
    queryKey: ['impactSbtGallery', { projectId: normalizedProjectId, page: normalizedPage }],
    queryFn: () => fetchImpactSbtGallery(normalizedPage, normalizedProjectId),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    retry: (failureCount, error) => {
      // Không retry lỗi 4xx, đặc biệt 429, vì retry tự động chỉ làm tăng rate-limit pressure.
      if (error?.statusCode && error.statusCode >= 400 && error.statusCode < 500) {
        return false;
      }
      return failureCount < 1;
    }
  });
}
