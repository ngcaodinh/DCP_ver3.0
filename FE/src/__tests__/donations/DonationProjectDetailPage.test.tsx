import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

vi.mock('next/navigation', () => ({
  useParams: vi.fn(),
  usePathname: vi.fn(),
  useRouter: vi.fn(),
  useSearchParams: vi.fn(),
}));

vi.mock('@/app/utils/apiClient', () => ({
  fetchApi: vi.fn(),
  buildApiUrl: vi.fn((path: string) => `http://localhost:3000${path}`),
}));

vi.mock('@/app/utils/authSession', () => ({
  readAuthSession: vi.fn(),
}));

vi.mock('@/app/components/GuestWalletProvider', () => ({
  useGuestWallet: vi.fn(),
}));

vi.mock('@/app/utils/ipfs', () => ({
  buildIpfsGatewayUrl: vi.fn((cid: string) => `https://ipfs.io/ipfs/${cid}`),
  getIpfsContentType: vi.fn().mockResolvedValue('image/png'),
  resolveIpfsPreviewKind: vi.fn(() => 'image'),
}));

vi.mock('@/app/components/common/IpfsEvidencePreviewCard', () => ({
  default: ({ fileName }: { fileName: string }) => <div>{fileName}</div>,
}));

vi.mock('@/app/donations/components/DonationModal.services', () => ({
  executeOneClickDonationRequest: vi.fn(),
}));

vi.mock('@/app/donations/components/DonationModal.helpers', () => ({
  formatWalletAddress: vi.fn((address: string) => `${address.slice(0, 6)}...${address.slice(-4)}`),
  mapDonationErrorMessage: vi.fn((error: unknown) => (error instanceof Error ? error.message : 'Đã xảy ra lỗi.')),
  isCampaignBeforeDeadline: vi.fn(() => true),
}));

vi.mock('@/app/utils/guestPayosClient', () => ({
  initPayosDonation: vi.fn(),
  getPayosDonationStatus: vi.fn(),
}));

import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation';
import { fetchApi } from '@/app/utils/apiClient';
import { readAuthSession } from '@/app/utils/authSession';
import { useGuestWallet } from '@/app/components/GuestWalletProvider';
import { initPayosDonation, getPayosDonationStatus } from '@/app/utils/guestPayosClient';
import DonationProjectDetailPage from '@/app/donations/[projectId]/page';

/**
 * Hàm tạo dữ liệu ví guest giả lập cho test anonymous donation.
 * @returns Trạng thái ví guest tương thích với component useGuestWallet
 */
