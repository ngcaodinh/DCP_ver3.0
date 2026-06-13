'use client';

// =============================================================================
// useUpsertGeofence — B5: TanStack Query mutation upsert geofence dự án.
// Gọi POST /api/oracle/geofence/:projectId (org-only endpoint).
// Invalidate cache 'geofence' sau khi upsert thành công để GeofenceMap tự refresh.
// =============================================================================

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { buildApiUrl, fetchApi, type ApiErrorResponse } from '@/app/utils/apiClient';
import { readAuthSession } from '@/app/utils/authSession';
import type { GeofenceData } from './useGeofence';

export type UpsertGeofencePayload = {
  projectId: string;
  polygon: { lat: number; lng: number }[];
  radiusMeters: number;
};

/**
 * Mutation upsert geofence cho một dự án.
 * Chỉ org sở hữu dự án mới có quyền gọi (BE kiểm tra ownership + role).
 * Invalidate ['geofence', projectId] sau khi thành công.
 */
export function useUpsertGeofence() {
  const queryClient = useQueryClient();

  return useMutation<GeofenceData, ApiErrorResponse, UpsertGeofencePayload>({
    mutationFn: async ({ projectId, polygon, radiusMeters }) => {
      const session = readAuthSession();
      const res = await fetchApi<GeofenceData>(
        buildApiUrl(`/api/oracle/geofence/${projectId}`),
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${session?.accessToken ?? ''}` },
          body: JSON.stringify({ polygon, radiusMeters }),
        }
      );
      return res.data;
    },
    onSuccess: (_data, variables) => {
      // Invalidate để GeofenceMap và các component khác tự refetch dữ liệu mới
      queryClient.invalidateQueries({ queryKey: ['geofence', variables.projectId] });
    },
  });
}
