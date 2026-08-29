import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockCreateDraft,
  mockExecuteProposal,
  mockFetchApi,
  mockSignDraft,
  mockSubmitProposal
} = vi.hoisted(() => ({
  mockCreateDraft: vi.fn(),
  mockExecuteProposal: vi.fn(),
  mockFetchApi: vi.fn(),
  mockSignDraft: vi.fn(),
  mockSubmitProposal: vi.fn()
}));

vi.mock('@/app/utils/apiClient', () => ({
  buildApiUrl: (path: string) => path,
  fetchApi: mockFetchApi,
  getApiErrorMessage: (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback
}));

vi.mock('@/app/utils/authSession', () => ({
  readAuthSession: () => ({ accessToken: 'admin-token' })
}));

vi.mock('@/app/utils/committeeSeatChange', () => ({
  createCommitteeSeatChangeDraft: mockCreateDraft,
  executeCommitteeSeatChangeProposal: mockExecuteProposal,
  parseCommitteeSeatChangeDraft: (value: string) => JSON.parse(value),
  signCommitteeSeatChangeDraft: mockSignDraft,
  submitCommitteeSeatChangeProposal: mockSubmitProposal
}));

import CommitteeSeatsPanel from '@/app/components/systemAdmin/tailwind/CommitteeSeatsPanel';

const oldSeat = '0x1111111111111111111111111111111111111111';
const newSeat = '0x2222222222222222222222222222222222222222';
const draft = {
  oldSeat,
  newSeat,
  role: 1,
  committeeEpoch: '3',
  deadline: '4000000000',
  chainId: '80002',
  signatures: []
};

describe('CommitteeSeatsPanel seat-change workflow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchApi.mockImplementation((url: string) => Promise.resolve({
      data: url.includes('/bootstrap/state')
        ? { transactionHash: '0xbootstrapped' }
        : [{ userId: 'chair-1', displayName: 'Chair', role: 'executive_chair', walletAddress: oldSeat, accountStatus: 'ACTIVE', lastLoginAt: '2026-08-28T00:00:00.000Z' }]
    }));
    mockCreateDraft.mockResolvedValue(draft);
    mockSignDraft.mockResolvedValue({ signer: oldSeat, nonce: '4', deadline: draft.deadline, signature: '0xsigned' });
    mockSubmitProposal.mockResolvedValue('0xproposal');
    mockExecuteProposal.mockResolvedValue('0xexecuted');
  });

  it('creates, collects, relays and executes a shareable EIP-712 seat-change draft after bootstrap', async () => {
    render(<CommitteeSeatsPanel />);

    await screen.findByRole('heading', { name: 'Thay ghế on-chain (3/5 chữ ký + timelock)' });
    fireEvent.change(screen.getByLabelText('Ghế cần thay'), { target: { value: oldSeat } });
    fireEvent.change(screen.getByPlaceholderText('Địa chỉ ví ghế mới 0x...'), { target: { value: newSeat } });
    fireEvent.click(screen.getByRole('button', { name: 'Tạo draft thay ghế' }));

    await waitFor(() => expect(mockCreateDraft).toHaveBeenCalledWith(expect.objectContaining({ oldSeat, newSeat, role: 1 })));
    fireEvent.click(screen.getByRole('button', { name: 'Ký draft hiện tại' }));
    await waitFor(() => expect(mockSignDraft).toHaveBeenCalledWith(expect.objectContaining({ draft })));
    expect((screen.getByLabelText('JSON draft thay ghế') as HTMLTextAreaElement).value).toContain('0xsigned');

    fireEvent.click(screen.getByRole('button', { name: 'Gửi proposal (đủ 3 chữ ký)' }));
    await waitFor(() => expect(mockSubmitProposal).toHaveBeenCalledOnce());
    fireEvent.change(screen.getByPlaceholderText('Proposal ID sau timelock'), { target: { value: '12' } });
    fireEvent.click(screen.getByRole('button', { name: 'Thực thi proposal' }));
    await waitFor(() => expect(mockExecuteProposal).toHaveBeenCalledWith(expect.objectContaining({ chainId: '80002', proposalId: '12' })));
  });
});
