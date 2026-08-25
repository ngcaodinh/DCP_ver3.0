import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPersistAuthSession, mockRouterPush } = vi.hoisted(() => ({
  mockPersistAuthSession: vi.fn(),
  mockRouterPush: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mockRouterPush }) }));
vi.mock("@/app/components/AuthLegalModal", () => ({ default: () => null }));
vi.mock("@/app/utils/authSession", () => ({
  persistAuthSession: mockPersistAuthSession,
  readAuthSession: () => ({ accessToken: "organization-access-token" }),
}));
vi.mock("@/app/utils/authSessionRefresh", () => ({ refreshAuthSession: vi.fn() }));
vi.mock("@/app/utils/auditorOnboarding", () => ({
  executeAuditorStake: vi.fn(),
  getAuditorOnboardingStatus: vi.fn(),
  registerAuditorIntent: vi.fn(),
}));

import RegisterPage from "@/app/register/page";

let googleCredentialCallback: ((response: { credential?: string }) => void) | undefined;

/** Cài Google Identity giả để xác minh hai luồng đăng ký cũ không bị thay đổi. */
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

/** Tạo response google-login thành công theo role backend trả về. */
function createGoogleLoginResponse(role: "donor" | "organization"): { ok: boolean; json: () => Promise<unknown> } {
  return {
    ok: true,
    json: vi.fn().mockResolvedValue({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      csrfToken: "csrf-token",
      refreshSessionId: "refresh-session-id",
      expiresAt: "2026-08-25T00:00:00.000Z",
      user: { role, walletAddress: "0xwallet", email: "user@example.com" },
    }),
  };
}

describe("RegisterPage existing roles", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID = "client-id.apps.googleusercontent.com";
    installGoogleIdentity();
    vi.stubGlobal("fetch", mockFetch);
  });

  it("giữ luồng Donor: query role, Google login và điều hướng trang chủ", async () => {
    window.history.pushState({}, "", "/register?role=donor");
    render(<RegisterPage />);
    await waitFor(() => expect(googleCredentialCallback).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Tiếp tục →" }));
    expect(await screen.findByText("Tạo tài khoản Donor 💛")).toBeInTheDocument();
    fireEvent.click(screen.getByText(/Tôi đồng ý với/));
    mockFetch.mockResolvedValueOnce(createGoogleLoginResponse("donor"));

    act(() => googleCredentialCallback?.({ credential: "donor-google-token" }));

    await waitFor(() => expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/auth/google-login"),
      expect.objectContaining({ body: JSON.stringify({ idToken: "donor-google-token", role: "donor" }) }),
    ));
    expect(mockRouterPush).toHaveBeenCalledWith("/");
  });

  it("giữ ba bước KYC cho Organization khi backend trả role donor", async () => {
    window.history.pushState({}, "", "/register?role=organization");
    render(<RegisterPage />);
    await waitFor(() => expect(googleCredentialCallback).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Tiếp tục →" }));
    expect(await screen.findByText("Tạo tài khoản Organization 🏢")).toBeInTheDocument();
    fireEvent.click(screen.getByText(/Tôi đồng ý với/));
    mockFetch.mockResolvedValueOnce(createGoogleLoginResponse("donor"));

    act(() => googleCredentialCallback?.({ credential: "organization-google-token" }));

    expect(await screen.findByText("Hoàn tất KYC")).toBeInTheDocument();
    expect(
      screen.getByText((_, element) => element?.textContent === "Xác minhKYC"),
    ).toBeInTheDocument();
  });

  it("giữ cảnh báo tài khoản Organization đã tồn tại", async () => {
    window.history.pushState({}, "", "/register?role=organization");
    render(<RegisterPage />);
    await waitFor(() => expect(googleCredentialCallback).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Tiếp tục →" }));
    fireEvent.click(screen.getByText(/Tôi đồng ý với/));
    mockFetch.mockResolvedValueOnce(createGoogleLoginResponse("organization"));

    act(() => googleCredentialCallback?.({ credential: "existing-organization-token" }));

    expect(await screen.findByText(/Bạn đã có tài khoản tổ chức từ thiện rồi/)).toBeInTheDocument();
  });
});
