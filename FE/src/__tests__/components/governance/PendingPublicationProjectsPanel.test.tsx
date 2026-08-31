import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ fetchApi: vi.fn() }));

vi.mock('@/app/utils/apiClient', () => ({ buildSameOriginApiUrl: (path: string) => path, fetchApi: mocks.fetchApi, getApiErrorMessage: (_error: unknown, fallback: string) => fallback }));
vi.mock('@/app/utils/authSession', () => ({ readAuthSession: () => ({ accessToken: 'governance-token' }) }));
vi.mock('@/app/components/oracle/GeofenceMapLazy', () => ({ GeofenceMapLazy: () => <div data-testid="gps-map">GPS map</div> }));

import { PendingPublicationProjectsPanel } from '@/app/components/governance/PendingPublicationProjectsPanel';

const disputedSummary = {
  projectId: 'disputed-1', name: 'Dự án đang tranh chấp', status: 'DISPUTED' as const, listingRound: 2, organizationName: 'Tổ chức A',
  kyc: { status: 'APPROVED' as const, reviewedAt: '2026-08-30T00:00:00.000Z' }, goalAmount: 5_000_000,
  donationSummary: { totalAmount: 0, donationCount: 0 }, listedAt: '2026-08-29T00:00:00.000Z', activationEligibleAt: '2026-09-01T00:00:00.000Z', challengeCount: 1, verificationCount: 0, integrityIssues: [], evidence: { mode: 'CHALLENGE' as const, records: [] },
  arbitration: { arbitrationId: 'case-1', openedByChallengeId: 'challenge-1', deadlineAt: '2026-12-31T00:00:00.000Z', requiredMemberVotes: 2, totalCommitteeSeats: 5, voteCount: 0, upholdVoteCount: 0, upholdChairVoteCount: 0, upholdMemberVoteCount: 0, rejectVoteCount: 0, hasCurrentUserVoted: false, canCurrentUserVote: true }
};

const pendingSummary = {
  projectId: 'pending-1', name: 'Dự án chờ xác minh', status: 'PENDING_ACTIVATION' as const, listingRound: 1, organizationName: 'Tổ chức B',
  kyc: { status: 'NOT_SUBMITTED' as const, reviewedAt: null }, goalAmount: 1_000_000,
  donationSummary: { totalAmount: 0, donationCount: 0 }, listedAt: null, activationEligibleAt: null, challengeCount: 0, verificationCount: 1, integrityIssues: [], evidence: { mode: 'VERIFICATION' as const, records: [] }, arbitration: null
};

/** Bọc component bằng client độc lập để cache query không rò sang test kế tiếp. */
function renderPanel(): ReturnType<typeof render> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><PendingPublicationProjectsPanel /></QueryClientProvider>);
}

