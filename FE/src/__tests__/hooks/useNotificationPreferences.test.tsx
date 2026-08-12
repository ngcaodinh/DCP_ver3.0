import { describe, expect, it, beforeEach, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

vi.mock('@/app/utils/apiClient', () => ({
  buildApiUrl: vi.fn((pathname: string) => pathname),
  fetchApi: vi.fn()
}));

vi.mock('@/app/utils/authSession', () => ({
  readAuthSession: vi.fn(),
  authenticationSessionUpdatedEventName: 'dcpAuthSessionUpdated'
}));

import { fetchApi } from '@/app/utils/apiClient';
import { readAuthSession } from '@/app/utils/authSession';
import { buildNotificationPreferenceUpdatePayload, normalizeNotificationPreferencesResponse } from '@/app/components/notifications/types';
import { notificationPreferenceQueryKey, useNotificationPreferences, useUpdateNotificationPreferences } from '@/app/hooks/useNotificationPreferences';

/** Render hook với cache tách biệt để kiểm chứng payload preference chính xác. */
function renderWithQuery<T>(hook: () => T) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { ...renderHook(hook, { wrapper }), queryClient };
}

const canonicalPreferences = {
  version: 0,
  globalEnabled: true,
  preferences: {
    LARGE_DONATION: { IN_APP: true, EMAIL: true, PUSH: false },
    DISBURSEMENT_COMPLETED: { IN_APP: true, EMAIL: true },
    MANUAL_REVIEW_ESCALATION: { IN_APP: true, EMAIL: true },
    OVERRIDE_APPROVED: { IN_APP: true, EMAIL: true },
    SBT_MINT_FAILED: { IN_APP: true, EMAIL: true },
    DONATION_RECEIVED: { IN_APP: true, EMAIL: false, SMS: false },
    FUTURE_NOTIFICATION_TYPE: { IN_APP: false, EMAIL: true, CUSTOM: true }
  }
};

