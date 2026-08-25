import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  executeStake: vi.fn(),
  getStatus: vi.fn(),
  persistSession: vi.fn(),
  registerIntent: vi.fn(),
  requestUnstake: vi.fn(),
  withdrawStake: vi.fn()
}));

vi.mock('@/app/utils/auditorOnboarding', () => ({
  executeAuditorStake: mocks.executeStake,
  getAuditorOnboardingStatus: mocks.getStatus,
  registerAuditorIntent: mocks.registerIntent,
  requestAuditorUnstake: mocks.requestUnstake,
  withdrawAuditorStake: mocks.withdrawStake
}));
vi.mock('@/app/utils/authSession', () => ({
  persistAuthSession: mocks.persistSession,
  readAuthSession: () => ({ accessToken: '' })
}));

import AuditorOnboardingClient from '@/app/components/auditor/AuditorOnboardingClient';

let googleCredentialCallback: ((response: { credential?: string }) => void) | undefined;

/** Khởi tạo Google Identity giả để test luồng nhận credential mà không gọi dịch vụ Google thật. */
function installGoogleIdentity(): void {
  googleCredentialCallback = undefined;
  (window as unknown as { google?: { accounts?: { id?: unknown } } }).google = {
    accounts: {
      id: {
        initialize: ({ callback }: { callback: (response: { credential?: string }) => void }) => {
          googleCredentialCallback = callback;
        },
        renderButton: vi.fn()
      }
    }
  };
}

/** Render component rồi kích hoạt thủ công sự kiện tải GSI như trình duyệt sau khi script hoàn tất. */
function renderOnboarding(): void {
  render(<AuditorOnboardingClient />);
  const script = document.querySelector<HTMLScriptElement>('script[src="https://accounts.google.com/gsi/client"]');
  expect(script).not.toBeNull();
  act(() => script?.onload?.(new Event('load')));
  act(() => googleCredentialCallback?.({ credential: 'google-identity-token' }));
}

/** Hoàn tất form đăng ký tối thiểu để các thao tác stake có session Auditor hợp lệ. */
async function createIntent(): Promise<void> {
  fireEvent.change(screen.getByLabelText('Ngân hàng'), { target: { value: 'Vietcombank' } });
  fireEvent.change(screen.getByLabelText('Số tài khoản'), { target: { value: '0123456789' } });
  fireEvent.change(screen.getByLabelText('Chủ tài khoản'), { target: { value: 'NGUYEN VAN A' } });
  fireEvent.click(screen.getByRole('button', { name: 'Tạo hồ sơ Auditor' }));
  await waitFor(() => expect(mocks.registerIntent).toHaveBeenCalled());
}

describe('AuditorOnboardingClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID = 'client-id.apps.googleusercontent.com';
    installGoogleIdentity();
    mocks.registerIntent.mockResolvedValue({
      intentId: '552a4fd2-1471-4a08-98d0-20575f3950c5',
      minimumStakeThreshold: '3000000',
      accessToken: 'auditor-token',
      refreshToken: 'refresh-token',
      csrfToken: 'csrf-token',
      refreshSessionId: 'session-id',
      expiresAt: '2026-08-24T00:00:00.000Z'
    });
  });

  it('creates an Auditor intent only after Google credential and payout account are available', async () => {
    renderOnboarding();

    await createIntent();

    expect(mocks.registerIntent).toHaveBeenCalledWith({
      identityToken: 'google-identity-token',
      payoutAccount: {
        bankName: 'Vietcombank',
        bankAccountNumber: '0123456789',
        accountHolderName: 'NGUYEN VAN A',
        branchName: undefined
      }
    });
    expect(mocks.persistSession).toHaveBeenCalledWith(expect.objectContaining({ accessToken: 'auditor-token' }));
  });

  it('submits stake with the newly issued Auditor session and lets the user refresh status', async () => {
    mocks.executeStake.mockResolvedValue({ status: 'VERIFYING', txHash: '0xstake' });
    mocks.getStatus.mockResolvedValue({ status: 'ACTIVATED', failureReason: null });
    renderOnboarding();
    await createIntent();

    fireEvent.click(screen.getByRole('button', { name: 'Đặt cọc DCT' }));
    await waitFor(() => expect(mocks.executeStake).toHaveBeenCalledWith('auditor-token'));
    fireEvent.click(screen.getByRole('button', { name: 'Cập nhật trạng thái' }));
    await waitFor(() => expect(mocks.getStatus).toHaveBeenCalledWith('auditor-token', '552a4fd2-1471-4a08-98d0-20575f3950c5'));
  });

  it('warns when a new unbond request replaces the prior withdrawal release time', async () => {
    mocks.requestUnstake.mockResolvedValue({
      txHash: '0xunstake',
      releaseAt: '2026-08-25T00:00:00.000Z',
      previousReleaseAt: '2026-08-24T00:00:00.000Z'
    });
    renderOnboarding();
    await createIntent();

    fireEvent.change(screen.getByLabelText('Số DCT muốn unbond'), { target: { value: '100000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Yêu cầu unbond' }));

    await waitFor(() => expect(mocks.requestUnstake).toHaveBeenCalledWith('auditor-token', '100000'));
    expect(await screen.findByRole('status')).toHaveTextContent('Mốc rút cũ');
  });
});
