import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import SbtRetryPageClient from '@/app/admin/sbt/retry/SbtRetryPageClient';
import { readAuthSession } from '@/app/utils/authSession';

const pageMocks = vi.hoisted(() => ({ routerReplace: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: pageMocks.routerReplace })
}));

vi.mock('@/app/utils/authSession', () => ({
  readAuthSession: vi.fn()
}));

vi.mock('@/app/components/adminSbtRetry/DLQManagement', () => ({
  default: ({ onPushToast }: { onPushToast: (toast: { titleText: string; bodyText: string; tone: 'success' | 'error' | 'warning' | 'info' }) => void }) => (
    <button type="button" onClick={() => onPushToast({ titleText: 'Test toast', bodyText: 'Body', tone: 'success' })}>
      Mock DLQ Management
    </button>
  )
}));

vi.mock('@/app/components/systemAdmin/tailwind/ToastStack', () => ({
  default: ({ toastItemList }: { toastItemList: Array<{ titleText: string; bodyText: string }> }) => (
    <div>{toastItemList.map((toast) => <p key={toast.titleText}>{toast.titleText}: {toast.bodyText}</p>)}</div>
  )
}));

describe('SbtRetryPageClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('thiếu token redirect login và không mount DLQ', async () => {
    vi.mocked(readAuthSession).mockReturnValue({ accessToken: '' });
    render(<SbtRetryPageClient />);

    await waitFor(() => expect(pageMocks.routerReplace).toHaveBeenCalledWith('/login'));
    expect(screen.queryByRole('button', { name: 'Mock DLQ Management' })).not.toBeInTheDocument();
  });

  it('role không phải admin redirect unauthorized', async () => {
    vi.mocked(readAuthSession).mockReturnValue({ accessToken: 'token-001', userRole: 'donor' });
    render(<SbtRetryPageClient />);

    await waitFor(() => expect(pageMocks.routerReplace).toHaveBeenCalledWith('/unauthorized'));
    expect(screen.queryByRole('button', { name: 'Mock DLQ Management' })).not.toBeInTheDocument();
  });

  it('admin mount DLQ và truyền toast qua ToastStack', async () => {
    vi.mocked(readAuthSession).mockReturnValue({ accessToken: 'token-001', userRole: 'admin' });
    render(<SbtRetryPageClient />);

    fireEvent.click(await screen.findByRole('button', { name: 'Mock DLQ Management' }));
    expect(screen.getByText('Test toast: Body')).toBeInTheDocument();
  });

  it('auto-removes toast after four seconds', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(readAuthSession).mockReturnValue({ accessToken: 'token-001', userRole: 'admin' });
      render(<SbtRetryPageClient />);

      fireEvent.click(screen.getByRole('button', { name: 'Mock DLQ Management' }));
      expect(screen.getByText('Test toast: Body')).toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(4_000);
      });
      expect(screen.queryByText('Test toast: Body')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('source route không chứa tombstone admin-mint', () => {
    const sourcePaths = [
      'app/admin/sbt/retry/page.tsx',
      'app/admin/sbt/retry/SbtRetryPageClient.tsx',
      'app/components/adminSbtRetry/DLQManagement.tsx',
      'app/components/adminSbtRetry/DlqDetailModal.tsx',
      'app/hooks/useSbtDlqList.ts',
      'app/constants/sbtDlq.ts',
      'app/types/sbtRetry.ts'
    ];
    const source = sourcePaths.map((sourcePath) => readFileSync(path.resolve(process.cwd(), sourcePath), 'utf8')).join('\n');
    expect(source).not.toContain('admin-mint');
  });
});
