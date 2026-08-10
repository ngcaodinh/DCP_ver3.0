'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient, type UseMutationResult, type UseQueryResult } from '@tanstack/react-query';
import { buildApiUrl, fetchApi } from '@/app/utils/apiClient';
import { readAuthSession } from '@/app/utils/authSession';
import {
  SBT_DLQ_PAGE_SIZE,
  SBT_DLQ_POLL_INTERVAL_MS
} from '@/app/constants/sbtDlq';
import type {
  SbtDlqError,
  SbtDlqErrorKind,
  SbtDlqListResponse,
  SbtDlqStatus,
  SbtRetryJobResult
} from '@/app/types/sbtRetry';

interface SbtDlqErrorShape {
  statusCode?: unknown;
  message?: unknown;
  error?: unknown;
  errorCode?: unknown;
}

/** Xây URL danh sách DLQ với query contract cố định của BE. */
export function buildSbtDlqUrl(page: number, status: SbtDlqStatus): string {
  const searchParams = new URLSearchParams({
    page: String(page),
    limit: String(SBT_DLQ_PAGE_SIZE),
    status
  });
  return `/api/sbt/dlq?${searchParams.toString()}`;
}

/** Phân loại lỗi API/network để UI xử lý đúng nhánh và giữ message từ BE. */
export function mapSbtDlqError(error: unknown): SbtDlqError {
  const errorShape = (error && typeof error === 'object' ? error : {}) as SbtDlqErrorShape;
  const statusCode = typeof errorShape.statusCode === 'number' ? errorShape.statusCode : undefined;
  const kind: SbtDlqErrorKind = statusCode === 401
    ? 'UNAUTHENTICATED'
    : statusCode === 403
      ? 'FORBIDDEN'
      : statusCode === 429
        ? 'RATE_LIMITED'
        : statusCode === 404
          ? 'NOT_FOUND'
          : statusCode === 409
            ? 'CONFLICT'
            : statusCode !== undefined && statusCode >= 400 && statusCode < 500
              ? 'VALIDATION'
              : statusCode !== undefined && statusCode >= 500
                ? 'SERVER'
                : 'NETWORK';
  const message = typeof errorShape.message === 'string' && errorShape.message.length > 0
    ? errorShape.message
    : typeof errorShape.error === 'string' && errorShape.error.length > 0
      ? errorShape.error
      : error instanceof Error && error.message
        ? error.message
        : 'Không thể xử lý yêu cầu DLQ. Vui lòng thử lại.';

  return Object.assign(new Error(message), {
    kind,
    statusCode,
    errorCode: typeof errorShape.errorCode === 'string' ? errorShape.errorCode : undefined
  });
}

/** Tải một trang DLQ và lấy access token mới nhất tại thời điểm request. */
export async function fetchSbtDlqList(page: number, status: SbtDlqStatus): Promise<SbtDlqListResponse> {
  try {
    const session = readAuthSession();
    const response = await fetchApi<SbtDlqListResponse>(
      buildApiUrl(buildSbtDlqUrl(page, status)),
      { headers: { Authorization: `Bearer ${session.accessToken ?? ''}` } }
    );
    return response.data;
  } catch (error) {
    throw mapSbtDlqError(error);
  }
}

/** Chỉ retry một lần cho lỗi network/server; lỗi quyền và dữ liệu không retry tự động. */
function shouldRetrySbtDlqQuery(failureCount: number, error: SbtDlqError): boolean {
  if (['UNAUTHENTICATED', 'FORBIDDEN', 'RATE_LIMITED', 'NOT_FOUND', 'CONFLICT', 'VALIDATION'].includes(error.kind)) {
    return false;
  }
  return failureCount < 1;
}

/** Cung cấp server state DLQ và chỉ bật polling khi có job đang được theo dõi. */
export function useSbtDlqList({
  page,
  status,
  isPollingEnabled
}: {
  page: number;
  status: SbtDlqStatus;
  isPollingEnabled: boolean;
}): UseQueryResult<SbtDlqListResponse, SbtDlqError> {
  return useQuery<SbtDlqListResponse, SbtDlqError>({
    queryKey: ['sbtDlqList', { page, status }],
    queryFn: () => fetchSbtDlqList(page, status),
    placeholderData: keepPreviousData,
    staleTime: 15_000,
    refetchInterval: isPollingEnabled ? SBT_DLQ_POLL_INTERVAL_MS : false,
    retry: shouldRetrySbtDlqQuery
  });
}

/** Gọi API retry job qua worker và làm mới mọi biến thể query DLQ sau response thành công. */
export function useRetrySbtMintJob(): UseMutationResult<SbtRetryJobResult, SbtDlqError, string> {
  const queryClient = useQueryClient();

  return useMutation<SbtRetryJobResult, SbtDlqError, string>({
    mutationFn: async (mintRequestId: string): Promise<SbtRetryJobResult> => {
      try {
        const session = readAuthSession();
        const response = await fetchApi<SbtRetryJobResult>(
          buildApiUrl(`/api/sbt/retry-job/${encodeURIComponent(mintRequestId)}`),
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${session.accessToken ?? ''}` }
          }
        );
        return response.data;
      } catch (error) {
        throw mapSbtDlqError(error);
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['sbtDlqList'] });
    }
  });
}
