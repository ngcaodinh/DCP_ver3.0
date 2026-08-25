import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockClearAuthSession,
  mockExecuteAuditorStake,
  mockGetAuditorOnboardingStatus,
  mockPersistAuthSession,
  mockRegisterAuditorIntent,
  mockResumeAuditorIntent,
  mockRouterPush,
} = vi.hoisted(() => ({
  mockClearAuthSession: vi.fn(),
  mockExecuteAuditorStake: vi.fn(),
  mockGetAuditorOnboardingStatus: vi.fn(),
  mockPersistAuthSession: vi.fn(),
  mockRegisterAuditorIntent: vi.fn(),
  mockResumeAuditorIntent: vi.fn(),
  mockRouterPush: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mockRouterPush }) }));
vi.mock("@/app/components/AuthLegalModal", () => ({ default: () => null }));
vi.mock("@/app/utils/auditorOnboarding", () => ({
  executeAuditorStake: mockExecuteAuditorStake,
  getAuditorOnboardingStatus: mockGetAuditorOnboardingStatus,
  registerAuditorIntent: mockRegisterAuditorIntent,
  resumeAuditorIntent: mockResumeAuditorIntent,
}));
vi.mock("@/app/utils/authSession", () => ({
  clearAuthSession: mockClearAuthSession,
  persistAuthSession: mockPersistAuthSession,
  readAuthSession: () => ({ accessToken: "auditor-access-token" }),
}));

import RegisterPage from "@/app/register/page";

let googleCredentialCallback: ((response: { credential?: string }) => void) | undefined;

/** Cài Google Identity giả để kích callback bằng tay trong các test đăng ký. */
function installGoogleIdentity(): void {
  googleCredentialCallback = undefined;
  (window as unknown as { google: unknown }).google = {
    accounts: {
      id: {
        initialize: ({ callback }: { callback: (response: { credential?: string }) => void }) => {
          googleCredentialCallback = callback;
        },
        renderButton: vi.fn(),
      },
    },
  };
}

/** Trả về payload đăng ký intent hợp lệ với số dư DCT có thể ghi đè theo test. */
function createIntentResult(currentTokenBalance = "0"): Record<string, string> {
  return {
    intentId: "intent-001",
    minimumStakeThreshold: "3000000",
    currentTokenBalance,
    walletAddress: "0xAuditorWallet",
    accessToken: "auditor-access-token",
    refreshToken: "refresh-token",
    csrfToken: "csrf-token",
    refreshSessionId: "refresh-session-id",
    expiresAt: "2026-08-25T00:00:00.000Z",
    correlationId: "correlation-id",
  };
}

/** Dựng wizard trực tiếp tại nhánh Auditor và chuyển sang bước thông tin tài khoản. */
async function renderAuditorStepTwo(): Promise<void> {
  window.history.pushState({}, "", "/register?role=auditor");
  render(<RegisterPage />);
  await waitFor(() => expect(googleCredentialCallback).toBeDefined());
  fireEvent.click(screen.getByText("Kiểm toán viên").closest("button") as HTMLButtonElement);
  fireEvent.click(screen.getByRole("button", { name: "Tiếp tục →" }));
  await screen.findByText("Tạo tài khoản Kiểm toán viên 🔍");
  await screen.findByLabelText(/Ngân hàng nhận tiền/);
}

/** Hoàn thiện dữ liệu bắt buộc của form Auditor theo hành vi người dùng thực tế. */
async function completeAuditorForm(): Promise<void> {
  fireEvent.click(screen.getByText(/Tôi đồng ý với/));
  await act(async () => googleCredentialCallback?.({ credential: "google-identity-token" }));
  fireEvent.change(await screen.findByLabelText(/Ngân hàng nhận tiền/), { target: { value: "Vietcombank" } });
  fireEvent.change(screen.getByLabelText(/Số tài khoản/), { target: { value: "0123456789" } });
  fireEvent.change(screen.getByLabelText(/Chủ tài khoản/), { target: { value: "Nguyễn Văn A" } });
}

/** Tạo response fetch JSON tối thiểu cho vòng nạp DCT. */
function createJsonResponse(data: unknown, ok = true): { ok: boolean; json: () => Promise<unknown> } {
  return { ok, json: vi.fn().mockResolvedValue(data) };
}

/** Đưa wizard Auditor từ bước thông tin nhận tiền sang bước nạp hoặc đặt cọc theo số dư mock hiện tại. */
async function submitAuditorIntent(): Promise<void> {
  await renderAuditorStepTwo();
  await completeAuditorForm();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Tạo hồ sơ Kiểm toán viên" }));
  });
}

/** Đưa hồ sơ có đủ VND sang trạng thái VERIFYING bằng luồng đặt cọc tự động. */
async function submitAuditorStake(): Promise<void> {
  mockRegisterAuditorIntent.mockResolvedValue(createIntentResult("3000000"));
  mockExecuteAuditorStake.mockResolvedValue({ status: "VERIFYING", txHash: "0xstake" });
  await submitAuditorIntent();
  await waitFor(() => expect(mockExecuteAuditorStake).toHaveBeenCalledWith("auditor-access-token"));
}

