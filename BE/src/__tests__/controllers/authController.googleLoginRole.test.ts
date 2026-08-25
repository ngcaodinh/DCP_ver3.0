import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockLoginWithGoogle } = vi.hoisted(() => ({ mockLoginWithGoogle: vi.fn() }));

vi.mock("../../config/logger", () => ({
  getLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
}));

vi.mock("../../services/authService", () => ({
  getMyActiveSessions: vi.fn(),
  loginWithGoogle: mockLoginWithGoogle,
  refreshAccessToken: vi.fn(),
  logFailedGoogleLogin: vi.fn(),
  revokeAllRefreshSessionsForUser: vi.fn(),
}));

vi.mock("../../services/organizationKycService", () => ({
  getFoundationOrganizationKycSubmissions: vi.fn(),
  getMyOrganizationProfile: vi.fn(),
  getOrganizationKycSubmissionsByUserId: vi.fn(),
  getPendingOrganizationKycSubmissions: vi.fn(),
  reviewOrganizationKycSubmission: vi.fn(),
  submitBeneficiaryBankAccount: vi.fn(),
  submitOrganizationKyc: vi.fn(),
}));

vi.mock("../../models/authModel", () => ({ findUserById: vi.fn() }));

import { handleGoogleLogin } from "../../controllers/authController";

/** Tạo request Google login tối thiểu để kiểm tra chặn role ở lớp controller. */
function createRequest(
  role: unknown,
  idToken: unknown = "google-id-token",
  headers: Record<string, string | undefined> = { "x-client-ip": "127.0.0.1", "x-client-user-agent": "vitest" },
): Request {
  return {
    body: { idToken, role },
    headers,
  } as unknown as Request;
}

/** Tạo response Express có thể kiểm tra mã HTTP và payload trả về. */
function createResponse(): Response {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
}

describe("Google login role authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("từ chối role auditor để không thể tự cấp quyền bỏ qua đặt cọc", async () => {
    const response = createResponse();

    await handleGoogleLogin(createRequest("auditor"), response);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(mockLoginWithGoogle).not.toHaveBeenCalled();
  });

  it("từ chối role cấp thủ công khác", async () => {
    const response = createResponse();

    await handleGoogleLogin(createRequest("admin"), response);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(mockLoginWithGoogle).not.toHaveBeenCalled();
  });

  it("cho phép donor đi tiếp vào dịch vụ đăng nhập hiện có", async () => {
    mockLoginWithGoogle.mockResolvedValue({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      csrfToken: "csrf-token",
      refreshSessionId: "refresh-session-id",
      expiresAt: "2026-08-25T00:00:00.000Z",
      user: { role: "donor" },
      correlationId: "correlation-id",
    });
    const response = createResponse();

    await handleGoogleLogin(createRequest("donor"), response);

    expect(mockLoginWithGoogle).toHaveBeenCalledWith("google-id-token", "donor", "127.0.0.1", "vitest");
    expect(response.status).toHaveBeenCalledWith(200);
  });

  it.each([undefined, "", "   ", 123])("từ chối idToken không hợp lệ %o trước khi gọi service", async (idToken) => {
    const response = createResponse();
    const request = createRequest("donor");
    request.body.idToken = idToken;

    await handleGoogleLogin(request, response);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(mockLoginWithGoogle).not.toHaveBeenCalled();
  });

  it("cho phép organization hợp lệ, trim token và dùng metadata mặc định an toàn", async () => {
    mockLoginWithGoogle.mockResolvedValue({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      csrfToken: "csrf-token",
      refreshSessionId: "refresh-session-id",
      expiresAt: "2026-08-25T00:00:00.000Z",
      user: { role: "organization" },
      correlationId: "correlation-id",
    });
    const response = createResponse();

    await handleGoogleLogin(createRequest("organization", "  google-id-token  ", {}), response);

    expect(mockLoginWithGoogle).toHaveBeenCalledWith("google-id-token", "organization", "unknown", "unknown");
    expect(response.status).toHaveBeenCalledWith(200);
  });
});
