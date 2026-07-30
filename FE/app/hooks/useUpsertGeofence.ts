'use client';

// =============================================================================
// useUpsertGeofence — B5: TanStack Query mutation upsert geofence dự án.
// Gọi POST /api/oracle/geofence/:projectId (org-only endpoint).
// Cập nhật cache 'geofence' bằng response POST do server tính centroid.
// =============================================================================

import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';
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
 * Cập nhật ['geofence', projectId] bằng response thành công.
 */
export function useUpsertGeofence(): UseMutationResult<GeofenceData, ApiErrorResponse, UpsertGeofencePayload> {
  const queryClient = useQueryClient();

  return useMutation<GeofenceData, ApiErrorResponse, UpsertGeofencePayload>({
    mutationFn: async ({ projectId, polygon, radiusMeters }) => {
      const session = readAuthSession();
      const res = await fetchApi<GeofenceData>(
        buildApiUrl(`/api/oracle/geofence/${encodeURIComponent(projectId)}`),
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${session?.accessToken ?? ''}` },
          body: JSON.stringify({ polygon, radiusMeters }),
        }
      );
      return res.data;
    },
    onSuccess: (geofence, variables) => {
      // Response POST chứa centroid do server tính nên dùng trực tiếp làm dữ liệu cache authoritative.
      queryClient.setQueryData<GeofenceData>(['geofence', variables.projectId], geofence);
    },
  });
}