describe('PendingPublicationProjectsPanel', () => {
  beforeEach(() => vi.clearAllMocks());

  it('làm nổi bật DISPUTED bằng viền animation giảm chuyển động được và ưu tiên nội dung khiếu nại', async () => {
    mocks.fetchApi.mockImplementation((url: string) => Promise.resolve({ data: url.includes('/disputed-1') ? {
      ...disputedSummary, description: 'Cần kiểm tra lại hiện trường.', deadline: '2026-12-31T00:00:00.000Z', listedAt: null, milestonePlan: [], evidenceFiles: [],
      geofence: { polygon: [], centroid: { lat: 10, lng: 106 }, radiusMeters: 100 },
      evidence: { mode: 'CHALLENGE', records: [{ recordId: 'challenge-1', auditorLabel: 'Auditor A', note: null, reason: 'Ảnh chụp nằm ngoài vị trí đã đăng ký.', submittedAt: '2026-08-30T00:00:00.000Z', evidencePhotos: [] }] }
    } : { items: [disputedSummary, pendingSummary], nextCursor: null } }));

    renderPanel();

    const disputedCard = await screen.findByRole('button', { name: /Dự án đang tranh chấp/i });
    expect(disputedCard).toHaveClass('border-rose-400');
    expect(disputedCard).toHaveTextContent('KYC đã phê duyệt');
    expect(disputedCard.querySelector('.motion-reduce\\:animate-none')).not.toBeNull();
    fireEvent.click(disputedCard);

    expect(await screen.findByText('Ảnh chụp nằm ngoài vị trí đã đăng ký.')).toBeInTheDocument();
    expect(screen.getByText('Biểu quyết on-chain')).toBeInTheDocument();
    expect(screen.getByTestId('gps-map')).toBeInTheDocument();
  });

  it('hiển thị ảnh/xác minh tích cực cho PENDING_ACTIVATION nhưng tuyệt đối không render action vote', async () => {
    mocks.fetchApi.mockImplementation((url: string) => Promise.resolve({ data: url.includes('/pending-1') ? {
      ...pendingSummary, description: 'Dự án đang trong cửa sổ niêm yết.', deadline: '2026-12-31T00:00:00.000Z', listedAt: null, milestonePlan: [], evidenceFiles: [],
      geofence: null,
      evidence: { mode: 'VERIFICATION', records: [{ recordId: 'verification-1', auditorLabel: 'Auditor B', note: 'Đã xác minh công trình thực địa.', reason: null, submittedAt: '2026-08-30T00:00:00.000Z', evidencePhotos: [] }] }
    } : { items: [pendingSummary], nextCursor: null } }));

    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: /Dự án chờ xác minh/i }));

    expect(await screen.findByText('Đã xác minh công trình thực địa.')).toBeInTheDocument();
    expect(screen.queryByText('Biểu quyết on-chain')).not.toBeInTheDocument();
  });

  it('trung thực hiển thị UNVERIFIED thay vì suy diễn là dự án đã được Auditor xác minh', async () => {
    const unverifiedSummary = { ...pendingSummary, projectId: 'pending-2', name: 'Dự án chưa có evidence', evidence: { mode: 'UNVERIFIED' as const, records: [] } };
    mocks.fetchApi.mockImplementation((url: string) => Promise.resolve({ data: url.includes('/pending-2') ? {
      ...unverifiedSummary, description: 'Chưa có evidence.', deadline: '2026-12-31T00:00:00.000Z', listedAt: null, milestonePlan: [], evidenceFiles: [], geofence: null, evidence: { mode: 'UNVERIFIED', records: [] }
    } : { items: [unverifiedSummary], nextCursor: null } }));

    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: /Dự án chưa có evidence/i }));

    expect(await screen.findByText(/Đây không phải là kết luận dự án đã được xác minh/)).toBeInTheDocument();
  });

  it('cảnh báo dữ liệu tranh chấp thiếu liên kết và không render action ký on-chain', async () => {
    const corruptSummary = {
      ...disputedSummary,
      projectId: 'disputed-corrupt',
      name: 'Dự án thiếu challenge gốc',
      integrityIssues: ['MISSING_CHALLENGE' as const],
      arbitration: { ...disputedSummary.arbitration, canCurrentUserVote: false }
    };
    mocks.fetchApi.mockImplementation((url: string) => Promise.resolve({ data: url.includes('/disputed-corrupt') ? {
      ...corruptSummary,
      description: 'Dữ liệu tranh chấp cần được xử lý.', deadline: '2026-12-31T00:00:00.000Z', milestonePlan: [], evidenceFiles: [], geofence: null,
      evidence: { mode: 'CHALLENGE', records: [] }
    } : { items: [corruptSummary], nextCursor: null } }));

    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: /Dự án thiếu challenge gốc/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/biểu quyết .*bị khóa/i);
    expect(screen.queryByText('Biểu quyết on-chain')).not.toBeInTheDocument();
  });

  it('hiển thị trạng thái rỗng và retry được sau lỗi tải danh sách', async () => {
    mocks.fetchApi.mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce({ data: { items: [], nextCursor: null } });

    renderPanel();
    const retryButton = await screen.findByRole('button', { name: /Thử lại/i });
    fireEvent.click(retryButton);

    expect(await screen.findByText(/Không có dự án chờ công bố/i)).toBeInTheDocument();
    expect(mocks.fetchApi).toHaveBeenCalledTimes(2);
  });

  it('tải trang cursor tiếp theo mà vẫn giữ card của trang trước', async () => {
    const secondSummary = { ...pendingSummary, projectId: 'pending-2', name: 'Dự án trang hai' };
    mocks.fetchApi.mockImplementation((url: string) => Promise.resolve({ data: url.includes('cursor=next-cursor')
      ? { items: [secondSummary], nextCursor: null }
      : { items: [pendingSummary], nextCursor: 'next-cursor' } }));

    renderPanel();
    expect(await screen.findByRole('button', { name: /Dự án chờ xác minh/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Tải thêm dự án/i }));

    expect(await screen.findByRole('button', { name: /Dự án trang hai/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Dự án chờ xác minh/i })).toBeInTheDocument();
    await waitFor(() => expect(mocks.fetchApi).toHaveBeenCalledWith(
      expect.stringContaining('cursor=next-cursor'),
      { headers: { Authorization: 'Bearer governance-token' } }
    ));
  });

  it('không để detail response cũ ghi đè card được chọn sau cùng', async () => {
    let resolveFirstDetail: (value: unknown) => void = () => undefined;
    let resolveSecondDetail: (value: unknown) => void = () => undefined;
    const firstDetail = new Promise(resolve => { resolveFirstDetail = resolve; });
    const secondDetail = new Promise(resolve => { resolveSecondDetail = resolve; });
    const secondSummary = { ...pendingSummary, projectId: 'pending-race-2', name: 'Dự án chọn sau' };
    mocks.fetchApi.mockImplementation((url: string) => {
      if (url.includes('/pending-1')) return firstDetail;
      if (url.includes('/pending-race-2')) return secondDetail;
      return Promise.resolve({ data: { items: [pendingSummary, secondSummary], nextCursor: null } });
    });

    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: /Dự án chờ xác minh/i }));
    fireEvent.click(screen.getByRole('button', { name: /Dự án chọn sau/i }));
    resolveSecondDetail({ data: {
      ...secondSummary, description: 'Chi tiết card chọn sau.', deadline: '2026-12-31T00:00:00.000Z', milestonePlan: [], evidenceFiles: [], geofence: null,
      evidence: { mode: 'VERIFICATION', records: [] }
    } });

    expect(await screen.findByText('Chi tiết card chọn sau.')).toBeInTheDocument();
    resolveFirstDetail({ data: {
      ...pendingSummary, description: 'Chi tiết card cũ không được hiển thị.', deadline: '2026-12-31T00:00:00.000Z', milestonePlan: [], evidenceFiles: [], geofence: null,
      evidence: { mode: 'VERIFICATION', records: [] }
    } });

    await waitFor(() => expect(screen.queryByText('Chi tiết card cũ không được hiển thị.')).not.toBeInTheDocument());
    expect(screen.getByText('Chi tiết card chọn sau.')).toBeInTheDocument();
  });
});
