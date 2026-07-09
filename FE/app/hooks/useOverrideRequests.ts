'use client';

// =============================================================================
// useOverrideRequests — B4: TanStack Query hook fetch và mutation cho override requests.
// Cung cấp useOverrideRequests() query và useSubmitOverrideVote() mutation
// theo đúng pattern của useGeofence/useUpsertGeofence.
// =============================================================================

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { buildApiUrl, fetchApi, type ApiErrorResponse } from '@/app/utils/apiClient';
import { readAuthSession } from '@/app/utils/authSession';

// =============================================================================
// SHARED TYPES — định nghĩa trùng với PendingOverrideItem trong OverrideVoteDrawer.tsx
// =============================================================================

type GpsCoordinate = { lat: number; lng: number };
type OverrideReason = 'OUT_OF_GEOFENCE' | 'GPS_EXIF_MISSING' | 'NO_GEOFENCE';
type OverrideStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED';

type CommissionerVote = {
  commissionerId: string;
  commissionerRole: string;
  vote: 'APPROVE' | 'REJECT';
  reason: string;
  votedAt: string;
};

export type OverrideRequestItem = {
  overrideRequestId: string;
  projectId: string;
  organizationId: string;
  evidenceCid: string;
  disbursementRequestId: string | null;
  reason: OverrideReason;
  gpsFromImage: GpsCoordinate | null;
  gpsFromProject: GpsCoordinate;
  distanceMeters: number | null;
  commissionerSnapshot: Array<{ userId: string; role: string }>;
  votes: CommissionerVote[];
  status: OverrideStatus;
  createdAt: string;
};

export type VoteApiResponseData = {
  outcome: 'VOTE_RECORDED' | 'RESOLVED_APPROVED' | 'RESOLVED_REJECTED';
  pendingVoters?: number;
  totalVoters?: number;
  disbursementAutoApproved?: boolean;
};

// =============================================================================
// API CALLS
// =============================================================================

/** Gọi GET /api/oracle/pending-overrides để lấy danh sách override request PENDING. */
async function fetchOverrideRequests(): Promise<OverrideRequestItem[]> {
  const session = readAuthSession();
  const res = await fetchApi<{ items: OverrideRequestItem[]; total: number }>(
    buildApiUrl('/api/oracle/pending-overrides?limit=20&skip=0'),
    { headers: { Authorization: `Bearer ${session?.accessToken ?? ''}` } }
  );
  return res.data.items ?? [];
}

/** Gọi POST /api/oracle/override-requests/:id/vote để submit vote. */
async function submitOverrideVoteRequest(
  overrideRequestId: string,
  vote: 'APPROVE' | 'REJECT',
  reason: string
): Promise<VoteApiResponseData> {
  const session = readAuthSession();
  const res = await fetchApi<VoteApiResponseData>(
    buildApiUrl(`/api/oracle/override-requests/${overrideRequestId}/vote`),
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${session?.accessToken ?? ''}` },
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
 */
export function useOverrideRequests() {
  return useQuery<OverrideRequestItem[], ApiErrorResponse>({
    queryKey: ['overrideRequests'],
    queryFn: fetchOverrideRequests,
    staleTime: 30_000,
    retry: (failureCount, error) => {
      // Không retry 401/403 — user phải đăng nhập lại
      if (error?.statusCode === 401 || error?.statusCode === 403) return false;
      return failureCount < 1;
    }
  });
}

export type SubmitOverrideVotePayload = {
  overrideRequestId: string;
  vote: 'APPROVE' | 'REJECT';
  reason: string;
};

/**
 * Mutation hook submit vote cho một override request.
 * Invalidate ['overrideRequests'] sau khi thành công để drawer tự refresh.
 */
export function useSubmitOverrideVote() {
  const queryClient = useQueryClient();

  return useMutation<VoteApiResponseData, ApiErrorResponse, SubmitOverrideVotePayload>({
    mutationFn: async ({ overrideRequestId, vote, reason }) =>
      submitOverrideVoteRequest(overrideRequestId, vote, reason),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['overrideRequests'] });
    }
  });
}
