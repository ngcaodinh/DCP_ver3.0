import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { mockFetchApi, mockSignCommitteeGovernanceVote } = vi.hoisted(() => ({
  mockFetchApi: vi.fn(),
  mockSignCommitteeGovernanceVote: vi.fn()
}));

interface Deferred<T> { promise: Promise<T>; resolve: (value: T) => void; }

/** Tạo promise điều khiển được thời điểm hoàn tất để kiểm tra phản hồi API về trễ. */
function createDeferred<T>(): Deferred<T> {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>(resolve => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}
vi.mock('@/app/utils/apiClient', () => ({ buildApiUrl: (path: string) => path, fetchApi: mockFetchApi }));
vi.mock('@/app/utils/authSession', () => ({ readAuthSession: () => ({ accessToken: 'token' }) }));
vi.mock('@/app/utils/committeeGovernanceSigner', () => ({ signCommitteeGovernanceVote: mockSignCommitteeGovernanceVote }));

import ExecutivePortalClient from '@/app/components/governance/ExecutivePortalClient';

const caseSummary = { arbitrationId: 'case-1', projectId: 'project-1', projectName: 'Dự án A', organizationName: 'Tổ chức A', deadlineAt: '2026-12-31T00:00:00.000Z', challengeCount: 1, upholdVoteCount: 0, rejectVoteCount: 0, hasCurrentUserVoted: false };
const caseDetail = { arbitrationId: 'case-1', committeeSnapshot: [{ userId: 'chair-1', role: 'executive_chair' }], votes: [], challenges: [{ challengerName: 'Auditor A', reason: 'Lý do khiếu nại đủ dài.', evidencePhotos: [] }], project: { name: 'Dự án A', description: 'Mô tả dự án.', organizationName: 'Tổ chức A' } };

/** Bọc portal bằng QueryClient riêng để hook geofence có đúng context như khi chạy trong layout ứng dụng. */
function renderExecutivePortal(): ReturnType<typeof render> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}><ExecutivePortalClient /></QueryClientProvider>);
}

