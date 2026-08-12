'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { buildApiUrl, fetchApi, type ApiErrorResponse } from '@/app/utils/apiClient';
import { readAuthSession } from '@/app/utils/authSession';
import {
  buildNotificationPreferenceUpdatePayload,
  normalizeNotificationPreferencesResponse,
  type EmailPreferenceValues,
  type NotificationPreferencesResponse
} from '@/app/components/notifications/types';
import {
  isNotificationSessionCurrent,
  readNotificationSessionSnapshot,
  useNotificationSession,
  type NotificationSessionSnapshot
} from './useNotificationSession';

export const notificationPreferenceQueryKey = (userId: string) => ['notifications', 'preferences', userId || 'anonymous'] as const;

/** Lấy access token hiện tại hoặc chặn request preference khi phiên chưa tồn tại. */
function getAccessToken(): string {
  if (typeof window === 'undefined') {
    throw new Error('Chưa đăng nhập');
  }
  const accessToken = readAuthSession()?.accessToken;
  if (!accessToken) {
    throw new Error('Chưa đăng nhập');
  }
  return accessToken;
}

/** Đọc full canonical preference map để mọi cập nhật UI có thể bảo toàn key không render. */
async function fetchNotificationPreferences(): Promise<NotificationPreferencesResponse> {
  const accessToken = getAccessToken();
  const response = await fetchApi<unknown>(
    buildApiUrl('/api/notifications/preferences'),
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  return normalizeNotificationPreferencesResponse(response.data);
}

/** Ghi trọn preference map vì endpoint PUT phía BE thay thế map hiện có. */
async function updateNotificationPreferences(
  payload: NotificationPreferencesResponse
): Promise<NotificationPreferencesResponse> {
  const accessToken = getAccessToken();
  const response = await fetchApi<unknown>(
    buildApiUrl('/api/notifications/preferences'),
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify(payload)
    }
  );
  return normalizeNotificationPreferencesResponse(response.data);
}

/** Không retry lỗi 401/403; mọi lỗi transport hoặc server khác chỉ retry một lần. */
function shouldRetryPreferenceQuery(failureCount: number, error: ApiErrorResponse): boolean {
  if (error.statusCode === 401 || error.statusCode === 403) {
    return false;
  }
  return failureCount < 1;
}

interface NotificationPreferenceMutationContext extends NotificationSessionSnapshot {
  queryKey: ReturnType<typeof notificationPreferenceQueryKey>;
}

/** Chụp session và cache key trước PUT để response của phiên cũ không ghi đè cache phiên mới. */
function captureNotificationPreferenceMutationContext(): NotificationPreferenceMutationContext {
  const sessionSnapshot = readNotificationSessionSnapshot();
  return {
    ...sessionSnapshot,
    queryKey: notificationPreferenceQueryKey(sessionSnapshot.userId)
  };
}

/** Query preference chỉ chạy khi có token để không phát request Authorization rỗng. */
export function useNotificationPreferences() {
  const { hasAccessToken, userId, sessionRevision } = useNotificationSession();
  const query = useQuery<NotificationPreferencesResponse, ApiErrorResponse>({
    queryKey: notificationPreferenceQueryKey(userId),
    queryFn: fetchNotificationPreferences,
    enabled: hasAccessToken,
    retry: shouldRetryPreferenceQuery
  });

  return {
    ...query,
    isEnabled: hasAccessToken,
    sessionKey: `${userId || (hasAccessToken ? 'anonymous' : 'signed-out')}:${sessionRevision}`
  };
}

/** Mutation nhận canonical GET record và toggle cục bộ, sau đó PUT exact full map đã được clone. */
export function useUpdateNotificationPreferences() {
  const queryClient = useQueryClient();

  return useMutation<
    NotificationPreferencesResponse,
    ApiErrorResponse,
    { currentPreferences: NotificationPreferencesResponse; emailValues: EmailPreferenceValues },
    NotificationPreferenceMutationContext
  >({
    mutationFn: ({ currentPreferences, emailValues }) => (
      updateNotificationPreferences(buildNotificationPreferenceUpdatePayload(currentPreferences, emailValues))
    ),
    onMutate: () => captureNotificationPreferenceMutationContext(),
    onSuccess: (updatedPreferences, _variables, context) => {
      if (!context || !isNotificationSessionCurrent(context)) {
        return;
      }
      queryClient.setQueryData(context.queryKey, updatedPreferences);
    }
  });
}
