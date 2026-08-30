import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ fetchApi: vi.fn() }));

vi.mock('@/app/utils/apiClient', () => ({
  buildApiUrl: (path: string) => path,
  buildSameOriginApiUrl: (path: string) => path,
  fetchApi: mocks.fetchApi,
  getApiErrorMessage: (_error: unknown, fallback: string) => fallback
}));
vi.mock('@/app/utils/authSession', () => ({ readAuthSession: () => ({ accessToken: 'governance-token' }) }));
vi.mock('@/app/components/oracle/GeofenceMapLazy', () => ({ GeofenceMapLazy: () => <div>GPS evidence map</div> }));
vi.mock('@/app/utils/committeeGovernanceSigner', () => ({ signCommitteeGovernanceVote: vi.fn() }));

import { DisbursementVotingPanel } from '@/app/components/governance/DisbursementVotingPanel';

/** Tạo case giải ngân tối thiểu để kiểm tra ngưỡng Chair/Member và GPS gate. */
function createCase(highestDeviationLevel: 'INSIDE' | 'DEVIATED' = 'INSIDE') {
  return {
    committeeCase: {
      requestId: 'request-1',
      votes: [
        { voterRole: 'executive_member', decision: 'APPROVE' as const },
        { voterRole: 'executive_member', decision: 'APPROVE' as const }
      ]
    },
    disbursement: {
      requestId: 'request-1', amount: 100, usagePurpose: 'Mua thiết bị y tế', requestMode: 'STANDARD', timeoutDeadline: null
    },
    monitoring: {
      projectId: 'project-1', highestDeviationLevel, evidencePhotos: [] as Array<{ cid: string; gps: { lat: number; lng: number } | null; deviationLevel: 'INSIDE' | 'WITHIN_ACCURACY' | 'DEVIATED' | 'CRITICAL' | 'NO_GEOFENCE'; distanceMeters: number | null; accuracyMeters: number; capturedAt: string | null; isLowAccuracyOverride: boolean; lowAccuracyReason: string | null }>
    }
  };
}

describe('DisbursementVotingPanel quorum and GPS gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('hiển thị trạng thái chờ Chair khi đã có hai phiếu Member nhưng chưa có phiếu Chair', async () => {
    mocks.fetchApi.mockResolvedValue({ data: [createCase()] });

    render(<DisbursementVotingPanel />);

    expect(await screen.findByText('Đã có đủ phiếu Ủy viên nhưng vẫn cần chữ ký Chủ tịch DAO.')).toBeInTheDocument();
    expect(screen.getByText('Phiếu Chủ tịch').parentElement).toHaveTextContent('0/1');
    expect(screen.getByText('Phiếu Ủy viên').parentElement).toHaveTextContent('2/4');
  });

  it('khóa cả hai nút vote cho DEVIATED tới khi người dùng xác nhận cảnh báo GPS', async () => {
    mocks.fetchApi.mockResolvedValue({ data: [createCase('DEVIATED')] });

    render(<DisbursementVotingPanel />);

    const approveButton = await screen.findByRole('button', { name: 'Đồng ý giải ngân' });
    const rejectButton = screen.getByRole('button', { name: 'Từ chối giải ngân' });
    expect(approveButton).toBeDisabled();
    expect(rejectButton).toBeDisabled();

    fireEvent.click(screen.getByRole('checkbox', { name: /Xác nhận rủi ro GPS/i }));

    expect(approveButton).not.toBeDisabled();
    expect(rejectButton).not.toBeDisabled();
  });

  it('hiển thị rõ ảnh đã chụp qua van thoát GPS ngay tại màn quyết định tiền', async () => {
    const pendingCase = createCase('DEVIATED');
    pendingCase.monitoring.evidencePhotos = [{
      cid: 'cid-override', gps: { lat: 21, lng: 105 }, deviationLevel: 'DEVIATED', distanceMeters: 120, accuracyMeters: 2_000,
      capturedAt: null, isLowAccuracyOverride: true, lowAccuracyReason: 'Thiết bị đo vị trí không ổn định tại hiện trường.'
    }];
    mocks.fetchApi.mockResolvedValue({ data: [pendingCase] });

    render(<DisbursementVotingPanel />);

    expect(await screen.findByText(/Có ảnh chụp qua van thoát GPS/i)).toBeInTheDocument();
    expect(screen.getByText('Thiết bị đo vị trí không ổn định tại hiện trường.')).toBeInTheDocument();
  });

  it('hiển thị lỗi tải queue và kết thúc trạng thái đồng bộ khi API pending lỗi', async () => {
    mocks.fetchApi.mockRejectedValue(new Error('network unavailable'));

    render(<DisbursementVotingPanel />);

    expect(await screen.findByRole('status')).toHaveTextContent('Không thể tải hàng chờ giải ngân.');
    expect(screen.getByText('0 yêu cầu chờ')).toBeInTheDocument();
  });

  it('chặn submit trước khi gọi API ký khi lý do chưa đủ mười ký tự', async () => {
    mocks.fetchApi.mockResolvedValue({ data: [createCase()] });

    render(<DisbursementVotingPanel />);
    await screen.findByRole('button', { name: 'Đồng ý giải ngân' });
    fireEvent.change(screen.getByLabelText('Lý do cho request-1'), { target: { value: 'ngắn' } });
    fireEvent.click(screen.getByRole('button', { name: 'Đồng ý giải ngân' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Lý do biểu quyết phải có ít nhất 10 ký tự.');
    expect(mocks.fetchApi).toHaveBeenCalledTimes(1);
  });

  it('nạp trang queue kế tiếp bằng cursor và append thay vì thay thế case đang hiển thị', async () => {
    const firstCase = createCase();
    const secondCase = createCase();
    secondCase.committeeCase.requestId = 'request-2';
    secondCase.disbursement.requestId = 'request-2';
    mocks.fetchApi
      .mockResolvedValueOnce({ data: { items: [firstCase], nextCursor: 'cursor-2' } })
      .mockResolvedValueOnce({ data: { items: [secondCase], nextCursor: null } });

    render(<DisbursementVotingPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Tải thêm yêu cầu' }));

    expect(await screen.findByText('Yêu cầu request-2')).toBeInTheDocument();
    expect(screen.getByText('Yêu cầu request-1')).toBeInTheDocument();
    expect(mocks.fetchApi).toHaveBeenLastCalledWith(
      '/api/disbursement/executive/pending?limit=20&cursor=cursor-2',
      { headers: { Authorization: 'Bearer governance-token' } }
    );
  });
});
