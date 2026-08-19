import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearAuthSession,
  persistAuthSession,
  readAuthSession
} from '@/app/utils/authSession';
import { refreshAuthSession } from '@/app/utils/authSessionRefresh';

const mockFetch = vi.fn();

/** Tạo dữ liệu phiên tối thiểu để kiểm tra luồng refresh token phía trình duyệt. */
function persistTestSession(): void {
  persistAuthSession({
    accessToken: 'stale-access-token',
    refreshToken: 'refresh-token',
    csrfToken: 'csrf-token',
    refreshSessionId: 'refresh-session-id'
  });
}

describe('refreshAuthSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);
    window.localStorage.clear();
  });

  afterEach(() => {
    clearAuthSession();
    vi.unstubAllGlobals();
  });

  it('keeps the current session when refresh is rate limited', async () => {
    persistTestSession();
    mockFetch.mockResolvedValue({ ok: false, status: 429, json: async () => ({}) });

    await expect(refreshAuthSession()).resolves.toEqual({ status: 'RATE_LIMITED', accessToken: '' });
    expect(readAuthSession().accessToken).toBe('stale-access-token');
  });

  it('persists the rotated session after a successful refresh', async () => {
    persistTestSession();
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        accessToken: 'new-access-token',
        refreshToken: 'new-refresh-token',
        csrfToken: 'new-csrf-token',
        refreshSessionId: 'new-refresh-session-id',
        expiresAt: '2026-09-17T00:00:00.000Z'
      })
    });

    await expect(refreshAuthSession()).resolves.toEqual({ status: 'REFRESHED', accessToken: 'new-access-token' });
    expect(readAuthSession()).toMatchObject({
      accessToken: 'new-access-token',
      refreshToken: 'new-refresh-token',
      csrfToken: 'new-csrf-token',
      refreshSessionId: 'new-refresh-session-id',
      refreshTokenExpiresAt: '2026-09-17T00:00:00.000Z'
    });
  });
});
