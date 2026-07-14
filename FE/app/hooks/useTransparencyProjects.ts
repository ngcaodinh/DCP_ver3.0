'use client';

// =============================================================================
// useTransparencyProjects — D4: TanStack Query hook tải danh sách dự án cho
// bộ chọn dự án trên trang /transparency. Dùng GET /donations/campaigns
// (endpoint bọc chuẩn {success, data}) nên đọc res.data như các caller khác.
// Tách riêng khỏi component để đồng bộ layer data-fetching với timeline/summary.
// =============================================================================

import { useQuery } from '@tanstack/react-query';
import { buildApiUrl, fetchApi, type ApiErrorResponse } from '@/app/utils/apiClient';
import type { TransparencyProjectOption } from '@/app/components/transparency/types';

/** Số dự án tối đa nạp cho bộ chọn — giới hạn cứng để tránh payload lớn. */
const PROJECT_OPTIONS_LIMIT = 100;

/** Cấu trúc campaign trả về từ GET /donations/campaigns (chỉ lấy trường cần cho selector). */
interface DonationCampaignItem {
  projectId: string;
  name: string;
}

/**
 * Gọi GET /donations/campaigns và ánh xạ về danh sách lựa chọn dự án.
 * Endpoint này bọc chuẩn {success, data} nên đọc res.data (khác các endpoint transparency).
 */
async function fetchProjectOptions(): Promise<TransparencyProjectOption[]> {
  const res = await fetchApi<DonationCampaignItem[]>(
    buildApiUrl(`/donations/campaigns?limit=${PROJECT_OPTIONS_LIMIT}`),
    { method: 'GET', cache: 'no-store' }
  );
  return (res.data ?? []).map((item) => ({ projectId: item.projectId, name: item.name }));
}

/**
 * Hook tải danh sách dự án cho dropdown chọn dự án của Transparency Dashboard.
 * staleTime 5 phút vì danh mục dự án ít thay đổi trong một phiên xem.
 */
export function useTransparencyProjects() {
  return useQuery<TransparencyProjectOption[], ApiErrorResponse>({
    queryKey: ['transparencyProjects'],
    queryFn: fetchProjectOptions,
    staleTime: 5 * 60 * 1000,
    retry: (failureCount, error) => {
      // Không retry lỗi client 4xx — chỉ retry lỗi tạm thời (mạng/5xx)
      if (error?.statusCode && error.statusCode >= 400 && error.statusCode < 500) return false;
      return failureCount < 1;
    }
  });
}
