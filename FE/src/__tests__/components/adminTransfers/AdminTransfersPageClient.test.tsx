import { describe, expect, it, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import AdminTransfersPageClient from '@/app/admin/transfers/AdminTransfersPageClient';
import { readAuthSession } from '@/app/utils/authSession';

const routerReplaceMock = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: routerReplaceMock })
}));

vi.mock('@/app/utils/authSession', () => ({
  readAuthSession: vi.fn()
}));

vi.mock('@/app/components/adminTransfers/TransferStatusPanel', () => ({
  default: ({ onPushToast }: { onPushToast: (toast: { titleText: string; bodyText: string; tone: string }) => void }) => (
    <button
      type="button"
      onClick={() => onPushToast({ titleText: 'Test toast', bodyText: 'Body', tone: 'success' })}
    >
      Mock Transfer Panel
    </button>
  )
}));

vi.mock('@/app/components/systemAdmin/tailwind/ToastStack', () => ({
  default: ({ toastItemList }: { toastItemList: Array<{ titleText: string; bodyText: string }> }) => (
    <div>{toastItemList.map((toast) => <p key={toast.titleText}>{toast.titleText}: {toast.bodyText}</p>)}</div>
  )
}));

describe('AdminTransfersPageClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('redirect login và không mount dashboard khi thiếu session', async () => {
    vi.mocked(readAuthSession).mockReturnValue({ accessToken: '' });
    render(<AdminTransfersPageClient />);

    await waitFor(() => expect(routerReplaceMock).toHaveBeenCalledWith('/login'));
    expect(screen.queryByRole('button', { name: 'Mock Transfer Panel' })).not.toBeInTheDocument();
  });

  it('redirect unauthorized trước khi mount dashboard cho role khác admin', async () => {
    vi.mocked(readAuthSession).mockReturnValue({ accessToken: 'token-001', userRole: 'donor' });
    render(<AdminTransfersPageClient />);

    await waitFor(() => expect(routerReplaceMock).toHaveBeenCalledWith('/unauthorized'));
    expect(screen.queryByRole('button', { name: 'Mock Transfer Panel' })).not.toBeInTheDocument();
  });

  it('mount dashboard cho admin và chuyển toast qua ToastStack', async () => {
    vi.mocked(readAuthSession).mockReturnValue({ accessToken: 'token-001', userRole: 'admin' });
    render(<AdminTransfersPageClient />);

    const panelButton = await screen.findByRole('button', { name: 'Mock Transfer Panel' });
    fireEvent.click(panelButton);
    expect(screen.getByText('Test toast: Body')).toBeInTheDocument();
  });
});
