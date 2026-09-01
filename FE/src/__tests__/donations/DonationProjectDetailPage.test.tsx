import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

vi.mock('next/navigation', () => ({
  useParams: vi.fn(),
  usePathname: vi.fn(),
  useRouter: vi.fn(),
  useSearchParams: vi.fn(),
}));

vi.mock('canvas-confetti', () => ({
  default: vi.fn(),
}));

vi.mock('@/app/utils/apiClient', () => ({
  fetchApi: vi.fn(),
  buildApiUrl: vi.fn((path: string) => `http://localhost:3000${path}`),
  getApiErrorMessage: vi.fn((error: unknown, fallbackMessage: string) => (
    typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string'
      ? error.message
      : fallbackMessage
  )),
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

vi.mock('@/app/components/impactSbt/ProjectImpactNftSection', () => ({
  default: ({ projectId }: { projectId: string }) => (
    <div data-testid="project-impact-nft-section-stub">{projectId}</div>
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
import confetti from 'canvas-confetti';
import { fetchApi } from '@/app/utils/apiClient';
import { readAuthSession } from '@/app/utils/authSession';
import { useGuestWallet } from '@/app/components/GuestWalletProvider';
import { initPayosDonation } from '@/app/utils/guestPayosClient';
import { executeOneClickDonationRequest } from '@/app/donations/components/DonationModal.services';
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
    vi.mocked(fetchApi).mockReset();

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
    const impactSection = screen.getByTestId('project-impact-nft-section-stub');
    const progressHeading = screen.getByRole('heading', { name: 'Tiến độ gây quỹ' });
    const evidenceHeading = screen.getByRole('heading', { name: 'Bằng chứng minh bạch' });

    expect(impactSection).toHaveTextContent('project-001');
    expect(progressHeading.compareDocumentPosition(impactSection)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(impactSection.compareDocumentPosition(evidenceHeading)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
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

  it('hiển thị số dư Smart Account và link nạp tiền cho quyên góp công khai', async () => {
    vi.mocked(readAuthSession).mockReturnValue({ accessToken: 'access-token-001' } as never);

    render(<DonationProjectDetailPage />);

    await screen.findByText('Quỹ hỗ trợ khẩn cấp');
    vi.mocked(fetchApi).mockReset();
    vi.mocked(fetchApi).mockResolvedValue({ tokenBalance: '125000' } as never);

    fireEvent.click(screen.getByRole('button', { name: /quyên góp công khai/i }));

    await waitFor(() => {
      expect(screen.getByText(/Số dư Smart Account:/i)).toHaveTextContent('125.000 token');
    });
    expect(screen.getByText(/Sử dụng tài khoản đã đăng nhập/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^Nạp tiền thêm$/i })).toHaveAttribute('href', '/deposit');
  });

  it('hiển thị trạng thái tải số dư và khóa nút quyên góp trong lúc chờ', async () => {
    vi.mocked(readAuthSession).mockReturnValue({ accessToken: 'access-token-001' } as never);

    render(<DonationProjectDetailPage />);

    await screen.findByText('Quỹ hỗ trợ khẩn cấp');
    vi.mocked(fetchApi).mockReset();
    vi.mocked(fetchApi).mockReturnValue(new Promise<never>(() => undefined) as never);

    fireEvent.click(screen.getByRole('button', { name: /quyên góp công khai/i }));

    await waitFor(() => {
      expect(screen.getByText(/Số dư Smart Account:/i)).toHaveTextContent('Đang tải...');
    });
    expect(screen.getByRole('button', { name: /^quyên góp$/i })).toBeDisabled();
    expect(screen.getByRole('link', { name: /^Nạp tiền thêm$/i })).toHaveAttribute('href', '/deposit');
  });

  it('hiển thị lỗi tải số dư nhưng vẫn cung cấp link nạp tiền', async () => {
    vi.mocked(readAuthSession).mockReturnValue({ accessToken: 'access-token-001' } as never);

    render(<DonationProjectDetailPage />);

    await screen.findByText('Quỹ hỗ trợ khẩn cấp');
    vi.mocked(fetchApi).mockReset();
    vi.mocked(fetchApi).mockRejectedValue(new Error('Balance service unavailable'));

    fireEvent.click(screen.getByRole('button', { name: /quyên góp công khai/i }));

    await screen.findByText(/Không thể tải số dư Smart Account/i);
    expect(screen.getByText(/Số dư Smart Account:/i)).toHaveTextContent('Chưa thể tải số dư');
    expect(screen.queryByText(/Số dư Smart Account: 0 token/i)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^Nạp tiền thêm$/i })).toHaveAttribute('href', '/deposit');
  });

  it('hiển thị message an toàn từ lỗi typed của endpoint số dư', async () => {
    vi.mocked(readAuthSession).mockReturnValue({ accessToken: 'access-token-001' } as never);

    render(<DonationProjectDetailPage />);

    await screen.findByText('Quỹ hỗ trợ khẩn cấp');
    vi.mocked(fetchApi).mockReset();
    vi.mocked(fetchApi).mockRejectedValue({
      message: 'Không thể kết nối blockchain để đọc số dư Smart Account. Vui lòng thử lại sau.',
      errorCode: 'BLOCKCHAIN_UNAVAILABLE'
    });

    fireEvent.click(screen.getByRole('button', { name: /quyên góp công khai/i }));

    await screen.findByText(/Không thể kết nối blockchain để đọc số dư Smart Account/i);
    expect(screen.getByText(/Số dư Smart Account:/i)).toHaveTextContent('Chưa thể tải số dư');
  });

  it('chặn số tiền không hợp lệ hoặc vượt số dư trước khi mở xác nhận', async () => {
    vi.mocked(readAuthSession).mockReturnValue({ accessToken: 'access-token-001' } as never);

    render(<DonationProjectDetailPage />);

    await screen.findByText('Quỹ hỗ trợ khẩn cấp');
    vi.mocked(fetchApi).mockReset();
    vi.mocked(fetchApi).mockResolvedValue({ tokenBalance: '100' } as never);
    fireEvent.click(screen.getByRole('button', { name: /quyên góp công khai/i }));
    await screen.findByText(/100 token/i);

    const amountInput = screen.getByPlaceholderText(/nhập số token muốn quyên góp/i);
    const donateButton = screen.getByRole('button', { name: /^quyên góp$/i });

    fireEvent.click(donateButton);
    expect(screen.getByText(/số nguyên dương hợp lệ/i)).toBeInTheDocument();

    fireEvent.change(amountInput, { target: { value: '10.5' } });
    fireEvent.click(donateButton);
    expect(screen.getByText(/số nguyên dương hợp lệ/i)).toBeInTheDocument();

    fireEvent.change(amountInput, { target: { value: '9007199254740992' } });
    fireEvent.click(donateButton);
    expect(screen.getByText(/số nguyên dương hợp lệ/i)).toBeInTheDocument();

    fireEvent.change(amountInput, { target: { value: '101' } });
    fireEvent.click(donateButton);
    expect(screen.getByText(/vượt quá số dư hiện có/i)).toBeInTheDocument();
    expect(screen.queryByText(/bạn có chắc chắn xác nhận/i)).not.toBeInTheDocument();
    expect(executeOneClickDonationRequest).not.toHaveBeenCalled();
  });

  it('mở popup xác nhận, không submit khi hủy, và gọi one-click donation khi xác nhận', async () => {
    vi.mocked(readAuthSession).mockReturnValue({ accessToken: 'access-token-001' } as never);
    vi.mocked(executeOneClickDonationRequest).mockResolvedValue('0xabcdef1234567890');

    render(<DonationProjectDetailPage />);

    await screen.findByText('Quỹ hỗ trợ khẩn cấp');
    const refreshedResponses = makeProjectFetchResponses();
    vi.mocked(fetchApi).mockReset();
    vi.mocked(fetchApi)
      .mockResolvedValueOnce({ tokenBalance: '100' } as never)
      .mockResolvedValueOnce(refreshedResponses[0] as never)
      .mockResolvedValueOnce(refreshedResponses[1] as never)
      .mockResolvedValueOnce(refreshedResponses[2] as never)
      .mockResolvedValueOnce({ tokenBalance: '50' } as never);
    fireEvent.click(screen.getByRole('button', { name: /quyên góp công khai/i }));
    await screen.findByText(/100 token/i);

    fireEvent.change(screen.getByPlaceholderText(/nhập số token muốn quyên góp/i), { target: { value: '50' } });
    fireEvent.click(screen.getByRole('button', { name: /^quyên góp$/i }));

    await screen.findByRole('heading', { name: /xác nhận quyên góp/i });
    expect(screen.getByText(/^50 token$/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Hủy$/i }));
    expect(executeOneClickDonationRequest).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /^quyên góp$/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^Xác nhận$/i }));

    await waitFor(() => {
      expect(executeOneClickDonationRequest).toHaveBeenCalledWith('access-token-001', 'project-001', 50, false);
    });
    await screen.findByRole('heading', { name: /quyên góp thành công/i });
    expect(confetti).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Tx: 0xabcdef/i)).toBeInTheDocument();
  });

  it('hiển thị lỗi one-click donation mà không bắn pháo hoa hoặc mở popup thành công', async () => {
    vi.mocked(readAuthSession).mockReturnValue({ accessToken: 'access-token-001' } as never);
    vi.mocked(executeOneClickDonationRequest).mockRejectedValue(new Error('Relay unavailable'));

    render(<DonationProjectDetailPage />);

    await screen.findByText('Quỹ hỗ trợ khẩn cấp');
    vi.mocked(fetchApi).mockReset();
    vi.mocked(fetchApi).mockResolvedValue({ tokenBalance: '100' } as never);
    fireEvent.click(screen.getByRole('button', { name: /quyên góp công khai/i }));
    await screen.findByText(/100 token/i);

    fireEvent.change(screen.getByPlaceholderText(/nhập số token muốn quyên góp/i), { target: { value: '50' } });
    fireEvent.click(screen.getByRole('button', { name: /^quyên góp$/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^Xác nhận$/i }));

    await screen.findByText('Relay unavailable');
    expect(confetti).not.toHaveBeenCalled();
    expect(screen.queryByRole('heading', { name: /quyên góp thành công/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^quyên góp$/i })).not.toBeDisabled();
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
