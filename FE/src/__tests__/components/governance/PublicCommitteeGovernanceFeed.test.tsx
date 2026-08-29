import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ fetchApi: vi.fn() }));

vi.mock('@/app/utils/apiClient', () => ({
  buildApiUrl: (path: string) => path,
  fetchApi: mocks.fetchApi,
  getApiErrorMessage: (_error: unknown, fallback: string) => fallback
}));

import { PublicCommitteeDecisionFeed, PublicCommitteeGovernanceFeed } from '@/app/components/governance/PublicCommitteeGovernanceFeed';

describe('public committee governance feeds', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('đọc event đã project từ API thay vì khởi tạo RPC và quét block ở trình duyệt', async () => {
    mocks.fetchApi.mockResolvedValue({ data: {
      items: [{ transactionHash: '0x1234567890abcdef', occurredAt: '2026-08-29T00:00:00.000Z', eventType: 'SEAT_CHANGE_EXECUTED', eventData: {} }]
    } });

    render(<PublicCommitteeGovernanceFeed />);

    expect(await screen.findByText('Đã thực thi đổi ghế')).toBeInTheDocument();
    expect(mocks.fetchApi).toHaveBeenCalledWith('/api/governance/public/events?limit=8');
  });

  it('hiển thị vai trò, cam kết lý do và nút tải bundle chữ ký mà không render free-text nội bộ', async () => {
    mocks.fetchApi.mockResolvedValue({ data: {
      items: [{
        requestId: 'REQ-1', approved: true, onChainDecisionTxHash: '0xabcdef1234567890', recordedAt: '2026-08-29T00:00:00.000Z',
        votes: [{ voterName: 'Chủ tịch A', voterRole: 'executive_chair', decision: 'APPROVE', reason: 'Đủ điều kiện giải ngân.', votedAt: '2026-08-29T00:00:00.000Z', signature: '0xsig', signedPayloadHash: '0xhash', reasonCommitment: '0xreason', nonce: '1', deadline: '2026-08-30T00:00:00.000Z', committeeEpoch: '7' }]
      }]
    } });

    render(<PublicCommitteeDecisionFeed />);

    expect(await screen.findByText('Chủ tịch A')).toBeInTheDocument();
    expect(screen.getByText('Cam kết lý do:')).toBeInTheDocument();
    expect(screen.getByText('0xreason')).toBeInTheDocument();
    expect(screen.queryByText('Đủ điều kiện giải ngân.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tải bộ chữ ký' })).toBeInTheDocument();
    expect(mocks.fetchApi).toHaveBeenCalledWith('/api/governance/public/decisions?limit=12');
  });

  it('hiển thị empty state khi projector chưa có event thay vì cố quét RPC từ trình duyệt', async () => {
    mocks.fetchApi.mockResolvedValue({ data: { items: [] } });

    render(<PublicCommitteeGovernanceFeed />);

    expect(await screen.findByText('Chưa có mốc quản trị được projector ghi nhận.')).toBeInTheDocument();
    expect(mocks.fetchApi).toHaveBeenCalledOnce();
  });

  it('hiển thị thông báo an toàn khi public decision API lỗi và không render empty state sai ngữ cảnh', async () => {
    mocks.fetchApi.mockRejectedValue(new Error('network unavailable'));

    render(<PublicCommitteeDecisionFeed />);

    expect(await screen.findByRole('status')).toHaveTextContent('Chưa thể tải quyết định Ủy ban công khai. Vui lòng thử lại sau.');
    expect(screen.queryByText('Chưa có quyết định Ủy ban được ghi nhận trên chain.')).not.toBeInTheDocument();
  });

  it('tạo bundle tải về từ decision đã được API xác minh', async () => {
    const createObjectUrl = vi.fn(() => 'blob:committee-decision');
    const revokeObjectUrl = vi.fn();
    const clickAnchor = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectUrl });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectUrl });
    mocks.fetchApi.mockResolvedValue({ data: {
      items: [{ requestId: 'REQ-DOWNLOAD', approved: true, onChainDecisionTxHash: null, recordedAt: '2026-08-29T00:00:00.000Z', votes: [] }]
    } });

    render(<PublicCommitteeDecisionFeed />);
    fireEvent.click(await screen.findByRole('button', { name: 'Tải bộ chữ ký' }));

    expect(createObjectUrl).toHaveBeenCalledWith(expect.any(Blob));
    expect(clickAnchor).toHaveBeenCalledOnce();
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:committee-decision');
    clickAnchor.mockRestore();
  });

  it('hiển thị lịch sử vòng ký lại của phán quyết xét xử để công chúng thấy lý do đổi ý', async () => {
    mocks.fetchApi.mockResolvedValue({ data: {
      items: [{
        requestId: 'ARB-1', decisionKind: 'ARBITRATION', approved: false, onChainDecisionTxHash: null, recordedAt: '2026-08-29T00:00:00.000Z', votes: [],
        supersededVoteRounds: [{ verdict: 'UPHOLD_PROJECT', supersededAt: '2026-08-28T00:00:00.000Z', reason: 'Epoch Ủy ban đã thay đổi.', votes: [] }]
      }]
    } });

    render(<PublicCommitteeDecisionFeed />);

    expect(await screen.findByText('Phán quyết xét xử: Từ chối')).toBeInTheDocument();
    expect(screen.getByText('Lịch sử 2 vòng biểu quyết')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Lịch sử 2 vòng biểu quyết'));
    expect(screen.getByText('Ký lại vì: Epoch Ủy ban đã thay đổi.')).toBeInTheDocument();
  });
});
