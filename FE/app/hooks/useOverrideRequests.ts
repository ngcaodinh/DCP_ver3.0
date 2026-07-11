'use client';

// =============================================================================
// useOverrideRequests — B4: TanStack Query hook fetch và mutation cho override requests.
// Cung cấp useOverrideRequests() query và useSubmitOverrideVote() mutation
// theo đúng pattern của useGeofence/useUpsertGeofence.
// =============================================================================

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { buildApiUrl, fetchApi, type ApiErrorResponse } from '@/app/utils/apiClient';
import { readAuthSession } from '@/app/utils/authSession';
import type {
  OverrideRequestItem,
  VoteApiResponseData,
  SubmitOverrideVotePayload
} from '@/app/components/systemAdmin/tailwind/overrideVoting.types';

// =============================================================================
// API CALLS
// =============================================================================

/**
 * Gọi GET /api/oracle/pending-overrides để lấy danh sách override request PENDING.
 * Trả về danh sách đã được BE redact userId ở commissionerSnapshot (xem overrideVoting.types).
 */
async function fetchOverrideRequests(): Promise<OverrideRequestItem[]> {
  const session = readAuthSession();
  // [S6-fix] Early return nếu không có token — tránh gửi "Authorization: Bearer undefined"
  if (!session?.accessToken) {
    throw new Error('Chưa đăng nhập');
  }
  const res = await fetchApi<{ items: OverrideRequestItem[]; total: number }>(
    buildApiUrl('/api/oracle/pending-overrides?limit=20&skip=0'),
    { headers: { Authorization: `Bearer ${session.accessToken}` } }
  );
  return res.data.items ?? [];
}

/**
 * Gọi POST /api/oracle/override-requests/:id/vote để submit vote.
 * Không gửi Idempotency-Key vì BE hiện không có idempotency store đáng tin cậy
 * (multi-instance Redis chưa có cấu hình đảm bảo). Anti-double-vote dựa vào:
 * - 409 ALREADY_VOTED trả về từ overrideVotingService
 * - Atomic $push tại Mongo (xem addVoteToOverrideRequest + race guard).
 */
async function submitOverrideVoteRequest({
  overrideRequestId,
  vote,
  reason
}: SubmitOverrideVotePayload): Promise<VoteApiResponseData> {
  const session = readAuthSession();
  // [S6-fix] Early return nếu không có token
  if (!session?.accessToken) {
    throw new Error('Chưa đăng nhập');
  }
  const res = await fetchApi<VoteApiResponseData>(
    buildApiUrl(`/api/oracle/override-requests/${overrideRequestId}/vote`),
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.accessToken}`
      },
      body: JSON.stringify({ vote, reason })
    }
  );
  return res.data;
}

// =============================================================================
// HOOKS
// =============================================================================

/**
 * Query hook lấy danh sách override request PENDING.
 * Tự động retry 1 lần khi gọi thất bại (không phải lỗi 401/403).
 *
 * @param enabled Khi false, tắt query + refetchInterval để tránh waste network khi drawer đóng.
 *   Mặc định true để giữ tương thích ngược với callers hiện có.
 * [A3-fix] refetchInterval chỉ active khi enabled=true (drawer đang mở).
 */
export function useOverrideRequests(enabled = true) {
  return useQuery<OverrideRequestItem[], ApiErrorResponse>({
    queryKey: ['overrideRequests'],
    queryFn: fetchOverrideRequests,
    staleTime: 30_000,
    // Refetch mỗi 10s nhưng chỉ khi drawer đang mở (enabled=true) — tránh polling ngầm liên tục
    refetchInterval: enabled ? 10_000 : false,
    enabled,
    retry: (failureCount, error) => {
      // Không retry 401/403 — user phải đăng nhập lại
      if (error?.statusCode === 401 || error?.statusCode === 403) return false;
      return failureCount < 1;
    }
  });
}

/**
 * Mutation hook submit vote cho một override request.
 * Invalidate ['overrideRequests'] sau khi thành công để drawer tự refresh.
 */
export function useSubmitOverrideVote() {
  const queryClient = useQueryClient();

  return useMutation<VoteApiResponseData, ApiErrorResponse, SubmitOverrideVotePayload>({
    mutationFn: submitOverrideVoteRequest,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['overrideRequests'] });
    }
  });
}