describe("RegisterPage Auditor flow", () => {
  const mockFetch = vi.fn();
  const mockWindowOpen = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockExecuteAuditorStake.mockReset();
    mockGetAuditorOnboardingStatus.mockReset();
    mockRegisterAuditorIntent.mockReset();
    mockResumeAuditorIntent.mockReset();
    window.localStorage.clear();
    process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID = "client-id.apps.googleusercontent.com";
    installGoogleIdentity();
    vi.stubGlobal("fetch", mockFetch);
    vi.stubGlobal("open", mockWindowOpen);
    mockRegisterAuditorIntent.mockResolvedValue(createIntentResult());
    mockResumeAuditorIntent.mockRejectedValue({
      errorCode: "AUDITOR_ONBOARDING_NOT_FOUND",
      message: "Không tìm thấy hồ sơ Auditor đang chờ kích hoạt.",
    });
  });

  it("chọn Auditor từ query, hiển thị ba bước và không gửi role auditor tới google-login", async () => {
    await renderAuditorStepTwo();

    expect(screen.getByText(/Đặt cọc/)).toBeInTheDocument();
    await act(async () => googleCredentialCallback?.({ credential: "google-identity-token" }));

    expect(mockFetch).not.toHaveBeenCalledWith(expect.stringContaining("/auth/google-login"), expect.anything());
    expect(screen.getByText("✓ Đã xác thực Google")).toBeInTheDocument();
  });

  it("khôi phục đúng hồ sơ Auditor đang chờ cọc rồi đi thẳng đến bước nạp VND mà không yêu cầu nhập lại tài khoản nhận tiền", async () => {
    mockResumeAuditorIntent.mockResolvedValue(createIntentResult());
    await renderAuditorStepTwo();

    await act(async () => googleCredentialCallback?.({ credential: "google-identity-token" }));

    expect(mockResumeAuditorIntent).toHaveBeenCalledWith({ identityToken: "google-identity-token" });
    expect(mockRegisterAuditorIntent).not.toHaveBeenCalled();
    expect(mockPersistAuthSession).toHaveBeenCalledWith(expect.objectContaining({ accessToken: "auditor-access-token" }));
    expect(window.localStorage.getItem("dcpAuditorOnboardingIntentId")).toBe("intent-001");
    expect(await screen.findByRole("button", { name: "💳 Nạp 3.000.000 VND" })).toBeInTheDocument();
    expect(screen.queryByLabelText(/Ngân hàng nhận tiền/)).not.toBeInTheDocument();
  });

  it("tự đặt cọc khi khôi phục hồ sơ Auditor đã có đủ VND trong Smart Account", async () => {
    mockResumeAuditorIntent.mockResolvedValue(createIntentResult("3000000"));
    mockExecuteAuditorStake.mockResolvedValue({ status: "VERIFYING", txHash: "0xrestored-stake" });
    mockGetAuditorOnboardingStatus.mockResolvedValue({ status: "VERIFYING", failureReason: null });
    await renderAuditorStepTwo();

    await act(async () => googleCredentialCallback?.({ credential: "google-identity-token" }));

    await waitFor(() => expect(mockExecuteAuditorStake).toHaveBeenCalledWith("auditor-access-token"));
    expect(await screen.findByText(/0xrestored-stake/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "🔒 Đặt cọc VND" })).not.toBeInTheDocument();
  });

  it("chỉ hiện form tài khoản nhận tiền khi Google không sở hữu hồ sơ Auditor đang chờ cọc", async () => {
    await renderAuditorStepTwo();

    await act(async () => googleCredentialCallback?.({ credential: "google-identity-token" }));

    expect(mockResumeAuditorIntent).toHaveBeenCalledWith({ identityToken: "google-identity-token" });
    expect(screen.getByText("✓ Đã xác thực Google")).toBeInTheDocument();
    expect(screen.getByLabelText(/Ngân hàng nhận tiền/)).toBeInTheDocument();
    expect(screen.queryByText("Nạp VND & đặt cọc")).not.toBeInTheDocument();
  });

  it("không bỏ qua bước tài khoản nhận tiền khi tài khoản Google đã là Auditor hoạt động", async () => {
    mockResumeAuditorIntent.mockRejectedValue({
      errorCode: "ALREADY_AUDITOR",
      message: "Tài khoản Google này đã là Kiểm toán viên. Vui lòng đăng nhập để sử dụng quyền hiện có.",
    });
    await renderAuditorStepTwo();

    await act(async () => googleCredentialCallback?.({ credential: "google-identity-token" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("đã là Kiểm toán viên");
    expect(screen.queryByText("Nạp VND & đặt cọc")).not.toBeInTheDocument();
    expect(screen.queryByText("✓ Đã xác thực Google")).not.toBeInTheDocument();
    expect(mockRegisterAuditorIntent).not.toHaveBeenCalled();
  });

  it("validate payout account, chuẩn hóa tên và lưu session + intent khi tạo hồ sơ", async () => {
    await renderAuditorStepTwo();
    await completeAuditorForm();

    expect(screen.getByLabelText(/Chủ tài khoản/)).toHaveValue("NGUYEN VAN A");
    fireEvent.change(screen.getByLabelText(/Số tài khoản/), { target: { value: "12345" } });
    expect(screen.getByRole("button", { name: "Tạo hồ sơ Kiểm toán viên" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Số tài khoản/), { target: { value: "0123456789" } });
    fireEvent.click(screen.getByRole("button", { name: "Tạo hồ sơ Kiểm toán viên" }));

    await waitFor(() => expect(mockRegisterAuditorIntent).toHaveBeenCalledWith({
      identityToken: "google-identity-token",
      payoutAccount: {
        bankName: "Vietcombank",
        bankAccountNumber: "0123456789",
        accountHolderName: "NGUYEN VAN A",
        branchName: undefined,
      },
    }));
    expect(mockPersistAuthSession).toHaveBeenCalledWith(expect.objectContaining({ refreshTokenExpiresAt: "2026-08-25T00:00:00.000Z" }));
    expect(window.localStorage.getItem("dcpAuditorOnboardingIntentId")).toBe("intent-001");
    expect(screen.getByText("0xAudi...llet")).toBeInTheDocument();
    expect(screen.queryByText("0xAuditorWallet")).not.toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "💳 Nạp 3.000.000 VND" })).toBeInTheDocument();
  });

  it("chỉ hiển thị 6 ký tự đầu và 4 ký tự cuối của ví Smart Account Auditor", async () => {
    mockRegisterAuditorIntent.mockResolvedValue({
      ...createIntentResult(),
      walletAddress: "0x626cd7210b640e515178132c6ee63727ca08f364",
    });

    await submitAuditorIntent();

    expect(await screen.findByText("0x626c...f364")).toBeInTheDocument();
    expect(screen.queryByText("0x626cd7210b640e515178132c6ee63727ca08f364")).not.toBeInTheDocument();
  });

  it("tạo phiếu nạp đúng số tiền, giữ trạng thái chờ và xử lý phiếu hết hạn", async () => {
    await renderAuditorStepTwo();
    await completeAuditorForm();
    fireEvent.click(screen.getByRole("button", { name: "Tạo hồ sơ Kiểm toán viên" }));
    await screen.findByRole("button", { name: "💳 Nạp 3.000.000 VND" });
    mockFetch.mockResolvedValueOnce(createJsonResponse({ orderCode: "deposit-001", paymentUrl: "https://pay.example/deposit-001", status: "PENDING_PAYMENT" }));

    fireEvent.click(screen.getByRole("button", { name: "💳 Nạp 3.000.000 VND" }));

    await waitFor(() => expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/deposit/create"),
      expect.objectContaining({ body: JSON.stringify({ amountVnd: 3000000, paymentFlow: "AUDITOR_ONBOARDING" }) }),
    ));
    expect(mockWindowOpen).toHaveBeenCalledWith("https://pay.example/deposit-001", "_blank", "noopener,noreferrer");
    expect(await screen.findByText("deposit-001")).toBeInTheDocument();

    mockFetch.mockResolvedValueOnce(createJsonResponse({
      status: "PENDING_PAYMENT",
      paymentUrl: "https://pay.example/deposit-001",
      paymentExpiredAt: "2020-01-01T00:00:00.000Z",
    }));
    fireEvent.click(screen.getByRole("button", { name: "✅ Tôi đã thanh toán" }));

    expect(await screen.findByText(/Phiếu nạp đã hết hạn/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "💳 Nạp 3.000.000 VND" })).toBeInTheDocument();
  });

  it("từ chối URL thanh toán không phải HTTPS và không mở liên kết ngoài", async () => {
    await submitAuditorIntent();
    await screen.findByRole("button", { name: "💳 Nạp 3.000.000 VND" });
    mockFetch.mockResolvedValueOnce(createJsonResponse({
      orderCode: "deposit-malicious",
      paymentUrl: "javascript:alert('xss')",
      status: "PENDING_PAYMENT",
    }));

    fireEvent.click(screen.getByRole("button", { name: "💳 Nạp 3.000.000 VND" }));

    expect(await screen.findByText("Đường dẫn thanh toán không hợp lệ. Vui lòng tạo phiếu nạp mới.")).toBeInTheDocument();
    expect(mockWindowOpen).not.toHaveBeenCalled();
    expect(screen.queryByText("deposit-malicious")).not.toBeInTheDocument();
  });

  it("từ chối response tạo phiếu 2xx không có status PENDING_PAYMENT", async () => {
    await submitAuditorIntent();
    mockFetch.mockResolvedValueOnce(createJsonResponse({
      orderCode: "deposit-invalid-create-status",
      paymentUrl: "https://pay.example/invalid-create-status",
      status: "PROCESSING",
    }));

    fireEvent.click(await screen.findByRole("button", { name: "💳 Nạp 3.000.000 VND" }));

    expect(await screen.findByText("Không thể tạo phiếu nạp VND. Vui lòng thử lại.")).toBeInTheDocument();
    expect(mockWindowOpen).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "💳 Nạp 3.000.000 VND" })).toBeInTheDocument();
  });

  it("không ghi đè liên kết thanh toán an toàn bằng URL không hợp lệ từ truy vấn trạng thái", async () => {
    await submitAuditorIntent();
    mockFetch
      .mockResolvedValueOnce(createJsonResponse({
        orderCode: "deposit-safe",
        paymentUrl: "https://pay.example/deposit-safe",
        status: "PENDING_PAYMENT",
      }))
      .mockResolvedValueOnce(createJsonResponse({
        status: "PENDING_PAYMENT",
        paymentUrl: "javascript:alert('xss')",
      }));

    fireEvent.click(await screen.findByRole("button", { name: "💳 Nạp 3.000.000 VND" }));
    const paymentLink = await screen.findByRole("link", { name: "Mở lại trang thanh toán" });
    expect(paymentLink).toHaveAttribute("href", "https://pay.example/deposit-safe");

    fireEvent.click(screen.getByRole("button", { name: "✅ Tôi đã thanh toán" }));

    expect(await screen.findByText("Đường dẫn thanh toán không hợp lệ. Vui lòng tạo phiếu nạp mới.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Mở lại trang thanh toán" })).toHaveAttribute("href", "https://pay.example/deposit-safe");
  });

  it("hiển thị đăng ký thành công rồi tự chuyển Auditor sang trang đăng nhập", async () => {
    await renderAuditorStepTwo();
    await completeAuditorForm();
    fireEvent.click(screen.getByRole("button", { name: "Tạo hồ sơ Kiểm toán viên" }));
    await screen.findByRole("button", { name: "💳 Nạp 3.000.000 VND" });
    mockFetch
      .mockResolvedValueOnce(createJsonResponse({ orderCode: "deposit-002", paymentUrl: "https://pay.example/deposit-002", status: "PENDING_PAYMENT" }))
      .mockResolvedValueOnce(createJsonResponse({ status: "MINT_COMPLETED", paymentExpiredAt: "2099-01-01T00:00:00.000Z" }))
      .mockResolvedValueOnce(createJsonResponse({ tokenBalance: 3000000 }));
    mockExecuteAuditorStake.mockResolvedValue({ status: "VERIFYING", txHash: "0xstake" });
    mockGetAuditorOnboardingStatus.mockResolvedValue({ status: "ACTIVATED", failureReason: null });

    fireEvent.click(screen.getByRole("button", { name: "💳 Nạp 3.000.000 VND" }));
    await screen.findByRole("button", { name: "✅ Tôi đã thanh toán" });
    fireEvent.click(screen.getByRole("button", { name: "✅ Tôi đã thanh toán" }));
    await waitFor(() => expect(mockExecuteAuditorStake).toHaveBeenCalledWith("auditor-access-token"));
    await screen.findByText("🎉 Bạn đã là Kiểm toán viên!");
    vi.useFakeTimers();
    try {
      expect(screen.getByText("🎉 Bạn đã là Kiểm toán viên!")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "→ Đăng nhập ngay" })).toHaveAttribute("href", "/login");
      expect(mockClearAuthSession).toHaveBeenCalledTimes(1);
      expect(window.localStorage.getItem("dcpAuditorOnboardingIntentId")).toBeNull();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
      });

    } finally {
      vi.useRealTimers();
    }
  });

  it("trả từ PayOS về /register thì đối soát, stake on-chain và cấp quyền Auditor", async () => {
    window.localStorage.setItem("dcpAuditorOnboardingIntentId", "intent-return");
    window.localStorage.setItem("dcpAuditorOnboardingStakeThreshold", "3000000");
    window.localStorage.setItem("dcpAuditorOnboardingWalletAddress", "0x626cd7210b640e515178132c6ee63727ca08f364");
    window.history.pushState(
      {},
      "",
      "/register?role=auditor&paymentFlow=auditor_onboarding&paymentStatus=success&orderCode=1787650889515545"
    );
    mockFetch
      .mockResolvedValueOnce(createJsonResponse({ status: "MINT_COMPLETED", paymentExpiredAt: "2020-01-01T00:00:00.000Z" }))
      .mockResolvedValueOnce(createJsonResponse({ tokenBalance: 3000000 }));
    mockExecuteAuditorStake.mockResolvedValue({ status: "VERIFYING", txHash: "0xauto-stake" });
    mockGetAuditorOnboardingStatus.mockResolvedValue({ status: "ACTIVATED", failureReason: null });

    render(<RegisterPage />);

    await waitFor(() => expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/deposit/1787650889515545?reconcile=true"),
      expect.objectContaining({ method: "GET" }),
    ));
    expect(screen.getByText("0x626c...f364")).toBeInTheDocument();
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/deposit/balance"),
      expect.objectContaining({ method: "GET" }),
    );
    await waitFor(() => expect(mockExecuteAuditorStake).toHaveBeenCalledWith("auditor-access-token"));
    await waitFor(() => expect(mockGetAuditorOnboardingStatus).toHaveBeenCalledWith("auditor-access-token", "intent-return"));
    expect(await screen.findByRole("link", { name: "→ Đăng nhập ngay" })).toHaveAttribute("href", "/login");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("khôi phục bước đặt cọc khi PayOS trả các tham số PAID thực tế", async () => {
    window.localStorage.setItem("dcpAuditorOnboardingIntentId", "intent-payos-paid");
    window.localStorage.setItem("dcpAuditorOnboardingStakeThreshold", "3000000");
    window.localStorage.setItem("dcpAuditorOnboardingWalletAddress", "0x626cd7210b640e515178132c6ee63727ca08f364");
    window.history.pushState(
      {},
      "",
      "/register?andpaymentStatus=success&role=auditor&paymentFlow=auditor_onboarding&orderCode=1787658059328144&code=00&id=714059b481de46e19c841df2c5ca2544&cancel=false&status=PAID"
    );
    mockFetch
      .mockResolvedValueOnce(createJsonResponse({ status: "MINT_COMPLETED" }))
      .mockResolvedValueOnce(createJsonResponse({ tokenBalance: 3000000 }));
    mockExecuteAuditorStake.mockResolvedValue({ status: "VERIFYING", txHash: "0xpayos-auto-stake" });
    mockGetAuditorOnboardingStatus.mockResolvedValue({ status: "ACTIVATED", failureReason: null });

    render(<RegisterPage />);

    await waitFor(() => expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/deposit/1787658059328144?reconcile=true"),
      expect.objectContaining({ method: "GET" }),
    ));
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/deposit/balance"),
      expect.objectContaining({ method: "GET" }),
    );
    await waitFor(() => expect(mockExecuteAuditorStake).toHaveBeenCalledWith("auditor-access-token"));
    await waitFor(() => expect(mockGetAuditorOnboardingStatus).toHaveBeenCalledWith("auditor-access-token", "intent-payos-paid"));
    expect(await screen.findByRole("link", { name: "→ Đăng nhập ngay" })).toHaveAttribute("href", "/login");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["PayOS báo hủy", "/register?role=auditor&paymentFlow=auditor_onboarding&paymentStatus=success&orderCode=1787658059328144&cancel=true"],
    ["thiếu paymentFlow Auditor", "/register?role=auditor&paymentStatus=success&orderCode=1787658059328144&cancel=false"],
    ["orderCode không hợp lệ", "/register?role=auditor&paymentFlow=auditor_onboarding&paymentStatus=success&orderCode=not-a-number&cancel=false"],
  ])("không đối soát hoặc stake khi callback %s không hợp lệ", async (_scenario, callbackUrl) => {
    window.localStorage.setItem("dcpAuditorOnboardingIntentId", "intent-invalid-callback");
    window.localStorage.setItem("dcpAuditorOnboardingStakeThreshold", "3000000");
    window.history.pushState({}, "", callbackUrl);

    render(<RegisterPage />);
    await waitFor(() => expect(googleCredentialCallback).toBeDefined());

    expect(screen.getByRole("button", { name: /Kiểm toán viên/ })).toBeInTheDocument();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockExecuteAuditorStake).not.toHaveBeenCalled();
  });

  it("thử lại UserOperation một lần khi giao dịch đặt cọc lỗi tạm thời", async () => {
    window.localStorage.setItem("dcpAuditorOnboardingIntentId", "intent-auto-stake-failed");
    window.localStorage.setItem("dcpAuditorOnboardingStakeThreshold", "3000000");
    window.history.pushState(
      {},
      "",
      "/register?role=auditor&paymentFlow=auditor_onboarding&paymentStatus=success&orderCode=1787658059328145"
    );
    mockFetch
      .mockResolvedValueOnce(createJsonResponse({ status: "MINT_COMPLETED" }))
      .mockResolvedValueOnce(createJsonResponse({ tokenBalance: 3000000 }));
    mockExecuteAuditorStake
      .mockRejectedValueOnce({ message: "Paymaster unavailable" })
      .mockResolvedValueOnce({ status: "VERIFYING", txHash: "0xretry" });

    render(<RegisterPage />);

    expect(await screen.findByText(/Hệ thống sẽ tự thử lại một lần/)).toBeInTheDocument();
    await waitFor(() => expect(mockExecuteAuditorStake).toHaveBeenCalledTimes(2), { timeout: 7_000 });
    expect(screen.queryByRole("button", { name: "🔒 Đặt cọc VND" })).not.toBeInTheDocument();
  }, 8_000);

  it("không gửi stake tự động lần hai khi xác minh on-chain tạm trả PENDING_TX", async () => {
    window.localStorage.setItem("dcpAuditorOnboardingIntentId", "intent-auto-pending");
    window.localStorage.setItem("dcpAuditorOnboardingStakeThreshold", "3000000");
    window.history.pushState(
      {},
      "",
      "/register?role=auditor&paymentFlow=auditor_onboarding&paymentStatus=success&orderCode=1787658059328146"
    );
    mockFetch
      .mockResolvedValueOnce(createJsonResponse({ status: "MINT_COMPLETED" }))
      .mockResolvedValueOnce(createJsonResponse({ tokenBalance: 3000000 }))
      .mockResolvedValueOnce(createJsonResponse({ tokenBalance: 3000000 }));
    mockExecuteAuditorStake.mockResolvedValue({ status: "VERIFYING", txHash: "0xauto-pending" });
    mockGetAuditorOnboardingStatus.mockResolvedValue({ status: "PENDING_TX", failureReason: null });

    render(<RegisterPage />);

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(3));
    expect(mockExecuteAuditorStake).toHaveBeenCalledTimes(1);
    expect(mockGetAuditorOnboardingStatus).toHaveBeenCalledWith("auditor-access-token", "intent-auto-pending");
  });

  it("trả từ PayOS vẫn đối soát và mint khi thiếu dữ liệu local, nhưng chặn stake an toàn", async () => {
    window.localStorage.setItem("dcpAuditorOnboardingIntentId", "intent-missing-threshold");
    window.history.pushState(
      {},
      "",
      "/register?role=auditor&paymentFlow=auditor_onboarding&paymentStatus=success&orderCode=1787650889515546"
    );
    mockFetch.mockResolvedValueOnce(createJsonResponse({ status: "MINT_COMPLETED" }));

    render(<RegisterPage />);

    await waitFor(() => expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/deposit/1787650889515546?reconcile=true"),
      expect.objectContaining({ method: "GET" }),
    ));
    expect(await screen.findByText(/Đã xác nhận thanh toán và phát VND vào ví/)).toBeInTheDocument();
    expect(mockFetch).not.toHaveBeenCalledWith(expect.stringContaining("/api/deposit/balance"), expect.anything());
    expect(screen.queryByRole("button", { name: "🔒 Đặt cọc VND" })).not.toBeInTheDocument();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("trả từ PayOS khi backend còn PAYMENT_CONFIRMED thì giữ màn hình chờ và không đọc số dư sớm", async () => {
    window.localStorage.setItem("dcpAuditorOnboardingIntentId", "intent-payment-confirmed");
    window.localStorage.setItem("dcpAuditorOnboardingStakeThreshold", "3000000");
    window.history.pushState(
      {},
      "",
      "/register?role=auditor&paymentFlow=auditor_onboarding&paymentStatus=success&orderCode=1787650889515547"
    );
    mockFetch.mockResolvedValueOnce(createJsonResponse({ status: "PAYMENT_CONFIRMED" }));

    render(<RegisterPage />);

    expect(await screen.findByText(/Đã nhận thanh toán, đang cập nhật số dư VND/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "✅ Tôi đã thanh toán" })).toBeInTheDocument();
    expect(mockFetch).not.toHaveBeenCalledWith(expect.stringContaining("/api/deposit/balance"), expect.anything());
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("ưu tiên bước 3 và giữ intent Auditor khi PayOS trả về URL thành công", async () => {
    window.localStorage.setItem("dcpAuditorOnboardingIntentId", "intent-return-preserved");
    window.localStorage.setItem("dcpAuditorOnboardingStakeThreshold", "3000000");
    window.localStorage.setItem("dcpAuditorOnboardingWalletAddress", "0x626cd7210b640e515178132c6ee63727ca08f364");
    window.history.pushState(
      {},
      "",
      "/register?paymentStatus=success&role=auditor&paymentFlow=auditor_onboarding&orderCode=1787660988343902&code=00&id=a21533c1d3e44fac97b60bea5af10666&cancel=false&status=PAID"
    );
    mockFetch.mockResolvedValueOnce(createJsonResponse({ status: "PAYMENT_CONFIRMED" }));

    render(<RegisterPage />);

    expect(await screen.findByText(/Đã nhận thanh toán, đang cập nhật số dư VND/)).toBeInTheDocument();
    expect(window.localStorage.getItem("dcpAuditorOnboardingIntentId")).toBe("intent-return-preserved");
    expect(screen.queryByText("Chọn vai trò")).not.toBeInTheDocument();
  });

  it("hiển thị popup hỗ trợ khi PayOS đã xác nhận nhưng mint token on-chain thất bại", async () => {
    window.localStorage.setItem("dcpAuditorOnboardingIntentId", "intent-mint-failed");
    window.localStorage.setItem("dcpAuditorOnboardingStakeThreshold", "3000000");
    window.history.pushState(
      {},
      "",
      "/register?role=auditor&paymentFlow=auditor_onboarding&paymentStatus=success&orderCode=1787650889515549"
    );
    mockFetch.mockResolvedValueOnce(createJsonResponse({
      status: "FAILED",
      failureReason: "Mint token thất bại sau khi đã retry tối đa.",
      isPaymentConfirmedButMintFailed: true,
    }));

    render(<RegisterPage />);

    expect(await screen.findByRole("dialog", { name: "Thanh toán đã được xác nhận" })).toHaveTextContent("036740032");
    expect(screen.queryByRole("button", { name: /Nạp .* VND/ })).not.toBeInTheDocument();
    expect(mockExecuteAuditorStake).not.toHaveBeenCalled();
  });

  it.each([
    ["phiếu bị hủy", "/register?role=auditor&paymentFlow=auditor_onboarding&paymentStatus=cancel&orderCode=1787650889515548"],
    ["payment flow khác", "/register?role=auditor&paymentFlow=standard&paymentStatus=success&orderCode=1787650889515548"],
    ["orderCode không phải số", "/register?role=auditor&paymentFlow=auditor_onboarding&paymentStatus=success&orderCode=invalid-order"],
    ["orderCode vượt giới hạn độ dài", "/register?role=auditor&paymentFlow=auditor_onboarding&paymentStatus=success&orderCode=123456789012345678901"],
    ["không có role Auditor", "/register?paymentFlow=auditor_onboarding&paymentStatus=success&orderCode=1787650889515548"],
    ["PayOS báo cáo hủy dù có status PAID", "/register?role=auditor&paymentFlow=auditor_onboarding&code=00&status=PAID&cancel=true&orderCode=1787650889515548"],
  ])("không tự đối soát khi return PayOS không hợp lệ: %s", async (_scenario, returnUrl) => {
    window.localStorage.setItem("dcpAuditorOnboardingStakeThreshold", "3000000");
    window.history.pushState({}, "", returnUrl);

    render(<RegisterPage />);

    await waitFor(() => expect(googleCredentialCallback).toBeDefined());
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("luôn yêu cầu đăng nhập lại sau khi quyền Auditor được kích hoạt", async () => {
    mockRegisterAuditorIntent.mockResolvedValue(createIntentResult("3000000"));
    mockExecuteAuditorStake.mockResolvedValue({ status: "VERIFYING", txHash: "0xstake" });
    mockGetAuditorOnboardingStatus.mockResolvedValue({ status: "ACTIVATED", failureReason: null });
    await renderAuditorStepTwo();
    await completeAuditorForm();
    fireEvent.click(screen.getByRole("button", { name: "Tạo hồ sơ Kiểm toán viên" }));
    await waitFor(() => expect(mockExecuteAuditorStake).toHaveBeenCalledWith("auditor-access-token"));
    expect(await screen.findByRole("link", { name: "→ Đăng nhập ngay" })).toHaveAttribute("href", "/login");
    expect(mockClearAuthSession).toHaveBeenCalledTimes(1);
    expect(mockRouterPush).not.toHaveBeenCalledWith("/auditor");
  });

  it("chỉ cho tạo hồ sơ khi đủ Google, điều khoản và toàn bộ biên validation tài khoản nhận tiền", async () => {
    await renderAuditorStepTwo();
    const submitButton = screen.getByRole("button", { name: "Tạo hồ sơ Kiểm toán viên" });
    const accountNumberInput = screen.getByLabelText(/Số tài khoản/);
    const accountHolderInput = screen.getByLabelText(/Chủ tài khoản/);
    const branchInput = screen.getByLabelText(/Chi nhánh/);

    expect(submitButton).toBeDisabled();
    fireEvent.click(screen.getByText(/Tôi đồng ý với/));
    await act(async () => googleCredentialCallback?.({ credential: "google-identity-token" }));
    fireEvent.change(screen.getByLabelText(/Ngân hàng nhận tiền/), { target: { value: "Vietcombank" } });
    fireEvent.change(accountNumberInput, { target: { value: "1234567" } });
    fireEvent.change(accountHolderInput, { target: { value: "A" } });
    expect(submitButton).toBeDisabled();

    fireEvent.change(accountNumberInput, { target: { value: "12345678" } });
    fireEvent.change(accountHolderInput, { target: { value: "Nguyễn Văn A" } });
    fireEvent.change(branchInput, { target: { value: "x".repeat(201) } });
    expect(submitButton).toBeDisabled();

    fireEvent.change(branchInput, { target: { value: "x".repeat(200) } });
    expect(accountHolderInput).toHaveValue("NGUYEN VAN A");
    expect(submitButton).toBeEnabled();

    fireEvent.change(accountNumberInput, { target: { value: "123456789012345678901" } });
    expect(submitButton).toBeDisabled();
    fireEvent.change(accountNumberInput, { target: { value: "12345678901234567890" } });
    expect(submitButton).toBeEnabled();
  });

  it("không gọi API khi Google không trả credential", async () => {
    await renderAuditorStepTwo();

    act(() => googleCredentialCallback?.({}));

    expect(await screen.findByText(/Không nhận được thông tin đăng ký từ Google/)).toBeInTheDocument();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockRegisterAuditorIntent).not.toHaveBeenCalled();
  });

  it("khôi phục intent Auditor từ URL rồi xóa intent khi người dùng đổi vai trò", async () => {
    window.localStorage.setItem("dcpAuditorOnboardingIntentId", "intent-resume");
    window.history.pushState({}, "", "/register?role=auditor");
    render(<RegisterPage />);

    await waitFor(() => expect(googleCredentialCallback).toBeDefined());
    await waitFor(() => expect(window.localStorage.getItem("dcpAuditorOnboardingIntentId")).toBe("intent-resume"));
    fireEvent.click(screen.getByText("Nhà hảo tâm").closest("button") as HTMLButtonElement);

    expect(window.localStorage.getItem("dcpAuditorOnboardingIntentId")).toBeNull();
  });

  it("gửi tạo hồ sơ bằng Enter ở bước Auditor hợp lệ", async () => {
    await renderAuditorStepTwo();
    await completeAuditorForm();

    await act(async () => {
      fireEvent.keyDown(screen.getByRole("presentation"), { key: "Enter" });
    });

    expect(mockRegisterAuditorIntent).toHaveBeenCalledOnce();
  });

  it("tự gửi stake khi số dư đã đạt ngưỡng", async () => {
    mockRegisterAuditorIntent.mockResolvedValue(createIntentResult("3000000"));
    mockExecuteAuditorStake.mockResolvedValue({ status: "VERIFYING", txHash: "0xenter-stake" });
    await submitAuditorIntent();

    await waitFor(() => expect(mockExecuteAuditorStake).toHaveBeenCalledWith("auditor-access-token"));
    expect(await screen.findByText(/0xenter-stake/)).toBeInTheDocument();
  });

  it.each([
    [{ errorCode: "RATE_LIMIT_EXCEEDED", message: "ignored" }, /sau khoảng 1 giờ/],
    [{ errorCode: "UNAUTHENTICATED", message: "ignored" }, /phiên xác thực Google đã hết hạn/i],
    [{ errorCode: "EMAIL_EXISTS", message: "Email đã tồn tại." }, "Email đã tồn tại."],
  ])("hiển thị lỗi tạo hồ sơ Auditor theo mã API %o", async (apiError, expectedMessage) => {
    mockRegisterAuditorIntent.mockRejectedValueOnce(apiError);
    await submitAuditorIntent();

    expect(await screen.findByText(expectedMessage)).toBeInTheDocument();
    expect(mockPersistAuthSession).not.toHaveBeenCalled();
    if (apiError.errorCode === "UNAUTHENTICATED") {
      expect(screen.getByText(/Vui lòng xác thực Google trước khi tạo hồ sơ/)).toBeInTheDocument();
    }
  });

  it("giữ nguyên bước nạp và hiển thị lỗi backend khi tạo hoặc kiểm tra phiếu nạp thất bại", async () => {
    await submitAuditorIntent();
    await screen.findByRole("button", { name: "💳 Nạp 3.000.000 VND" });
    mockFetch.mockResolvedValueOnce(createJsonResponse({ message: "PayOS tạm thời không khả dụng." }, false));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "💳 Nạp 3.000.000 VND" }));
    });

    expect(await screen.findByText("PayOS tạm thời không khả dụng.")).toBeInTheDocument();
    expect(mockWindowOpen).not.toHaveBeenCalled();

    mockFetch.mockResolvedValueOnce(createJsonResponse({ orderCode: "deposit-error", paymentUrl: "https://pay.example/error", status: "PENDING_PAYMENT" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "💳 Nạp 3.000.000 VND" }));
    });
    await screen.findByRole("button", { name: "✅ Tôi đã thanh toán" });
    mockFetch.mockResolvedValueOnce(createJsonResponse({ message: "Không tìm thấy phiếu nạp." }, false));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "✅ Tôi đã thanh toán" }));
    });

    expect(await screen.findByText("Không tìm thấy phiếu nạp.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "✅ Tôi đã thanh toán" })).toBeInTheDocument();
  });

  it("xử lý đủ trạng thái PayOS: chờ thanh toán, đã xác nhận và thất bại", async () => {
    await submitAuditorIntent();
    await screen.findByRole("button", { name: "💳 Nạp 3.000.000 VND" });
    mockFetch
      .mockResolvedValueOnce(createJsonResponse({ orderCode: "deposit-status", paymentUrl: "https://pay.example/status", status: "PENDING_PAYMENT" }))
      .mockResolvedValueOnce(createJsonResponse({ status: "PENDING_PAYMENT", paymentExpiredAt: "2099-01-01T00:00:00.000Z" }))
      .mockResolvedValueOnce(createJsonResponse({ status: "PAYMENT_CONFIRMED", paymentExpiredAt: "2099-01-01T00:00:00.000Z" }))
      .mockResolvedValueOnce(createJsonResponse({ status: "FAILED", failureReason: "Ngân hàng từ chối thanh toán." }));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "💳 Nạp 3.000.000 VND" }));
    });
    await screen.findByRole("button", { name: "✅ Tôi đã thanh toán" });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "✅ Tôi đã thanh toán" }));
    });
    expect(await screen.findByText(/Chưa nhận được thanh toán/)).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "✅ Tôi đã thanh toán" }));
    });
    expect(await screen.findByText(/Đã nhận thanh toán, đang cập nhật số dư VND/)).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "✅ Tôi đã thanh toán" }));
    });
    expect(await screen.findByText(/Ngân hàng từ chối thanh toán/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "💳 Nạp 3.000.000 VND" })).toBeInTheDocument();
  });

  it.each([
    ["status không thuộc contract", { status: "PROCESSING" }],
    ["hạn thanh toán sai định dạng", { status: "PENDING_PAYMENT", paymentExpiredAt: "invalid-date" }],
    ["lý do thất bại sai kiểu", { status: "FAILED", failureReason: { code: "PAYOS_ERROR" } }],
  ])("giữ phiếu đang chờ và hiển thị fallback khi API deposit trả 2xx với %s", async (_scenario, invalidResponse) => {
    await submitAuditorIntent();
    mockFetch
      .mockResolvedValueOnce(createJsonResponse({
        orderCode: "deposit-unknown-status",
        paymentUrl: "https://pay.example/unknown-status",
        status: "PENDING_PAYMENT",
      }))
      .mockResolvedValueOnce(createJsonResponse(invalidResponse));

    fireEvent.click(await screen.findByRole("button", { name: "💳 Nạp 3.000.000 VND" }));
    await screen.findByRole("button", { name: "✅ Tôi đã thanh toán" });
    fireEvent.click(screen.getByRole("button", { name: "✅ Tôi đã thanh toán" }));

    expect(await screen.findByText("Không thể kiểm tra phiếu nạp VND. Vui lòng thử lại.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Mở lại trang thanh toán" })).toHaveAttribute("href", "https://pay.example/unknown-status");
    expect(screen.getByRole("button", { name: "✅ Tôi đã thanh toán" })).toBeInTheDocument();
  });

  it("đọc lại số dư với header xác thực, giữ bước nạp khi thiếu VND và tự đặt cọc khi đủ", async () => {
    await submitAuditorIntent();
    await screen.findByRole("button", { name: "💳 Nạp 3.000.000 VND" });
    mockFetch
      .mockResolvedValueOnce(createJsonResponse({ tokenBalance: "2000000" }))
      .mockResolvedValueOnce(createJsonResponse({ tokenBalance: "3000000" }));
    mockExecuteAuditorStake.mockResolvedValue({ status: "VERIFYING", txHash: "0xbalance-stake" });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "🔄 Kiểm tra lại số dư" }));
    });
    await waitFor(() => expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/deposit/balance"),
      expect.objectContaining({ headers: { Authorization: "Bearer auditor-access-token" } }),
    ));
    expect(screen.getByRole("button", { name: "💳 Nạp 1.000.000 VND" })).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "🔄 Kiểm tra lại số dư" }));
    });
    await waitFor(() => expect(mockExecuteAuditorStake).toHaveBeenCalledWith("auditor-access-token"));
    expect(screen.queryByRole("button", { name: "🔒 Đặt cọc VND" })).not.toBeInTheDocument();
  });

  it("hiển thị fallback khi số dư trả về sai định dạng hoặc request nạp bị lỗi mạng", async () => {
    await submitAuditorIntent();
    await screen.findByRole("button", { name: "💳 Nạp 3.000.000 VND" });
    mockFetch.mockResolvedValueOnce(createJsonResponse({ tokenBalance: "không-phải-số" }));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "🔄 Kiểm tra lại số dư" }));
    });
    expect(await screen.findByText(/Không thể đọc số dư VND/)).toBeInTheDocument();

    mockFetch.mockResolvedValueOnce(createJsonResponse({ tokenBalance: -1 }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "🔄 Kiểm tra lại số dư" }));
    });
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/Không thể đọc số dư VND/)).toBeInTheDocument();

    mockFetch.mockResolvedValueOnce(createJsonResponse({ tokenBalance: 1.5 }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "🔄 Kiểm tra lại số dư" }));
    });
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(3));
    expect(await screen.findByText(/Không thể đọc số dư VND/)).toBeInTheDocument();

    mockFetch.mockRejectedValueOnce(new Error("network unavailable"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "💳 Nạp 3.000.000 VND" }));
    });
    expect(await screen.findByText(/Không thể tạo phiếu nạp VND/)).toBeInTheDocument();
  });

  it("không gửi payment request khi số DCT cần nạp vượt giới hạn Number an toàn", async () => {
    mockRegisterAuditorIntent.mockResolvedValue({
      ...createIntentResult(),
      minimumStakeThreshold: "9007199254740992",
      currentTokenBalance: "0",
    });
    await submitAuditorIntent();

    expect(await screen.findByText("Số VND cần nạp vượt giới hạn thanh toán. Vui lòng liên hệ hỗ trợ.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "💳 Số VND vượt giới hạn" })).toBeDisabled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("đọc chính xác số dư DCT lớn khi API trả decimal string", async () => {
    const largeDctBalance = "9007199254740993";
    mockRegisterAuditorIntent.mockResolvedValue({
      ...createIntentResult(),
      minimumStakeThreshold: largeDctBalance,
      currentTokenBalance: "0",
    });
    await submitAuditorIntent();
    mockFetch.mockResolvedValueOnce(createJsonResponse({ tokenBalance: largeDctBalance }));
    mockExecuteAuditorStake.mockResolvedValue({ status: "VERIFYING", txHash: "0xlarge-stake" });

    fireEvent.click(await screen.findByRole("button", { name: "🔄 Kiểm tra lại số dư" }));

    await waitFor(() => expect(mockExecuteAuditorStake).toHaveBeenCalledWith("auditor-access-token"));
  });

  it("giữ luồng nạp khi Mint hoàn tất nhưng số dư mới vẫn chưa đạt ngưỡng và khi đọc lại số dư lỗi mạng", async () => {
    await submitAuditorIntent();
    await screen.findByRole("button", { name: "💳 Nạp 3.000.000 VND" });
    mockFetch
      .mockResolvedValueOnce(createJsonResponse({ orderCode: "deposit-low", paymentUrl: "https://pay.example/low", status: "PENDING_PAYMENT" }))
      .mockResolvedValueOnce(createJsonResponse({ status: "MINT_COMPLETED" }))
      .mockResolvedValueOnce(createJsonResponse({ tokenBalance: "2999999" }));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "💳 Nạp 3.000.000 VND" }));
    });
    await screen.findByRole("button", { name: "✅ Tôi đã thanh toán" });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "✅ Tôi đã thanh toán" }));
    });
    expect(await screen.findByRole("button", { name: "💳 Nạp 10.000 VND" })).toBeInTheDocument();

    mockFetch.mockRejectedValueOnce(new Error("network unavailable"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "🔄 Kiểm tra lại số dư" }));
    });
    expect(await screen.findByText(/Không thể đọc số dư VND/)).toBeInTheDocument();
  });

  it("quay lại bước nạp khi tự stake phát hiện thiếu VND", async () => {
    mockRegisterAuditorIntent.mockResolvedValue(createIntentResult("3000000"));
    mockExecuteAuditorStake.mockRejectedValueOnce({
      errorCode: "INSUFFICIENT_TOKEN_BALANCE",
      message: "Số dư DCT không đủ.",
    });
    await submitAuditorIntent();
    expect(await screen.findByText("Số dư VND không đủ để đặt cọc. Vui lòng nạp thêm VND.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "💳 Nạp 3.000.000 VND" })).toBeInTheDocument();
  });

  it("dừng sau hai lần tự stake lỗi thông thường và không hiển thị nút stake thủ công", async () => {
    mockRegisterAuditorIntent.mockResolvedValue(createIntentResult("3000000"));
    mockExecuteAuditorStake.mockRejectedValue({ message: "RPC không phản hồi." });
    await submitAuditorIntent();
    expect(await screen.findByText(/Hệ thống sẽ tự thử lại một lần/)).toBeInTheDocument();
    await waitFor(() => expect(mockExecuteAuditorStake).toHaveBeenCalledTimes(2), { timeout: 7_000 });
    expect(await screen.findByText("RPC không phản hồi.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "🔒 Đặt cọc VND" })).not.toBeInTheDocument();
  }, 8_000);

  it("gửi lại cọc khi người dùng kiểm tra trạng thái và intent vẫn PENDING_TX", async () => {
    mockRegisterAuditorIntent.mockResolvedValue(createIntentResult("3000000"));
    mockExecuteAuditorStake.mockRejectedValue(new Error("Bundler tạm thời không phản hồi."));
    await submitAuditorIntent();
    await waitFor(() => expect(mockExecuteAuditorStake).toHaveBeenCalledTimes(2), { timeout: 7_000 });

    mockGetAuditorOnboardingStatus.mockResolvedValue({ status: "PENDING_TX", failureReason: null });
    mockFetch.mockResolvedValue(createJsonResponse({ tokenBalance: "3000000" }));
    mockExecuteAuditorStake.mockResolvedValue({ status: "VERIFYING", txHash: "0xmanual-retry" });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "🔄 Kiểm tra trạng thái" }));
    });

    await waitFor(() => expect(mockExecuteAuditorStake).toHaveBeenCalledTimes(3));
    expect(mockGetAuditorOnboardingStatus).toHaveBeenCalledWith("auditor-access-token", "intent-001");
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/deposit/balance"),
      expect.objectContaining({ method: "GET" }),
    );
  }, 8_000);

  it("đọc lại số dư on-chain khi intent quay về PENDING_TX thay vì tự cho phép đặt cọc", async () => {
    mockGetAuditorOnboardingStatus.mockResolvedValue({ status: "PENDING_TX", failureReason: null });
    mockFetch.mockResolvedValueOnce(createJsonResponse({ tokenBalance: "0" }));
    await submitAuditorStake();

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/deposit/balance"),
      expect.objectContaining({ method: "GET" }),
    );
    expect(await screen.findByRole("button", { name: "💳 Nạp 3.000.000 VND" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "🔒 Đặt cọc VND" })).not.toBeInTheDocument();
  });

  it.each([
    ["VERIFYING", "Đang xác minh cọc on-chain"],
  ])("phản ánh trạng thái onboarding %s từ blockchain", async (status, expectedMessage) => {
    mockGetAuditorOnboardingStatus.mockResolvedValue({ status, failureReason: null });
    await submitAuditorStake();

    expect(await screen.findByText(new RegExp(expectedMessage))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "🔄 Kiểm tra trạng thái" })).toBeInTheDocument();
  });

  it.each([
    "TX_REVERTED_OR_TIMEOUT",
    "VERIFICATION_TIMEOUT_24H",
    "UNKNOWN_FAILURE",
  ])("tự thử lại khi xác minh onboarding trả %s mà không mở nút stake thủ công", async (failureReason) => {
    mockGetAuditorOnboardingStatus.mockResolvedValue({ status: "FAILED", failureReason });
    await submitAuditorStake();

    expect(await screen.findByText(/Hệ thống sẽ tự thử lại một lần/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "🔒 Đặt cọc VND" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "🔄 Kiểm tra trạng thái" })).toBeInTheDocument();
  });

  it("giữ trạng thái xác minh và hiển thị fallback khi API trạng thái onboarding lỗi", async () => {
    mockGetAuditorOnboardingStatus.mockRejectedValueOnce({ message: "Blockchain gateway lỗi." });
    await submitAuditorStake();

    expect(await screen.findByText("Blockchain gateway lỗi.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "🔄 Kiểm tra trạng thái" })).toBeInTheDocument();
  });

});
