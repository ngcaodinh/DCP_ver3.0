import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(),
  useSearchParams: vi.fn(),
}));

vi.mock('@/app/utils/authSession', () => ({
  persistAuthSession: vi.fn(),
  readAuthSession: vi.fn(() => ({
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    csrfToken: 'csrf-token',
    refreshSessionId: 'session-id',
    refreshTokenExpiresAt: '2030-01-01T00:00:00.000Z',
    userFullName: 'Người dùng thử',
    userEmail: 'test@example.com',
    userWalletAddress: '0x123',
    userId: 'user-001',
    userRole: 'donor',
  })),
}));

vi.mock('@/app/utils/useAuthCheck', () => ({
  useAuthCheck: vi.fn(),
}));

import { useRouter, useSearchParams } from 'next/navigation';
import { persistAuthSession } from '@/app/utils/authSession';
import { useAuthCheck } from '@/app/utils/useAuthCheck';
import DepositPage from '@/app/deposit/page';

const mockGoogleAccounts = {
  initialize: vi.fn(),
  prompt: vi.fn(),
  renderButton: vi.fn(),
};

const mockSyncSessionFromStorage = vi.fn();

describe('Deposit login modal redirect behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGoogleAccounts.initialize.mockReset();
    mockGoogleAccounts.prompt.mockReset();
    mockGoogleAccounts.renderButton.mockReset();

    vi.mocked(useRouter).mockReturnValue({ push: vi.fn() } as never);
    vi.mocked(useSearchParams).mockReturnValue(new URLSearchParams('source=campaign') as never);
    vi.mocked(useAuthCheck).mockReturnValue({
      isLoggedIn: false,
      sessionData: {
        accessToken: '',
        refreshToken: '',
        csrfToken: '',
        refreshSessionId: '',
        refreshTokenExpiresAt: '',
        userFullName: '',
        userEmail: '',
        userWalletAddress: '',
        userId: '',
        userRole: '',
      },
      syncSessionFromStorage: mockSyncSessionFromStorage,
    } as never);

    window.google = {
      accounts: {
        id: mockGoogleAccounts,
      },
    };

    vi.stubEnv('NEXT_PUBLIC_GOOGLE_CLIENT_ID', 'test-client.apps.googleusercontent.com');
    vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', 'http://localhost:4000');
    global.fetch = vi.fn().mockResolvedValue({
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
      }),
    } as Response);
  });

  it('giữ người dùng ở lại trang deposit sau khi đăng nhập thành công trong modal', async () => {
    const routerPush = vi.fn();
    vi.mocked(useRouter).mockReturnValue({ push: routerPush } as never);

    const { rerender } = render(<DepositPage />);

    const initializeOptions = mockGoogleAccounts.initialize.mock.calls.at(-1)?.[0] as
      | { callback?: (response: { credential?: string }) => void }
      | undefined;

    initializeOptions?.callback?.({ credential: 'google-id-token' });

    await waitFor(() => {
      expect(persistAuthSession).toHaveBeenCalledWith(
        expect.objectContaining({
          accessToken: 'access-token',
          userRole: 'donor',
        }),
      );
    });

    vi.mocked(useAuthCheck).mockReturnValue({
      isLoggedIn: true,
      sessionData: {
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        csrfToken: 'csrf-token',
        refreshSessionId: 'session-id',
        refreshTokenExpiresAt: '2030-01-01T00:00:00.000Z',
        userFullName: 'Người dùng thử',
        userEmail: 'test@example.com',
        userWalletAddress: '0x123',
        userId: 'user-001',
        userRole: 'donor',
      },
      syncSessionFromStorage: mockSyncSessionFromStorage,
    } as never);

    rerender(<DepositPage />);

    await waitFor(() => {
      expect(routerPush).not.toHaveBeenCalledWith('/');
      expect(routerPush).not.toHaveBeenCalledWith('/login?returnTo=%2Fdeposit%3Fsource%3Dcampaign');
    });
  });

  it('đi tới login kèm returnTo khi người dùng đóng modal mà chưa đăng nhập', async () => {
    const routerPush = vi.fn();
    vi.mocked(useRouter).mockReturnValue({ push: routerPush } as never);

    const { container } = render(<DepositPage />);

    const overlayElement = container.querySelector('[role="dialog"]');
    expect(overlayElement).not.toBeNull();

    overlayElement?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    await waitFor(() => {
      expect(routerPush).toHaveBeenCalledWith('/login?returnTo=%2Fdeposit%3Fsource%3Dcampaign');
    });
  });
});
