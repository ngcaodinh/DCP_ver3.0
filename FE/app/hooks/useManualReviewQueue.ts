'use client';

import { keepPreviousData, useQuery, type UseQueryResult } from '@tanstack/react-query';
import { buildApiUrl, fetchApi, type ApiErrorResponse } from '@/app/utils/apiClient';
import { readAuthSession } from '@/app/utils/authSession';
import type {
  ManualReviewQueueError,
  ManualReviewQueueErrorKind,
  ManualReviewQueueCounts,
  ManualReviewQueuePage,
  ManualReviewQueueParams
} from '@/app/types/manualReview';

/** Chuyển lỗi HTTP/network thành union ổn định để UI hiển thị đúng hướng xử lý. */
export function mapManualReviewQueueError(error: unknown): ManualReviewQueueError {
  const apiError = error as Partial<ApiErrorResponse>;
  const statusCode = typeof apiError.statusCode === 'number' ? apiError.statusCode : undefined;
  const kind: ManualReviewQueueErrorKind = statusCode === 401
    ? 'UNAUTHENTICATED'
    : statusCode === 403
      ? 'FORBIDDEN'
      : statusCode === 429
        ? 'RATE_LIMITED'
        : statusCode !== undefined && statusCode >= 400 && statusCode < 500
          ? 'SERVER'
          : statusCode !== undefined && statusCode >= 500
            ? 'SERVER'
            : 'NETWORK';
  const message = typeof apiError.message === 'string'
    ? apiError.message
    : 'Không thể kết nối tới dịch vụ manual review.';

  return Object.assign(new Error(message), {
    kind,
    statusCode,
    errorCode: typeof apiError.errorCode === 'string' ? apiError.errorCode : undefined
  });
}

/** Xây query string theo đúng contract A3, chỉ gửi filter khi tab cần lọc. */
export function buildManualReviewQueueQuery(params: ManualReviewQueueParams): string {
  const searchParams = new URLSearchParams({
    page: String(params.page),
    limit: String(params.limit)
  });
  if (params.requestMode) {
    searchParams.set('requestMode', params.requestMode);
  }
  if (params.overdueOnly) {
    searchParams.set('overdueOnly', 'true');
  }
  return searchParams.toString();
}

/** Tải một trang queue tại thời điểm gọi để luôn lấy access token mới nhất. */
export async function fetchManualReviewQueue(params: ManualReviewQueueParams): Promise<ManualReviewQueuePage> {
  try {
    const session = readAuthSession();
    const response = await fetchApi<ManualReviewQueuePage>(
      buildApiUrl(`/api/disbursements/pending-review?${buildManualReviewQueueQuery(params)}`),
      { headers: { Authorization: `Bearer ${session.accessToken}` } }
    );
    return response.data;
  } catch (error) {
    throw mapManualReviewQueueError(error);
  }
}

/** Lấy counts của bốn tab dashboard bằng endpoint aggregate riêng, không tạo bốn query con. */
export async function fetchManualReviewQueueCounts(): Promise<ManualReviewQueueCounts> {
  try {
    const session = readAuthSession();
    const response = await fetchApi<ManualReviewQueueCounts>(
      buildApiUrl('/api/disbursements/pending-review/counts'),
      { headers: { Authorization: `Bearer ${session.accessToken}` } }
    );
    return response.data;
  } catch (error) {
    throw mapManualReviewQueueError(error);
  }
}

/** Chỉ retry lỗi mạng; lỗi auth, quyền, rate-limit và server cần hiển thị rõ cho admin. */
function shouldRetryManualReviewQueue(failureCount: number, error: ManualReviewQueueError): boolean {
  if (['UNAUTHENTICATED', 'FORBIDDEN', 'RATE_LIMITED', 'SERVER'].includes(error.kind)) {
    return false;
  }
  return failureCount < 1;
}

/** Cung cấp server state queue với giữ dữ liệu cũ khi chuyển trang và retry có kiểm soát. */
export function useManualReviewQueue(
  params: ManualReviewQueueParams
): UseQueryResult<ManualReviewQueuePage, ManualReviewQueueError> {
  return useQuery<ManualReviewQueuePage, ManualReviewQueueError>({
    queryKey: ['manualReviewQueue', params],
    queryFn: () => fetchManualReviewQueue(params),
    placeholderData: keepPreviousData,
    staleTime: 15_000,
    retry: shouldRetryManualReviewQueue
  });
}

/** Đồng bộ counts server-side với cache queue để refresh dashboard chỉ cần thêm một request. */
export function useManualReviewQueueCounts(): UseQueryResult<ManualReviewQueueCounts, ManualReviewQueueError> {
  return useQuery<ManualReviewQueueCounts, ManualReviewQueueError>({
    queryKey: ['manualReviewQueue', 'counts'],
    queryFn: fetchManualReviewQueueCounts,
    staleTime: 15_000,
    retry: shouldRetryManualReviewQueue
  });
}
