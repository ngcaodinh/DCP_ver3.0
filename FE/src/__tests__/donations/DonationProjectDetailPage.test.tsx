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
  buildIpfsGatewayUrl: vi.fn((cid: string) => `https://gateway.pinata.cloud/ipfs/${cid}`),
  getIpfsContentType: vi.fn().mockResolvedValue('image/png'),
  resolveIpfsPreviewKind: vi.fn(() => 'image'),
}));

vi.mock('@/app/components/common/IpfsEvidencePreviewCard', () => ({
  default: ({ fileName }: { fileName: string }) => <div>{fileName}</div>,
}));

vi.mock('@/app/components/oracle/GeofenceMapLazy', () => ({
  GeofenceMapLazy: ({ snapshot }: { snapshot: { polygon: unknown[] } }) => (
    <div data-testid="project-geofence-map">{snapshot.polygon.length} điểm ranh giới</div>
  ),
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
import { initPayosDonation } from '@/app/utils/guestPayosClient';
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
function makeProjectFetchResponses(location: unknown = {
  polygon: [
    { lat: 21.028511, lng: 105.804817 },
    { lat: 21.029511, lng: 105.804817 },
    { lat: 21.028511, lng: 105.805817 },
  ],
  centroid: { lat: 21.028844, lng: 105.805150 },
  radiusMeters: 500,
}) {
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
        location,
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

  it('renders the feedback entry point for the current project', async () => {
    const { container } = render(<DonationProjectDetailPage />);

    await waitFor(() => {
      expect(container.querySelector('a[href="/feedback/project-001"]')).toBeInTheDocument();
    });
  });

  it('hiển thị tên vùng, Google Maps và bản đồ ranh giới từ dữ liệu public', async () => {
    render(<DonationProjectDetailPage />);

    const location = await screen.findByTestId('project-geographic-location');
    expect(location).toHaveTextContent('Vùng địa lý dự án: Quỹ hỗ trợ khẩn cấp');
    expect(location).not.toHaveTextContent('Bản đồ chỉ xem để đối chiếu ranh giới trước khi duyệt.');
    expect(location).toHaveTextContent('21.028844, 105.805150 · bán kính 500 m');
    expect(screen.getByRole('link', { name: /mở trên google maps/i })).toHaveAttribute(
      'href',
      'https://www.google.com/maps/search/?api=1&query=21.028844%2C105.805150',
    );
    expect(screen.getByTestId('project-geofence-map')).toHaveTextContent('3 điểm ranh giới');
  });

  it('hiển thị trạng thái chưa có vị trí khi dự án cũ chưa có dữ liệu geofence', async () => {
    const responses = makeProjectFetchResponses(null);
    vi.mocked(fetchApi)
      .mockReset()
      .mockResolvedValueOnce(responses[0] as never)
      .mockResolvedValueOnce(responses[1] as never)
      .mockResolvedValueOnce(responses[2] as never);

    render(<DonationProjectDetailPage />);

    await screen.findByText('Quỹ hỗ trợ khẩn cấp');
    expect(screen.getByTestId('project-geographic-location')).toHaveTextContent('Chưa thiết lập thông tin vị trí.');
    expect(screen.queryByRole('link', { name: /mở trên google maps/i })).not.toBeInTheDocument();
    expect(screen.queryByTestId('project-geofence-map')).not.toBeInTheDocument();
  });

  it('tương thích payload public-support cũ không có trường location', async () => {
    const responses = makeProjectFetchResponses();
    delete (responses[0].data as { location?: unknown }).location;
    vi.mocked(fetchApi)
      .mockReset()
      .mockResolvedValueOnce(responses[0] as never)
      .mockResolvedValueOnce(responses[1] as never)
      .mockResolvedValueOnce(responses[2] as never);

    render(<DonationProjectDetailPage />);

    await screen.findByText('Quỹ hỗ trợ khẩn cấp');
    expect(screen.getByTestId('project-geographic-location')).toHaveTextContent('Chưa thiết lập thông tin vị trí.');
    expect(screen.queryByRole('link', { name: /mở trên google maps/i })).not.toBeInTheDocument();
  });

  it('chặn Google Maps và Leaflet khi snapshot geofence không hợp lệ', async () => {
    const responses = makeProjectFetchResponses({
      polygon: [{ lat: 21.028511, lng: 105.804817 }],
      centroid: { lat: 95, lng: 105.804817 },
      radiusMeters: 0,
    });
    vi.mocked(fetchApi)
      .mockReset()
      .mockResolvedValueOnce(responses[0] as never)
      .mockResolvedValueOnce(responses[1] as never)
      .mockResolvedValueOnce(responses[2] as never);

    render(<DonationProjectDetailPage />);

    await screen.findByText('Quỹ hỗ trợ khẩn cấp');
    expect(screen.getByTestId('project-geographic-location')).toHaveTextContent('Thông tin vị trí không hợp lệ.');
    expect(screen.queryByRole('link', { name: /mở trên google maps/i })).not.toBeInTheDocument();
    expect(screen.queryByTestId('project-geofence-map')).not.toBeInTheDocument();
  });

  it('khởi tạo PayOS cho quyên góp ẩn danh ở mức tối đa', async () => {
    vi.mocked(initPayosDonation).mockResolvedValue({
      orderCode: 'ORDER-001',
      paymentUrl: 'https://pay.payos.vn/order-001',
      amount: 200000,
      projectId: 'project-001',
    } as never);

    render(<DonationProjectDetailPage />);

    await screen.findByText('Quỹ hỗ trợ khẩn cấp');

    fireEvent.click(screen.getByRole('button', { name: /quyên góp ẩn danh/i }));

    await screen.findByText(/ví ẩn danh đã sẵn sàng/i);

    const amountInput = screen.getByPlaceholderText(/từ 10000 đến 200,?000 token/i);
    fireEvent.change(amountInput, { target: { value: '200000' } });

    fireEvent.click(screen.getByRole('button', { name: /quyên góp ẩn danh/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^xác nhận$/i }));

    await waitFor(() => {
      expect(initPayosDonation).toHaveBeenCalledWith(
        {
          projectId: 'project-001',
          amount: 200000,
        },
        'guest-token-001',
      );
    });
  });
});
