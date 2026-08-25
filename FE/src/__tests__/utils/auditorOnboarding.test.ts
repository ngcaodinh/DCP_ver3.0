import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockBuildApiUrl, mockFetchApi } = vi.hoisted(() => ({
  mockBuildApiUrl: vi.fn((pathname: string) => `https://api.example${pathname}`),
  mockFetchApi: vi.fn(),
}));

vi.mock("@/app/utils/apiClient", () => ({
  buildApiUrl: mockBuildApiUrl,
  fetchApi: mockFetchApi,
}));

import {
  executeAuditorStake,
  getAuditorOnboardingStatus,
  registerAuditorIntent,
  resumeAuditorIntent,
} from "@/app/utils/auditorOnboarding";

/** Tạo payload API tối thiểu để kiểm tra helper đăng ký intent Auditor. */
function createRegisterResult(): Record<string, string> {
  return {
    intentId: "intent-001",
    minimumStakeThreshold: "3000000",
    currentTokenBalance: "0",
    walletAddress: "0xwallet",
    accessToken: "access-token",
    refreshToken: "refresh-token",
    csrfToken: "csrf-token",
    refreshSessionId: "refresh-session-id",
    expiresAt: "2026-08-25T00:00:00.000Z",
    correlationId: "correlation-id",
  };
}

describe("auditorOnboarding API helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("gửi payload đăng ký intent với thông tin tài khoản nhận tiền nguyên vẹn", async () => {
    const result = createRegisterResult();
    mockFetchApi.mockResolvedValue({ data: result });

    await expect(registerAuditorIntent({
      identityToken: "google-id-token",
      payoutAccount: {
        bankName: "Vietcombank",
        bankAccountNumber: "0123456789",
        accountHolderName: "NGUYEN VAN A",
        branchName: "Quận 1",
      },
    })).resolves.toEqual(result);

    expect(mockFetchApi).toHaveBeenCalledWith(
      "https://api.example/api/auditor-onboarding/register",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          identityToken: "google-id-token",
          payoutAccount: {
            bankName: "Vietcombank",
            bankAccountNumber: "0123456789",
            accountHolderName: "NGUYEN VAN A",
            branchName: "Quận 1",
          },
        }),
      }),
    );
  });

  it.each([
    ["thiếu access token", { accessToken: "" }],
    ["số dư DCT không phải số nguyên", { currentTokenBalance: "not-a-number" }],
    ["ngưỡng cọc âm", { minimumStakeThreshold: "-1" }],
  ])("từ chối response đăng ký intent %s trước khi UI lưu phiên", async (_scenario, invalidFields) => {
    mockFetchApi.mockResolvedValue({ data: { ...createRegisterResult(), ...invalidFields } });

    await expect(registerAuditorIntent({
      identityToken: "google-id-token",
      payoutAccount: { bankName: "ACB", bankAccountNumber: "0123456789", accountHolderName: "NGUYEN VAN A" },
    })).rejects.toMatchObject({
      errorCode: "INVALID_RESPONSE",
      message: "Phản hồi tạo hồ sơ Kiểm toán viên không hợp lệ.",
    });
  });

  it("khôi phục intent Auditor bằng đúng Google identity token và áp dụng cùng contract response", async () => {
    const result = createRegisterResult();
    mockFetchApi.mockResolvedValue({ data: result });

    await expect(resumeAuditorIntent({ identityToken: "google-id-token" })).resolves.toEqual(result);

    expect(mockFetchApi).toHaveBeenCalledWith(
      "https://api.example/api/auditor-onboarding/resume",
      { method: "POST", body: JSON.stringify({ identityToken: "google-id-token" }) },
    );
  });

  it("từ chối response khôi phục intent không hợp lệ trước khi UI lưu phiên", async () => {
    mockFetchApi.mockResolvedValue({ data: { ...createRegisterResult(), walletAddress: "" } });

    await expect(resumeAuditorIntent({ identityToken: "google-id-token" })).rejects.toMatchObject({
      errorCode: "INVALID_RESPONSE",
    });
  });

  it("gửi stake kèm Bearer token và body rỗng theo contract", async () => {
    mockFetchApi.mockResolvedValue({ data: { status: "VERIFYING", txHash: "0xstake" } });

    await expect(executeAuditorStake("access-token")).resolves.toEqual({ status: "VERIFYING", txHash: "0xstake" });

    expect(mockFetchApi).toHaveBeenCalledWith(
      "https://api.example/api/auditor-onboarding/stake",
      { method: "POST", headers: { Authorization: "Bearer access-token" }, body: "{}" },
    );
  });

  it("mã hóa intentId khi đọc trạng thái onboarding", async () => {
    const result = { status: "VERIFYING", failureReason: null, createdAt: "2026-08-25", updatedAt: "2026-08-25" };
    mockFetchApi.mockResolvedValue({ data: result });

    await expect(getAuditorOnboardingStatus("access-token", "intent/with space")).resolves.toEqual(result);

    expect(mockFetchApi).toHaveBeenCalledWith(
      "https://api.example/api/auditor-onboarding/status/intent%2Fwith%20space",
      { method: "GET", headers: { Authorization: "Bearer access-token" } },
    );
  });

  it.each([
    ["register", () => registerAuditorIntent({ identityToken: "google-id-token", payoutAccount: { bankName: "ACB", bankAccountNumber: "0123456789", accountHolderName: "NGUYEN VAN A" } })],
    ["resume", () => resumeAuditorIntent({ identityToken: "google-id-token" })],
    ["stake", () => executeAuditorStake("access-token")],
    ["status", () => getAuditorOnboardingStatus("access-token", "intent-001")],
  ])("chuyển tiếp lỗi API của helper %s để UI ánh xạ thông báo", async (_operation, executeRequest) => {
    const apiError = { errorCode: "UNAUTHENTICATED", message: "Phiên hết hạn." };
    mockFetchApi.mockRejectedValueOnce(apiError);

    await expect(executeRequest()).rejects.toBe(apiError);
  });
});