function makeGuestWalletState() {
  return {
    initState: {
      initStatus: 'READY' as const,
      initError: null,
      walletAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0E8eD',
      sessionId: 'guest-session-001',
      guestSessionToken: 'guest-token-001',
      donationQuota: 3,
      donationCount: 0,
      remainingDonations: 3,
      canDonate: true,
      hasPendingDonation: false,
      expiresAt: '2030-01-01T00:00:00.000Z',
      browserCompat: { riskLevel: 'SAFE' as const, details: [] as string[] },
      claimPromptDismissed: false,
    },
    bootstrapGuestWallet: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * Hàm tạo dữ liệu fetch dự án cho trang chi tiết.
 * @returns Danh sách response tuần tự cho 3 request loadProjectData
 */
function makeProjectFetchResponses() {
  return [
    {
      data: {
        projectId: 'project-001',
        name: 'Quỹ hỗ trợ khẩn cấp',
        description: 'Mô tả dự án',
        goalAmount: 200000,
        status: 'ACTIVE',
        deadline: '2030-01-01T00:00:00.000Z',
        evidenceCids: [],
        evidenceFiles: [],
        creatorName: 'DCP Team',
        lastDonationAt: null,
        coverImageUrl: '',
      },
    },
    {
      data: {
        projectId: 'project-001',
        donatedAmount: 50000,
        donationCount: 2,
      },
    },
    {
      data: [],
    },
  ];
}

describe('DonationProjectDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(useParams).mockReturnValue({ projectId: 'project-001' });
    vi.mocked(usePathname).mockReturnValue('/donations/project-001');
    vi.mocked(useSearchParams).mockReturnValue(new URLSearchParams('ref=homepage') as never);
    vi.mocked(useRouter).mockReturnValue({ push: vi.fn() } as never);
    vi.mocked(readAuthSession).mockReturnValue({ accessToken: undefined });
    vi.mocked(useGuestWallet).mockReturnValue(makeGuestWalletState() as never);

    vi.mocked(fetchApi)
      .mockResolvedValueOnce(makeProjectFetchResponses()[0] as never)
      .mockResolvedValueOnce(makeProjectFetchResponses()[1] as never)
      .mockResolvedValueOnce(makeProjectFetchResponses()[2] as never)
      .mockResolvedValueOnce(makeProjectFetchResponses()[0] as never)
      .mockResolvedValueOnce(makeProjectFetchResponses()[1] as never)
      .mockResolvedValueOnce(makeProjectFetchResponses()[2] as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('điều hướng tới login kèm returnTo khi mở quyên góp công khai mà chưa đăng nhập', async () => {
    const routerPush = vi.fn();
    vi.mocked(useRouter).mockReturnValue({ push: routerPush } as never);

    render(<DonationProjectDetailPage />);

    await screen.findByText('Quỹ hỗ trợ khẩn cấp');

    fireEvent.click(screen.getByRole('button', { name: /quyên góp công khai/i }));

    expect(routerPush).toHaveBeenCalledWith('/login?returnTo=%2Fdonations%2Fproject-001%3Fref%3Dhomepage');
  });

  it('cho phép quyên góp ẩn danh sau khi PayOS thanh toán thành công', async () => {
    vi.mocked(initPayosDonation).mockResolvedValue({
      orderCode: 'ORDER-001',
      paymentUrl: 'https://pay.payos.vn/order-001',
      amount: 10000,
      projectId: 'project-001',
    } as never);

    vi.mocked(getPayosDonationStatus).mockResolvedValue({
      orderCode: 'ORDER-001',
      status: 'COMPLETED',
      amount: 10000,
      projectId: 'project-001',
      relayTxHash: '0xrelayhash',
      mintTxHash: '0xminthash',
      errorMessage: null,
      createdAt: '2026-06-05T08:00:00.000Z',
      updatedAt: '2026-06-05T08:00:05.000Z',
    } as never);

    render(<DonationProjectDetailPage />);

    await screen.findByText('Quỹ hỗ trợ khẩn cấp');

    fireEvent.click(screen.getByRole('button', { name: /quyên góp ẩn danh/i }));

    await screen.findByText(/ví ẩn danh đã sẵn sàng/i);

    const amountInput = screen.getByPlaceholderText(/từ 10000 đến 20,?000 token/i);
    fireEvent.change(amountInput, { target: { value: '10000' } });

    fireEvent.click(screen.getByRole('button', { name: /quyên góp ẩn danh/i }));

    await waitFor(() => {
      expect(initPayosDonation).toHaveBeenCalledWith(
        {
          projectId: 'project-001',
          amount: 10000,
        },
        'guest-token-001',
      );
    });

    await screen.findByText(/vui lòng hoàn tất thanh toán trên payos/i);
    expect(screen.getByRole('link', { name: /mở trang thanh toán payos/i })).toHaveAttribute(
      'href',
      'https://pay.payos.vn/order-001',
    );

    await waitFor(() => {
      expect(getPayosDonationStatus).toHaveBeenCalledWith('ORDER-001', 'guest-token-001');
    }, { timeout: 5000 });

    await waitFor(() => {
      expect(screen.getByText(/quyên góp ẩn danh thành công/i)).toBeInTheDocument();
    }, { timeout: 5000 });

    await waitFor(() => {
      expect(fetchApi).toHaveBeenCalledTimes(6);
    }, { timeout: 5000 });
  }, 15000);
});
