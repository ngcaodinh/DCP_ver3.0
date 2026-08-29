import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchApi: vi.fn(),
  parseJsonSafely: vi.fn(),
  persistAuthSession: vi.fn(),
  clearAuthSession: vi.fn(),
  replace: vi.fn()
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: mocks.replace }) }));
vi.mock('@/app/utils/apiClient', () => ({
  buildApiUrl: (path: string) => path,
  fetchApi: mocks.fetchApi,
  parseJsonSafely: mocks.parseJsonSafely,
  getApiErrorMessage: (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback
}));
vi.mock('@/app/utils/authSession', () => ({
  persistAuthSession: mocks.persistAuthSession,
  clearAuthSession: mocks.clearAuthSession
}));

import GovernanceLoginPage from '@/app/governance/login/page';

const walletAddress = '0x1111111111111111111111111111111111111111';

/** Gắn provider EIP-1193 giả lập vào window để kiểm tra flow MetaMask không cần ví thật. */
function setProvider(provider: { request: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn>; removeListener: ReturnType<typeof vi.fn> }): void {
  Object.defineProperty(window, 'ethereum', { configurable: true, writable: true, value: provider });
}

/** Tạo provider có spy cho các method chain/account/signature mà trang gọi. */
function createProvider(): { request: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn>; removeListener: ReturnType<typeof vi.fn> } {
  return { request: vi.fn(), on: vi.fn(), removeListener: vi.fn() };
}

/** Tạo response fetch login tối thiểu để kiểm tra parse payload và route role. */
function createLoginResponse(role = 'executive_member') {
  return {
    accessToken: 'access-token', refreshToken: 'refresh-token', csrfToken: 'csrf-token', refreshSessionId: 'session-1',
    expiresAt: '2026-09-01T00:00:00.000Z',
    user: { id: 'member-1', fullName: 'Member', email: 'member@dcp.local', walletAddress, role }
  };
}

describe('GovernanceLoginPage MetaMask flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    delete (window as Window & { ethereum?: unknown }).ethereum;
    mocks.fetchApi.mockResolvedValue({ data: { nonce: 'nonce-1', message: 'DCP sign-in message' } });
    mocks.parseJsonSafely.mockResolvedValue(createLoginResponse());
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete (window as Window & { ethereum?: unknown }).ethereum;
  });

  it('hiển thị lỗi rõ ràng khi chưa cài MetaMask', async () => {
    render(<GovernanceLoginPage />);

    fireEvent.click(screen.getByRole('button', { name: /Kết nối ví MetaMask/ }));

    expect(await screen.findByRole('status')).toHaveTextContent('Chưa cài MetaMask');
    expect(mocks.fetchApi).not.toHaveBeenCalled();
  });

  it('chặn login khi sai network và switch chain bị từ chối', async () => {
    const provider = createProvider();
    provider.request.mockImplementation(({ method }: { method: string }) => {
      if (method === 'eth_chainId') return Promise.resolve('0x1');
      if (method === 'wallet_switchEthereumChain') return Promise.reject(new Error('user rejected'));
      return Promise.resolve([]);
    });
    setProvider(provider);
    render(<GovernanceLoginPage />);

    fireEvent.click(screen.getByRole('button', { name: /Kết nối ví MetaMask/ }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('mạng Polygon Amoy'));
    expect(provider.request).toHaveBeenCalledWith({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x13882' }] });
    expect(mocks.fetchApi).not.toHaveBeenCalled();
  });

  it('hủy popup personal_sign thì không gọi wallet login endpoint', async () => {
    const provider = createProvider();
    provider.request.mockImplementation(({ method }: { method: string }) => {
      if (method === 'eth_chainId') return Promise.resolve('0x13882');
      if (method === 'eth_requestAccounts') return Promise.resolve([walletAddress]);
      if (method === 'personal_sign') return Promise.reject({ code: 4001 });
      return Promise.resolve(null);
    });
    setProvider(provider);
    render(<GovernanceLoginPage />);

    fireEvent.click(screen.getByRole('button', { name: /Kết nối ví MetaMask/ }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Bạn đã huỷ ký'));
    expect(fetch).not.toHaveBeenCalled();
  });

  it('hiển thị lỗi nonce hết hạn từ backend và không lưu session', async () => {
    const provider = createProvider();
    provider.request.mockImplementation(({ method }: { method: string }) => {
      if (method === 'eth_chainId') return Promise.resolve('0x13882');
      if (method === 'eth_requestAccounts') return Promise.resolve([walletAddress]);
      if (method === 'personal_sign') return Promise.resolve('0xsig');
      return Promise.resolve(null);
    });
    const failedResponse = { ok: false };
    mocks.parseJsonSafely.mockResolvedValue({ message: 'Nonce đăng nhập không hợp lệ hoặc đã hết hạn.' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(failedResponse));
    setProvider(provider);
    render(<GovernanceLoginPage />);

    fireEvent.click(screen.getByRole('button', { name: /Kết nối ví MetaMask/ }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Nonce đăng nhập không hợp lệ hoặc đã hết hạn.'));
    expect(mocks.persistAuthSession).not.toHaveBeenCalled();
  });

  it('lưu session và điều hướng theo role governance sau login thành công', async () => {
    const provider = createProvider();
    provider.request.mockImplementation(({ method }: { method: string }) => {
      if (method === 'eth_chainId') return Promise.resolve('0x13882');
      if (method === 'eth_requestAccounts') return Promise.resolve([walletAddress]);
      if (method === 'personal_sign') return Promise.resolve('0xsig');
      return Promise.resolve(null);
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    mocks.parseJsonSafely.mockResolvedValue(createLoginResponse('executive_member'));
    setProvider(provider);
    render(<GovernanceLoginPage />);

    fireEvent.click(screen.getByRole('button', { name: /Kết nối ví MetaMask/ }));

    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith('/executive/member'));
    expect(mocks.persistAuthSession).toHaveBeenCalledWith(expect.objectContaining({
      accessToken: 'access-token', userRole: 'executive_member', userWalletAddress: walletAddress
    }));
  });
});
