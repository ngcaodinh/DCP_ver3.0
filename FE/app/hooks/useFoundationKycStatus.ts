'use client';

import { useQuery } from '@tanstack/react-query';
import { buildApiUrl, fetchApi, type ApiErrorResponse } from '@/app/utils/apiClient';

export type FoundationKycPublicStatus = {
  status: 'VERIFIED' | 'NOT_VERIFIED';
  verifiedAt: string | null;
  organizationName: string | null;
};

/** Gọi endpoint status public và chỉ nhận DTO ba trường từ backend. */
async function fetchFoundationKycStatus(): Promise<FoundationKycPublicStatus> {
  const response = await fetchApi<FoundationKycPublicStatus>(
    buildApiUrl('/api/transparency/foundation-kyc-status'),
    { method: 'GET', cache: 'no-store' }
  );
  return response.data;
}

/** Hook cache status FOUNDATION ngắn hạn để badge không tạo request theo mỗi component render. */
export function useFoundationKycStatus() {
  return useQuery<FoundationKycPublicStatus, ApiErrorResponse>({
    queryKey: ['foundationKycStatus'],
    queryFn: fetchFoundationKycStatus,
    staleTime: 5 * 60 * 1000,
    retry: false
  });
}

