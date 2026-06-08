import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(),
  useSearchParams: vi.fn(),
}));

vi.mock('@/app/utils/authSession', () => ({
  persistAuthSession: vi.fn(),
}));

import { useRouter, useSearchParams } from 'next/navigation';
import { persistAuthSession } from '@/app/utils/authSession';
import LoginPage from '@/app/login/page';

const mockGoogleAccounts = {
  initialize: vi.fn(),
  prompt: vi.fn(),
  renderButton: vi.fn(),
};

describe('LoginPage redirect behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGoogleAccounts.initialize.mockReset();
    mockGoogleAccounts.prompt.mockReset();
    mockGoogleAccounts.renderButton.mockReset();

    vi.mocked(useRouter).mockReturnValue({ push: vi.fn() } as never);
    vi.mocked(useSearchParams).mockReturnValue(new URLSearchParams() as never);

    window.google = {
      accounts: {
        id: mockGoogleAccounts,
      },
    };

    vi.stubEnv('NEXT_PUBLIC_GOOGLE_CLIENT_ID', 'test-client.apps.googleusercontent.com');
    vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', 'http://localhost:4000');
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  /**
   * Hàm giả lập phản hồi thành công từ Google Identity Services.
   * @param returnToValue - Giá trị returnTo cần gắn vào URL login
   * @returns Hàm push để kiểm tra đích điều hướng cuối cùng
   */
  async function renderPageAndCompleteLogin(returnToValue: string | null) {
    const routerPush = vi.fn();
    vi.mocked(useRouter).mockReturnValue({ push: routerPush } as never);
    vi.mocked(useSearchParams).mockReturnValue(new URLSearchParams(returnToValue ? `returnTo=${encodeURIComponent(returnToValue)}` : '') as never);

    vi.mocked(global.fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        csrfToken: 'csrf-token',
        refreshSessionId: 'session-id',
        expiresAt: '2030-01-01T00:00:00.000Z',
        user: {
          id: 'user-001',
          fullName: 'Người dùng thử',
          email: 'test@example.com',
          walletAddress: '0x123',
          role: 'donor',
        },
        correlationId: 'correlation-id',
      }),
    } as Response);

    render(<LoginPage />);

    const initializeOptions = mockGoogleAccounts.initialize.mock.calls.at(-1)?.[0] as
      | { callback?: (response: { credential?: string }) => void }
      | undefined;

    initializeOptions?.callback?.({ credential: 'google-id-token' });

    await waitFor(() => {
      expect(routerPush).toHaveBeenCalled();
    });

    return routerPush;
  }

  it('ưu tiên returnTo hợp lệ của trang nghiệp vụ sau khi đăng nhập thành công', async () => {
    const routerPush = await renderPageAndCompleteLogin('/donations/project-001');

    await waitFor(() => {
      expect(routerPush).toHaveBeenCalledWith('/donations/project-001');
    });
  });

  it('fallback về trang chủ khi returnTo là trang register', async () => {
    const routerPush = await renderPageAndCompleteLogin('/register');

    await waitFor(() => {
      expect(routerPush).toHaveBeenCalledWith('/');
    });
  });

  it('fallback về trang chủ khi returnTo là trang login', async () => {
    const routerPush = await renderPageAndCompleteLogin('/login?source=register');

    await waitFor(() => {
      expect(routerPush).toHaveBeenCalledWith('/');
    });
  });

  it('fallback về trang chủ khi returnTo là url không an toàn', async () => {
    const routerPush = await renderPageAndCompleteLogin('https://malicious.example');

    await waitFor(() => {
      expect(routerPush).toHaveBeenCalledWith('/');
    });
  });

  it('lưu phiên đăng nhập trước khi điều hướng', async () => {
    await renderPageAndCompleteLogin('/donations/project-001');

    await waitFor(() => {
      expect(persistAuthSession).toHaveBeenCalledWith(
        expect.objectContaining({
          accessToken: 'access-token',
          userRole: 'donor',
        }),
      );
    });
  });
});
