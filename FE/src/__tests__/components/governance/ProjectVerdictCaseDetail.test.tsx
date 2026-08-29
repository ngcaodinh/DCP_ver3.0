import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ fetchApi: vi.fn(), signCommitteeGovernanceVote: vi.fn() }));

vi.mock('@/app/utils/apiClient', () => ({ buildApiUrl: (path: string) => path, fetchApi: mocks.fetchApi }));
vi.mock('@/app/utils/authSession', () => ({ readAuthSession: () => ({ accessToken: 'governance-token' }) }));
vi.mock('@/app/components/oracle/GeofenceMapLazy', () => ({ GeofenceMapLazy: () => <div data-testid="gps-map">GPS map</div> }));
vi.mock('@/app/components/governance/ChallengeEvidenceGallery', () => ({ ChallengeEvidenceGallery: () => <div>Challenge evidence gallery</div> }));
vi.mock('@/app/components/governance/CommitteeSeatChangeSigningPanel', () => ({ CommitteeSeatChangeSigningPanel: () => <div>Seat signing panel</div> }));
vi.mock('@/app/utils/committeeGovernanceSigner', () => ({ signCommitteeGovernanceVote: mocks.signCommitteeGovernanceVote }));

import ExecutivePortalClient from '@/app/components/governance/ExecutivePortalClient';

const caseSummary = {
  arbitrationId: 'case-1', projectId: 'project-1', projectName: 'Dự án an toàn', organizationName: 'Tổ chức A',
  deadlineAt: '2026-12-31T00:00:00.000Z', challengeCount: 1, upholdVoteCount: 2, rejectVoteCount: 0,
  requiredMemberVotes: 2, totalMemberSeats: 4, hasCurrentUserVoted: false
};

const caseDetail = {
  arbitrationId: 'case-1', activationState: 'ACTIVE',
  geofence: { polygon: [{ lat: 10, lng: 106 }, { lat: 10.001, lng: 106 }, { lat: 10, lng: 106.001 }] },
  committeeSnapshot: [
    { userId: 'chair-1', role: 'executive_chair' },
    { userId: 'member-1', role: 'executive_member' },
    { userId: 'member-2', role: 'executive_member' }
  ],
  votes: [
    { voterUserId: 'member-1', voterName: 'Member 1', voterRole: 'executive_member', decision: 'UPHOLD_PROJECT', reason: 'Đồng ý giữ dự án.' },
    { voterUserId: 'member-2', voterName: 'Member 2', voterRole: 'executive_member', decision: 'UPHOLD_PROJECT', reason: 'Bằng chứng phù hợp.' }
  ],
  challenges: [{
    challengerName: 'Auditor A', reason: 'Cần hội đồng kiểm tra vị trí hiện trường.', evidencePhotos: [{
      cid: 'bafy-critical', capturedAt: '2026-08-28T00:00:00.000Z', gps: { latitude: 10.002, longitude: 106.002 },
      accuracyMeters: 10, distanceMeters: 800, deviationLevel: 'CRITICAL' as const, isLowAccuracyOverride: false, lowAccuracyReason: null
    }]
  }],
  project: { projectId: 'project-1', name: 'Dự án an toàn', description: 'Mô tả dự án.', organizationName: 'Tổ chức A', status: 'ACTIVE', totalDonationAmount: 2500000 }
};

const caseDetailWithoutDonationRisk = {
  ...caseDetail,
  project: { ...caseDetail.project, totalDonationAmount: 0 }
};

describe('ProjectVerdictCaseDetail GPS and quorum safeguards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchApi.mockImplementation((url: string) => Promise.resolve({ data: url.endsWith('/case-1') ? caseDetail : [caseSummary] }));
    mocks.signCommitteeGovernanceVote.mockResolvedValue({ signature: '0xsigned', signingRequestId: 'signing-1' });
  });

  it('hiển thị bản đồ, cảnh báo GPS và trạng thái chưa đạt khi đủ Member nhưng thiếu Chair', async () => {
    render(<ExecutivePortalClient />);
    fireEvent.click(await screen.findByRole('button', { name: /Dự án an toàn/i }));

    expect(await screen.findByTestId('gps-map')).toBeInTheDocument();
    expect(screen.getByText('Cảnh báo GPS')).toBeInTheDocument();
    expect(screen.getByText(/Lệch vị trí nghiêm trọng/)).toBeInTheDocument();
    expect(screen.getByText('Đã đủ phiếu Ủy viên nhưng vẫn cần chữ ký Chủ tịch DAO.')).toBeInTheDocument();
  });

  it('yêu cầu xác nhận riêng trước phán quyết hủy dự án vĩnh viễn', async () => {
    render(<ExecutivePortalClient />);
    fireEvent.click(await screen.findByRole('button', { name: /Dự án an toàn/i }));
    await screen.findByTestId('gps-map');

    fireEvent.click(screen.getByRole('button', { name: 'Hủy dự án' }));

    expect(screen.getByRole('dialog', { name: 'Xác nhận hủy dự án' })).toHaveTextContent('khóa vĩnh viễn hồ sơ');
    expect(screen.getByText(/2.500.000 VND/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Xác nhận hủy vĩnh viễn' })).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: /Dự án này đã nhận/i }));
    expect(screen.getByRole('button', { name: 'Xác nhận hủy vĩnh viễn' })).toBeEnabled();
  });

  it('không yêu cầu checkbox khi dự án không có tiền quyên góp dù đang ACTIVE', async () => {
    mocks.fetchApi.mockImplementation((url: string) => Promise.resolve({ data: url.endsWith('/case-1') ? caseDetailWithoutDonationRisk : [caseSummary] }));
    render(<ExecutivePortalClient />);
    fireEvent.click(await screen.findByRole('button', { name: /Dự án an toàn/i }));
    await screen.findByTestId('gps-map');

    fireEvent.click(screen.getByRole('button', { name: 'Hủy dự án' }));

    expect(screen.queryByRole('checkbox', { name: /Dự án này đã nhận/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Xác nhận hủy vĩnh viễn' })).toBeEnabled();
  });

  it('gửi acknowledgement đã chọn cùng chữ ký EIP-712 khi xác nhận hủy có tiền', async () => {
    mocks.fetchApi.mockImplementation((url: string) => {
      if (url.endsWith('/case-1')) return Promise.resolve({ data: caseDetail });
      if (url.endsWith('/signing-payload')) return Promise.resolve({ data: { signingRequestId: 'signing-1' } });
      if (url.endsWith('/vote')) return Promise.resolve({ data: { arbitrationId: 'case-1' } });
      return Promise.resolve({ data: [caseSummary] });
    });
    render(<ExecutivePortalClient />);
    fireEvent.click(await screen.findByRole('button', { name: /Dự án an toàn/i }));
    await screen.findByTestId('gps-map');
    fireEvent.change(screen.getByRole('textbox', { name: 'Lý do phán quyết' }), { target: { value: 'Bằng chứng xác nhận cần hủy dự án ngay.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Hủy dự án' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Dự án này đã nhận/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Xác nhận hủy vĩnh viễn' }));

    await waitFor(() => expect(mocks.fetchApi).toHaveBeenCalledWith(
      '/api/project-governance/executive/vote',
      expect.objectContaining({ method: 'POST', body: expect.stringContaining('"donationLockRiskAcknowledged":true') })
    ));
    expect(mocks.signCommitteeGovernanceVote).toHaveBeenCalledWith({ signingRequestId: 'signing-1' });
  });
});
