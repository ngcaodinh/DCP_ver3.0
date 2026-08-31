import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ submitExecutiveArbitrationVote: vi.fn() }));

vi.mock('@/app/utils/executiveArbitrationVote', () => ({ submitExecutiveArbitrationVote: mocks.submitExecutiveArbitrationVote }));
vi.mock('@/app/utils/apiClient', () => ({ getApiErrorMessage: (_error: unknown, fallback: string) => fallback }));

import { ProjectVerdictVotingActions } from '@/app/components/governance/ProjectVerdictVotingActions';

describe('ProjectVerdictVotingActions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.submitExecutiveArbitrationVote.mockResolvedValue(undefined);
  });

  it('chỉ gửi vote sau lý do hợp lệ và dùng hành động tiếp tục theo cùng arbitrationId', async () => {
    const onVoted = vi.fn().mockResolvedValue(undefined);
    render(<ProjectVerdictVotingActions arbitrationId="case-1" canVote project={{ status: 'DISPUTED', totalDonationAmount: 0 }} onVoted={onVoted} />);

    fireEvent.change(screen.getByRole('textbox', { name: 'Lý do phán quyết' }), { target: { value: 'Evidence hiện trường hợp lệ để tiếp tục dự án.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Tiếp tục dự án' }));

    await waitFor(() => expect(mocks.submitExecutiveArbitrationVote).toHaveBeenCalledWith(expect.objectContaining({ arbitrationId: 'case-1', decision: 'UPHOLD_PROJECT', markedAbusive: false })));
    expect(onVoted).toHaveBeenCalledOnce();
  });

  it('khóa action khi người xem không thuộc snapshot hoặc đã biểu quyết', () => {
    render(<ProjectVerdictVotingActions arbitrationId="case-1" canVote={false} project={{ status: 'DISPUTED', totalDonationAmount: 0 }} onVoted={vi.fn()} />);

    expect(screen.getByText(/chỉ có quyền xem case này/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Tiếp tục dự án' })).not.toBeInTheDocument();
  });

  it('bắt xác nhận rủi ro trước khi hủy dự án DISPUTED đã có donation INDEXED', async () => {
    render(<ProjectVerdictVotingActions arbitrationId="case-1" canVote project={{ status: 'DISPUTED', totalDonationAmount: 2_500_000 }} onVoted={vi.fn()} />);

    fireEvent.change(screen.getByRole('textbox', { name: 'Lý do phán quyết' }), { target: { value: 'Chứng cứ hiện trường yêu cầu hủy dự án này ngay.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Hủy dự án' }));

    const confirmButton = screen.getByRole('button', { name: 'Xác nhận hủy vĩnh viễn' });
    expect(screen.getByText(/2.500.000 VND/)).toBeInTheDocument();
    expect(confirmButton).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: /Dự án này đã nhận/i }));
    expect(confirmButton).toBeEnabled();
    fireEvent.click(confirmButton);

    await waitFor(() => expect(mocks.submitExecutiveArbitrationVote).toHaveBeenCalledWith(expect.objectContaining({
      decision: 'REJECT_PROJECT', donationLockRiskAcknowledged: true
    })));
  });
});