describe('ExecutivePortalClient', () => {
  beforeEach(() => {
    mockFetchApi.mockReset();
    mockSignCommitteeGovernanceVote.mockReset();
  });

  it('does not request signing or submit either verdict without a valid reason', async () => {
    mockFetchApi.mockImplementation((url: string) => Promise.resolve({ data: url.includes('/case-1') ? caseDetail : [caseSummary] }));
    renderExecutivePortal();
    fireEvent.click(await screen.findByRole('button', { name: /Dự án A/i }));
    await screen.findByText('Lý do khiếu nại đủ dài.');
    fireEvent.click(screen.getByRole('button', { name: 'Bác khiếu nại' }));
    expect(screen.getByText(/ít nhất 10 ký tự/i)).toBeInTheDocument();
    expect(mockFetchApi).not.toHaveBeenCalledWith('/api/project-governance/executive/signing-payload', expect.anything());
    expect(mockFetchApi).not.toHaveBeenCalledWith('/api/project-governance/executive/vote', expect.anything());
  });

  it('submits a reject verdict with a trimmed reason', async () => {
    mockFetchApi.mockImplementation((url: string) => {
      if (url.includes('/signing-payload')) return Promise.resolve({ data: { signingRequestId: 'signing-1' } });
      if (url.includes('/vote')) return Promise.resolve({ data: {} });
      return Promise.resolve({ data: url.includes('/case-1') ? caseDetail : [caseSummary] });
    });
    mockSignCommitteeGovernanceVote.mockResolvedValue({ signature: '0xsignature', signingRequestId: 'signing-1' });
    renderExecutivePortal();
    fireEvent.click(await screen.findByRole('button', { name: /Dự án A/i }));
    await screen.findByText('Lý do khiếu nại đủ dài.');
    fireEvent.change(screen.getByRole('textbox', { name: 'Lý do phán quyết' }), { target: { value: '  Đủ lý do xét xử  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Hủy dự án' }));
    expect(screen.getByRole('dialog', { name: 'Xác nhận hủy dự án' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Xác nhận hủy vĩnh viễn' }));
    await waitFor(() => expect(mockFetchApi).toHaveBeenCalledWith('/api/project-governance/executive/vote', expect.objectContaining({ method: 'POST', body: JSON.stringify({ arbitrationId: 'case-1', decision: 'REJECT_PROJECT', reason: 'Đủ lý do xét xử', markedAbusive: false, donationLockRiskAcknowledged: false, eip712Signature: { signature: '0xsignature', signingRequestId: 'signing-1' } }) })));
  });

  it('submits an uphold verdict with the abusive-challenge flag only for that verdict', async () => {
    mockFetchApi.mockImplementation((url: string) => {
      if (url.includes('/signing-payload')) return Promise.resolve({ data: null });
      if (url.includes('/vote')) return Promise.resolve({ data: {} });
      return Promise.resolve({ data: url.includes('/case-1') ? caseDetail : [caseSummary] });
    });
    renderExecutivePortal();
    fireEvent.click(await screen.findByRole('button', { name: /Dự án A/i }));
    await screen.findByText('Lý do khiếu nại đủ dài.');
    fireEvent.change(screen.getByRole('textbox', { name: 'Lý do phán quyết' }), { target: { value: 'Đủ lý do bác khiếu nại.' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /Đánh dấu khiếu nại này là quấy rối/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Bác khiếu nại' }));

    await waitFor(() => expect(mockFetchApi).toHaveBeenCalledWith('/api/project-governance/executive/vote', expect.objectContaining({ method: 'POST', body: JSON.stringify({ arbitrationId: 'case-1', decision: 'UPHOLD_PROJECT', reason: 'Đủ lý do bác khiếu nại.', markedAbusive: true, donationLockRiskAcknowledged: false }) })));
  });

  it('requires acknowledgement before submitting a reject verdict for an active project with donations', async () => {
    const activeDonationCaseDetail = {
      ...caseDetail,
      project: { ...caseDetail.project, projectId: 'project-1', status: 'ACTIVE', totalDonationAmount: 1_000_000 }
    };
    mockFetchApi.mockImplementation((url: string) => {
      if (url.includes('/signing-payload')) return Promise.resolve({ data: null });
      if (url.includes('/vote')) return Promise.resolve({ data: {} });
      return Promise.resolve({ data: url.includes('/case-1') ? activeDonationCaseDetail : [caseSummary] });
    });
    renderExecutivePortal();
    fireEvent.click(await screen.findByRole('button', { name: /Dự án A/i }));
    await screen.findByText('Lý do khiếu nại đủ dài.');
    fireEvent.change(screen.getByRole('textbox', { name: 'Lý do phán quyết' }), { target: { value: 'Đủ lý do hủy dự án.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Hủy dự án' }));

    const confirmButton = screen.getByRole('button', { name: 'Xác nhận hủy vĩnh viễn' });
    expect(confirmButton).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: /Tôi hiểu rằng hủy dự án sẽ khóa vĩnh viễn/i }));
    expect(confirmButton).toBeEnabled();
    fireEvent.click(confirmButton);

    await waitFor(() => expect(mockFetchApi).toHaveBeenCalledWith('/api/project-governance/executive/vote', expect.objectContaining({ method: 'POST', body: JSON.stringify({ arbitrationId: 'case-1', decision: 'REJECT_PROJECT', reason: 'Đủ lý do hủy dự án.', markedAbusive: false, donationLockRiskAcknowledged: true }) })));
  });

  it('shows the signing error and does not submit a vote when EIP-712 signing fails', async () => {
    mockFetchApi.mockImplementation((url: string) => {
      if (url.includes('/signing-payload')) return Promise.resolve({ data: { signingRequestId: 'signing-1' } });
      return Promise.resolve({ data: url.includes('/case-1') ? caseDetail : [caseSummary] });
    });
    mockSignCommitteeGovernanceVote.mockRejectedValue(new Error('Ví từ chối ký EIP-712.'));
    renderExecutivePortal();
    fireEvent.click(await screen.findByRole('button', { name: /Dự án A/i }));
    await screen.findByText('Lý do khiếu nại đủ dài.');
    fireEvent.change(screen.getByRole('textbox', { name: 'Lý do phán quyết' }), { target: { value: 'Đủ lý do bác khiếu nại.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Bác khiếu nại' }));

    expect(await screen.findByText('Ví từ chối ký EIP-712.')).toBeInTheDocument();
    expect(mockFetchApi).not.toHaveBeenCalledWith('/api/project-governance/executive/vote', expect.anything());
  });

  it('chỉ hiển thị chi tiết của hồ sơ được chọn gần nhất khi API phản hồi đảo thứ tự', async () => {
    const secondCase = { ...caseSummary, arbitrationId: 'case-2', projectId: 'project-2', projectName: 'Dự án B', organizationName: 'Tổ chức B' };
    const firstDetail = createDeferred<{ data: typeof caseDetail }>();
    const secondDetail = createDeferred<{ data: typeof caseDetail }>();
    mockFetchApi.mockImplementation((url: string) => {
      if (url.endsWith('/cases')) return Promise.resolve({ data: [caseSummary, secondCase] });
      return url.endsWith('/case-1') ? firstDetail.promise : secondDetail.promise;
    });

    renderExecutivePortal();

    fireEvent.click(await screen.findByRole('button', { name: /Dự án A/i }));
    fireEvent.click(screen.getByRole('button', { name: /Dự án B/i }));
    secondDetail.resolve({ data: { ...caseDetail, arbitrationId: 'case-2', project: { name: 'Dự án B', description: 'Mô tả mới của dự án B.', organizationName: 'Tổ chức B' } } });
    expect(await screen.findByText('Mô tả mới của dự án B.')).toBeInTheDocument();

    firstDetail.resolve({ data: { ...caseDetail, project: { name: 'Dự án A', description: 'Mô tả cũ của dự án A.', organizationName: 'Tổ chức A' } } });
    await waitFor(() => expect(screen.queryByText('Mô tả cũ của dự án A.')).not.toBeInTheDocument());
  });
});
