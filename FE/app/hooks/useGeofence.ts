'use client';

// =============================================================================
// useGeofence — B3: TanStack Query hook fetch dữ liệu geofence theo projectId.
// Dùng staleTime 5 phút vì geofence ít thay đổi (org chỉ cập nhật khi cần).
// =============================================================================

import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { buildApiUrl, fetchApi, type ApiErrorResponse } from '@/app/utils/apiClient';
import { readAuthSession } from '@/app/utils/authSession';

export type GeofenceData = {
  projectId: string;
  polygon: { lat: number; lng: number }[];
  centroid: { lat: number; lng: number };
  radiusMeters: number;
};

/** Lỗi API geofence có thể bổ sung status HTTP để UI phân loại trạng thái tải. */
export type GeofenceQueryError = ApiErrorResponse;

/**
 * Fetch geofence của một dự án từ GET /api/oracle/geofence/:projectId.
 * Trả về null data + error.statusCode === 404 khi dự án chưa có geofence.
 * Disabled khi projectId undefined.
 */
export function useGeofence(projectId: string | undefined): UseQueryResult<GeofenceData, GeofenceQueryError> {
  const accessToken = readAuthSession().accessToken?.trim() ?? '';

  return useQuery<GeofenceData, GeofenceQueryError>({
    queryKey: ['geofence', projectId],
    queryFn: async () => {
      if (!projectId) {
        const missingProjectIdError: GeofenceQueryError = {
          success: false,
          message: 'Thiếu projectId để tải geofence.',
          errorCode: 'VALIDATION_ERROR',
          statusCode: 400
        };
        throw missingProjectIdError;
      }

      const res = await fetchApi<GeofenceData>(
        buildApiUrl(`/api/oracle/geofence/${encodeURIComponent(projectId)}`),
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      return res.data;
    },
    enabled: Boolean(projectId && accessToken),
    staleTime: 5 * 60 * 1000,
    retry: (failureCount, error) => {
      // Không retry lỗi xác thực/quyền hoặc 404 vì đây không phải lỗi mạng tạm thời.
      if ([401, 403, 404].includes(error?.statusCode ?? 0)) return false;
      return failureCount < 1;
    }
  });
}