describe('notification preferences', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readAuthSession).mockReturnValue({ accessToken: 'preference-token' } as never);
  });

  it('clone full map và chỉ đổi năm trường EMAIL được panel render', () => {
    const payload = buildNotificationPreferenceUpdatePayload(canonicalPreferences, {
      LARGE_DONATION: false,
      DISBURSEMENT_COMPLETED: true,
      MANUAL_REVIEW_ESCALATION: true,
      OVERRIDE_APPROVED: true,
      SBT_MINT_FAILED: true
    });

    expect(payload).toEqual({
      version: 0,
      globalEnabled: true,
      preferences: {
        ...canonicalPreferences.preferences,
        LARGE_DONATION: { IN_APP: true, EMAIL: false, PUSH: false },
        DISBURSEMENT_COMPLETED: { IN_APP: true, EMAIL: true },
        MANUAL_REVIEW_ESCALATION: { IN_APP: true, EMAIL: true },
        OVERRIDE_APPROVED: { IN_APP: true, EMAIL: true },
        SBT_MINT_FAILED: { IN_APP: true, EMAIL: true }
      }
    });
    expect(payload.preferences.FUTURE_NOTIFICATION_TYPE).toEqual({ IN_APP: false, EMAIL: true, CUSTOM: true });
  });

  it('PUT đúng full canonical payload với Bearer token', async () => {
    vi.mocked(fetchApi).mockResolvedValue({ success: true, message: '', data: canonicalPreferences } as never);
    const { result } = renderWithQuery(() => useUpdateNotificationPreferences());

    await act(async () => {
      await result.current.mutateAsync({
        currentPreferences: canonicalPreferences,
        emailValues: {
          LARGE_DONATION: false,
          DISBURSEMENT_COMPLETED: true,
          MANUAL_REVIEW_ESCALATION: true,
          OVERRIDE_APPROVED: true,
          SBT_MINT_FAILED: true
        }
      });
    });

    expect(fetchApi).toHaveBeenCalledWith(
      '/api/notifications/preferences',
      expect.objectContaining({
        method: 'PUT',
        headers: { Authorization: 'Bearer preference-token' },
        body: JSON.stringify({
          globalEnabled: true,
          preferences: {
            LARGE_DONATION: { IN_APP: true, EMAIL: false, PUSH: false },
            DISBURSEMENT_COMPLETED: { IN_APP: true, EMAIL: true },
            MANUAL_REVIEW_ESCALATION: { IN_APP: true, EMAIL: true },
            OVERRIDE_APPROVED: { IN_APP: true, EMAIL: true },
            SBT_MINT_FAILED: { IN_APP: true, EMAIL: true },
            DONATION_RECEIVED: { IN_APP: true, EMAIL: false, SMS: false },
            FUTURE_NOTIFICATION_TYPE: { IN_APP: false, EMAIL: true, CUSTOM: true }
          },
          version: 0
        })
      })
    );
  });

  it('không GET preference khi phiên đăng nhập không tồn tại', async () => {
    vi.mocked(readAuthSession).mockReturnValue({ accessToken: '' } as never);
    const { result } = renderWithQuery(() => useNotificationPreferences());

    await waitFor(() => expect(result.current.fetchStatus).toBe('idle'));
    expect(fetchApi).not.toHaveBeenCalled();
  });

  it('đổi session key khi legacy session không có userId được thay thế', async () => {
    vi.mocked(readAuthSession).mockReturnValue({ accessToken: 'token-a' } as never);
    vi.mocked(fetchApi).mockResolvedValue({ success: true, message: '', data: canonicalPreferences } as never);

    const { result } = renderWithQuery(() => useNotificationPreferences());
    await waitFor(() => expect(result.current.data?.version).toBe(0));
    const firstSessionKey = result.current.sessionKey;

    vi.mocked(readAuthSession).mockReturnValue({ accessToken: 'token-b' } as never);
    act(() => window.dispatchEvent(new Event('dcpAuthSessionUpdated')));

    await waitFor(() => expect(result.current.sessionKey).not.toBe(firstSessionKey));
  });

  it('từ chối preference key nguy hiểm từ response không tin cậy', () => {
    const unsafeResponse = JSON.parse('{"globalEnabled":true,"preferences":{"__proto__":{"EMAIL":true}}}');
    expect(() => normalizeNotificationPreferencesResponse(unsafeResponse)).toThrow('Phản hồi cài đặt thông báo không hợp lệ.');
  });

  it('không ghi response PUT của phiên cũ vào cache preference user mới', async () => {
    vi.mocked(readAuthSession).mockReturnValue({ accessToken: 'token-a', userId: 'user-a' } as never);
    let resolveUpdate: ((value: unknown) => void) | undefined;
    const pendingUpdate = new Promise<unknown>((resolve) => {
      resolveUpdate = resolve;
    });
    vi.mocked(fetchApi).mockReturnValueOnce(pendingUpdate as never);

    const { result, queryClient } = renderWithQuery(() => useUpdateNotificationPreferences());
    const updatePromise = result.current.mutateAsync({ currentPreferences: canonicalPreferences, emailValues: {
      LARGE_DONATION: false,
      DISBURSEMENT_COMPLETED: true,
      MANUAL_REVIEW_ESCALATION: true,
      OVERRIDE_APPROVED: true,
      SBT_MINT_FAILED: true
    } });

    vi.mocked(readAuthSession).mockReturnValue({ accessToken: 'token-b', userId: 'user-b' } as never);
    act(() => window.dispatchEvent(new Event('dcpAuthSessionUpdated')));
    const userBData = { globalEnabled: true, preferences: { SYSTEM: { IN_APP: true } }, version: 3 };
    queryClient.setQueryData(notificationPreferenceQueryKey('user-b'), userBData);
    await act(async () => {
      resolveUpdate?.({ success: true, message: '', data: canonicalPreferences });
      await updatePromise;
    });

    expect(queryClient.getQueryData(notificationPreferenceQueryKey('user-b'))).toEqual(userBData);
  });
});
