// Ghi chú: Định nghĩa cấu trúc phiên đăng nhập lưu trong trình duyệt.

export const authenticationSessionUpdatedEventName = "dcpAuthSessionUpdated";

export type AuthenticationSessionPayload = {
  accessToken?: string;
  refreshToken?: string;
  csrfToken?: string;
  refreshSessionId?: string;
  refreshTokenExpiresAt?: string;
  userFullName?: string;
  userEmail?: string;
  userWalletAddress?: string;
  userId?: string;
  userRole?: string;
};

const accessTokenStorageKey = "dcpAccessToken";
const refreshTokenStorageKey = "dcpRefreshToken";
const csrfTokenStorageKey = "dcpCsrfToken";
const refreshSessionStorageKey = "dcpRefreshSessionId";
const refreshTokenExpiresAtStorageKey = "dcpRefreshTokenExpiresAt";
const userFullNameStorageKey = "dcpUserFullName";
const userEmailStorageKey = "dcpUserEmail";
const userWalletAddressStorageKey = "dcpUserWalletAddress";
const userIdStorageKey = "dcpUserId";
const userRoleStorageKey = "dcpUserRole";

// Ghi chú: Lưu thông tin đăng nhập vào localStorage theo chuẩn hệ thống.
export function persistAuthSession(payload: AuthenticationSessionPayload): void {
  if (payload.accessToken) {
    window.localStorage.setItem(accessTokenStorageKey, payload.accessToken);
  }

  if (payload.refreshToken) {
    window.localStorage.setItem(refreshTokenStorageKey, payload.refreshToken);
  }

  if (payload.csrfToken) {
    window.localStorage.setItem(csrfTokenStorageKey, payload.csrfToken);
  }

  if (payload.refreshSessionId) {
    window.localStorage.setItem(refreshSessionStorageKey, payload.refreshSessionId);
  }

  if (payload.refreshTokenExpiresAt) {
    window.localStorage.setItem(refreshTokenExpiresAtStorageKey, payload.refreshTokenExpiresAt);
  }

  if (typeof payload.userFullName === "string") {
    window.localStorage.setItem(userFullNameStorageKey, payload.userFullName);
  }

  if (typeof payload.userEmail === "string") {
    window.localStorage.setItem(userEmailStorageKey, payload.userEmail);
  }

  if (typeof payload.userWalletAddress === "string") {
    window.localStorage.setItem(userWalletAddressStorageKey, payload.userWalletAddress);
  }

  if (typeof payload.userId === "string") {
    window.localStorage.setItem(userIdStorageKey, payload.userId);
  }

  if (typeof payload.userRole === "string") {
    window.localStorage.setItem(userRoleStorageKey, payload.userRole);
  }

  window.dispatchEvent(new Event(authenticationSessionUpdatedEventName));
}

// Ghi chú: Đọc thông tin phiên từ localStorage để phục vụ refresh token.
export function readAuthSession(): AuthenticationSessionPayload {
  return {
    accessToken: window.localStorage.getItem(accessTokenStorageKey) || "",
    refreshToken: window.localStorage.getItem(refreshTokenStorageKey) || "",
    csrfToken: window.localStorage.getItem(csrfTokenStorageKey) || "",
    refreshSessionId: window.localStorage.getItem(refreshSessionStorageKey) || "",
    refreshTokenExpiresAt: window.localStorage.getItem(refreshTokenExpiresAtStorageKey) || "",
    userFullName: window.localStorage.getItem(userFullNameStorageKey) || "",
    userEmail: window.localStorage.getItem(userEmailStorageKey) || "",
    userWalletAddress: window.localStorage.getItem(userWalletAddressStorageKey) || "",
    userId: window.localStorage.getItem(userIdStorageKey) || "",
    userRole: window.localStorage.getItem(userRoleStorageKey) || ""
  };
}

// Ghi chú: Xóa thông tin phiên khi refresh thất bại hoặc đăng xuất.
export function clearAuthSession(): void {
  window.localStorage.removeItem(accessTokenStorageKey);
  window.localStorage.removeItem(refreshTokenStorageKey);
  window.localStorage.removeItem(csrfTokenStorageKey);
  window.localStorage.removeItem(refreshSessionStorageKey);
  window.localStorage.removeItem(refreshTokenExpiresAtStorageKey);
  window.localStorage.removeItem(userFullNameStorageKey);
  window.localStorage.removeItem(userEmailStorageKey);
  window.localStorage.removeItem(userWalletAddressStorageKey);
  window.localStorage.removeItem(userIdStorageKey);
  window.localStorage.removeItem(userRoleStorageKey);

  window.dispatchEvent(new Event(authenticationSessionUpdatedEventName));
}

