import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import AuditorEarningsPanel from '@/app/components/governance/AuditorEarningsPanel';

describe('AuditorEarningsPanel', () => {
  it('states explicitly when no ledger entries or payouts exist', async () => {
    render(<AuditorEarningsPanel isActive fetchAuditorResource={vi.fn().mockResolvedValue({ claimableRewardVnd: 0, ledgerEntries: [], payouts: [] })} />);

    expect(await screen.findByText('Chưa phát sinh khoản thù lao hoặc phạt nào.')).toBeInTheDocument();
    expect(screen.getByText('Bạn chưa có khoản chuyển tiền nào.')).toBeInTheDocument();
    expect(screen.getByText('Chưa có khoản thưởng nào sẵn sàng rút. Thưởng mới sẽ hiện ở đây sau khi được ghi nhận và cộng vào ví (7 ngày sau khi phát sinh).')).toBeInTheDocument();
    expect(screen.queryByText(/Cơ chế chi trả Bounty đang được hoàn thiện/)).not.toBeInTheDocument();
  });

  it('shows the manual-review operational notice and masked payout account', async () => {
    render(<AuditorEarningsPanel isActive fetchAuditorResource={vi.fn().mockResolvedValue({ claimableRewardVnd: 0, ledgerEntries: [], payouts: [{ payoutId: 'payout-1', payoutType: 'REWARD', status: 'MANUAL_REVIEW', amountVnd: 100000, feeVnd: 1000, netAmountVnd: 99000, bankSnapshot: { bankName: 'VCB', bankAccountNumberMasked: '****1234', accountHolderName: 'AUDITOR' }, errorMessage: 'Cần đối soát', createdAt: '2026-08-26T00:00:00.000Z' }] })} />);

    expect(await screen.findByText('Khoản này cần đối soát thủ công, bộ phận vận hành đang xử lý.')).toBeInTheDocument();
    expect(screen.getByText(/VCB · \*\*\*\*1234/)).toBeInTheDocument();
  });

  it('shows the reward withdrawal action only when a reward is claimable', async () => {
    render(<AuditorEarningsPanel isActive fetchAuditorResource={vi.fn().mockResolvedValue({ claimableRewardVnd: 250000, ledgerEntries: [], payouts: [] })} />);

    expect(await screen.findByText(/Bạn có 250.000 VNĐ tiền thưởng đã sẵn sàng rút/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Rút tiền thưởng' })).toBeInTheDocument();
  });

  it('keeps the loading failure visible and allows a retry', async () => {
    const fetchAuditorResource = vi.fn()
      .mockRejectedValueOnce(new Error('network unavailable'))
      .mockResolvedValueOnce({ claimableRewardVnd: 0, ledgerEntries: [], payouts: [] });
    render(<AuditorEarningsPanel isActive fetchAuditorResource={fetchAuditorResource} />);

    expect(await screen.findByText('Không đọc được sổ thưởng phạt. Vui lòng thử lại.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Thử lại' }));
    expect(await screen.findByText('Chưa phát sinh khoản thù lao hoặc phạt nào.')).toBeInTheDocument();
  });
});
