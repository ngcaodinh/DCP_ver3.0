'use client';

// =============================================================================
// useGeofence — B3: TanStack Query hook fetch dữ liệu geofence theo projectId.
// Dùng staleTime 5 phút vì geofence ít thay đổi (org chỉ cập nhật khi cần).
// =============================================================================

import { useQuery } from '@tanstack/react-query';
import { buildApiUrl, fetchApi } from '@/app/utils/apiClient';
import { readAuthSession } from '@/app/utils/authSession';

export type GeofenceData = {
  projectId: string;
  polygon: { lat: number; lng: number }[];
  centroid: { lat: number; lng: number };
  radiusMeters: number;
};

/**
 * Fetch geofence của một dự án từ GET /api/oracle/geofence/:projectId.
 * Trả về null data + error.statusCode === 404 khi dự án chưa có geofence.
 * Disabled khi projectId undefined.
 */
export function useGeofence(projectId: string | undefined) {
  return useQuery<GeofenceData, { statusCode?: number; message?: string; errorCode?: string }>({
    queryKey: ['geofence', projectId],
    queryFn: async () => {
      const session = readAuthSession();
      const res = await fetchApi<GeofenceData>(
        buildApiUrl(`/api/oracle/geofence/${projectId}`),
        { headers: { Authorization: `Bearer ${session?.accessToken ?? ''}` } }
      );
      return res.data;
    },
    enabled: Boolean(projectId),
    staleTime: 5 * 60 * 1000,
    retry: (failureCount, error) => {
      // Không retry 404 (dự án chưa có geofence) hoặc 403 (không có quyền)
      if (error?.statusCode === 404 || error?.statusCode === 403) return false;
      return failureCount < 1;
    }
  });
}
