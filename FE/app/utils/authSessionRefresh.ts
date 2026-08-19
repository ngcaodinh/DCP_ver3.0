import {
  clearAuthSession,
  persistAuthSession,
  readAuthSession,
  type AuthenticationSessionPayload
} from './authSession';

export type AuthenticationSessionRefreshStatus = 'REFRESHED' | 'MISSING_SESSION' | 'REJECTED' | 'RATE_LIMITED' | 'UNAVAILABLE';

export type AuthenticationSessionRefreshResult = {
  status: AuthenticationSessionRefreshStatus;
  accessToken: string;
};

const authenticationApiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:4000';
let activeSessionRefreshPromise: Promise<AuthenticationSessionRefreshResult> | null = null;

/** Gọi API refresh một lần để xoay token; chỉ xóa phiên khi backend xác nhận refresh token không còn hợp lệ. */
async function requestAuthSessionRefresh(): Promise<AuthenticationSessionRefreshResult> {
  const { refreshToken, refreshSessionId, csrfToken } = readAuthSession();
  if (!refreshToken || !refreshSessionId || !csrfToken) {
    clearAuthSession();
    return { status: 'MISSING_SESSION', accessToken: '' };
  }

  try {
    const response = await fetch(`${authenticationApiBaseUrl}/auth/refresh`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-csrf-token': csrfToken
      },
      body: JSON.stringify({ refreshToken, refreshSessionId })
    });
    const responseData = await response.json().catch(() => null) as (AuthenticationSessionPayload & { expiresAt?: string }) | null;

    if (response.status === 429) {
      return { status: 'RATE_LIMITED', accessToken: '' };
    }

    if (!response.ok || !responseData?.accessToken || !responseData.refreshToken || !responseData.csrfToken || !responseData.refreshSessionId) {
      clearAuthSession();
      return { status: 'REJECTED', accessToken: '' };
    }

    persistAuthSession({
      accessToken: responseData.accessToken,
      refreshToken: responseData.refreshToken,
      csrfToken: responseData.csrfToken,
      refreshSessionId: responseData.refreshSessionId,
      refreshTokenExpiresAt: responseData.refreshTokenExpiresAt || responseData.expiresAt
    });
    return { status: 'REFRESHED', accessToken: responseData.accessToken };
  } catch {
    return { status: 'UNAVAILABLE', accessToken: '' };
  }
}

/** Gộp các yêu cầu refresh đồng thời để một lần F5 không tạo nhiều request xoay refresh token. */
export function refreshAuthSession(): Promise<AuthenticationSessionRefreshResult> {
  if (!activeSessionRefreshPromise) {
    activeSessionRefreshPromise = requestAuthSessionRefresh().finally(() => {
      activeSessionRefreshPromise = null;
    });
  }

  return activeSessionRefreshPromise;
}
