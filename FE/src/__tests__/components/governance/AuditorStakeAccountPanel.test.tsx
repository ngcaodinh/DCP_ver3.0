import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  createAuditorPortalDeposit: vi.fn(),
  getAuditorEarnings: vi.fn(),
  getAuditorPortalDepositStatus: vi.fn(),
  getAuditorWalletTokenBalance: vi.fn(),
  executeAuditorStake: vi.fn(),
  requestAuditorUnstake: vi.fn(),
  withdrawAuditorStake: vi.fn(),
  updateAuditorPayoutAccount: vi.fn(),
}));

vi.mock('@/app/utils/authSession', () => ({ readAuthSession: () => ({ accessToken: 'auditor-token' }) }));
vi.mock('@/app/utils/auditorOnboarding', () => ({
  executeAuditorStake: mocks.executeAuditorStake,
  requestAuditorUnstake: mocks.requestAuditorUnstake,
  withdrawAuditorStake: mocks.withdrawAuditorStake,
}));
vi.mock('@/app/utils/auditorPortalApi', () => ({
  createAuditorPortalDeposit: mocks.createAuditorPortalDeposit,
  getAuditorEarnings: mocks.getAuditorEarnings,
  getAuditorPortalDepositStatus: mocks.getAuditorPortalDepositStatus,
  getAuditorWalletTokenBalance: mocks.getAuditorWalletTokenBalance,
  updateAuditorPayoutAccount: mocks.updateAuditorPayoutAccount,
}));

import AuditorStakeAccountPanel from '@/app/components/governance/AuditorStakeAccountPanel';

const baseOverview = {
  onchain: { stakedBalance: '1000000000000000000', minimumStakeThreshold: '500000000000000000', pendingWithdrawAmount: '0', unbondingReleaseAt: null, unbondingPeriodSeconds: '604800' },
  onchainError: null,
  guard: { walletLock: 'UNSTAKING' as const, lockedAt: '2026-08-26T00:00:00.000Z', penaltyDebtVnd: 0, openCaseCount: 0 },
  payoutAccount: null,
  accountStatus: 'ACTIVE',
  suspendedReasonCode: null,
  exitEligibility: { eligible: true, reasons: [] },
};

describe('AuditorStakeAccountPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState({}, '', '/auditor');
    window.localStorage.clear();
    mocks.getAuditorWalletTokenBalance.mockResolvedValue('0');
    mocks.executeAuditorStake.mockResolvedValue({ status: 'VERIFYING', txHash: '0xstake' });
    mocks.requestAuditorUnstake.mockResolvedValue({ txHash: '0xunstake', releaseAt: '2026-09-02T00:00:00.000Z', previousReleaseAt: null });
    mocks.withdrawAuditorStake.mockResolvedValue({ txHash: '0xwithdraw', payoutId: 'payout-1' });
    mocks.getAuditorEarnings.mockResolvedValue({ claimableRewardVnd: 0, ledgerEntries: [], payouts: [] });
  });

  it('keeps deposit and withdrawal actions disabled while the wallet is locked', async () => {
    const underStakeOverview = { ...baseOverview, onchain: { ...baseOverview.onchain, stakedBalance: '0', minimumStakeThreshold: '50000' } };
    render(<AuditorStakeAccountPanel isActive fetchAuditorResource={vi.fn().mockResolvedValue(underStakeOverview)} />);

    expect(await screen.findByText(/Đang xử lý yêu cầu rút cọc/i)).toBeInTheDocument();
    fireEvent.change(await screen.findByRole('textbox', { name: /Số tiền muốn cọc thêm/ }), { target: { value: '50000' } });
    expect(await screen.findByRole('button', { name: 'Nạp 50.000 VNĐ' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Yêu cầu rút tiền' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Rút tiền ngay về ngân hàng' })).toBeDisabled();
  });

  it('creates a PayOS top-up for the full selected amount instead of subtracting the Smart Account balance', async () => {
    const overview = { ...baseOverview, guard: { ...baseOverview.guard, walletLock: null }, onchain: { ...baseOverview.onchain, stakedBalance: '20000', minimumStakeThreshold: '50000' } };
    mocks.getAuditorWalletTokenBalance.mockResolvedValue('2000');
    mocks.createAuditorPortalDeposit.mockResolvedValue({ orderCode: '1787650889515545', paymentUrl: 'https://pay.example/checkout', status: 'PENDING_PAYMENT' });
    const openPayment = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(<AuditorStakeAccountPanel isActive fetchAuditorResource={vi.fn().mockResolvedValue(overview)} />);
    fireEvent.change(await screen.findByRole('textbox', { name: /Số tiền muốn cọc thêm/ }), { target: { value: '12000' } });
    await screen.findByText((_content, element) => element?.tagName === 'P'
      && element.textContent?.includes('Cần nạp thêm 12.000 VNĐ') === true);
    fireEvent.click(await screen.findByRole('button', { name: 'Nạp 12.000 VNĐ' }));

    await waitFor(() => expect(mocks.createAuditorPortalDeposit).toHaveBeenCalledWith('auditor-token', 12_000));
    expect(openPayment).toHaveBeenCalledWith('https://pay.example/checkout', '_blank', 'noopener,noreferrer');
    expect(await screen.findByText('Đang chờ thanh toán')).toBeInTheDocument();
    openPayment.mockRestore();
  });

  it('raises only deposits below 10,000 VND to the PayOS minimum', async () => {
    const overview = { ...baseOverview, guard: { ...baseOverview.guard, walletLock: null }, onchain: { ...baseOverview.onchain, stakedBalance: '20000', minimumStakeThreshold: '50000' } };
    mocks.getAuditorWalletTokenBalance.mockResolvedValue('2000');
    mocks.createAuditorPortalDeposit.mockResolvedValue({ orderCode: '1787650889515545', paymentUrl: 'https://pay.example/checkout', status: 'PENDING_PAYMENT' });
    const openPayment = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(<AuditorStakeAccountPanel isActive fetchAuditorResource={vi.fn().mockResolvedValue(overview)} />);

    fireEvent.change(await screen.findByRole('textbox', { name: /Số tiền muốn cọc thêm/ }), { target: { value: '8000' } });
    await screen.findByRole('button', { name: 'Nạp 10.000 VNĐ' });
    fireEvent.click(screen.getByRole('button', { name: 'Nạp 10.000 VNĐ' }));

    await waitFor(() => expect(mocks.createAuditorPortalDeposit).toHaveBeenCalledWith('auditor-token', 10_000));
    openPayment.mockRestore();
  });

  it('refreshes the displayed staked balance immediately after the on-chain stake is confirmed', async () => {
    const orderCode = '1787750507904741';
    const overview = { ...baseOverview, guard: { ...baseOverview.guard, walletLock: null }, onchain: { ...baseOverview.onchain, stakedBalance: '3000000', minimumStakeThreshold: '3000000' } };
    const updatedOverview = { ...overview, onchain: { ...overview.onchain, stakedBalance: '3012000' } };
    const fetchAuditorResource = vi.fn()
      .mockResolvedValueOnce(overview)
      .mockResolvedValueOnce(overview)
      .mockResolvedValue(updatedOverview);
    mocks.getAuditorWalletTokenBalance.mockResolvedValue('3012000');
    mocks.getAuditorPortalDepositStatus.mockResolvedValue({ status: 'MINT_COMPLETED' });
    window.localStorage.setItem(`auditorStakeDeposit:${orderCode}`, '12000');
    window.history.replaceState({}, '', `/auditor?paymentFlow=auditor_portal&orderCode=${orderCode}`);

    render(<AuditorStakeAccountPanel isActive fetchAuditorResource={fetchAuditorResource} />);

    await waitFor(() => expect(mocks.getAuditorPortalDepositStatus).toHaveBeenCalledWith('auditor-token', orderCode));
    await waitFor(() => expect(mocks.executeAuditorStake).toHaveBeenCalledWith('auditor-token', '12000'));
    expect(window.localStorage.getItem(`auditorStakeDeposit:${orderCode}`)).toBeNull();
    expect(await screen.findByText('3.012.000 VNĐ', {}, { timeout: 3_000 })).toBeInTheDocument();
  });

  it('allows an active auditor to stake an explicit additional amount after reaching the floor', async () => {
    const overview = { ...baseOverview, guard: { ...baseOverview.guard, walletLock: null } };
    mocks.getAuditorWalletTokenBalance.mockResolvedValue('100000');
    render(<AuditorStakeAccountPanel isActive fetchAuditorResource={vi.fn().mockResolvedValue(overview)} />);

    fireEvent.change(await screen.findByRole('textbox', { name: /Số tiền muốn cọc thêm/ }), { target: { value: '25000' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Đặt cọc thêm 25.000 VNĐ' }));
    await waitFor(() => expect(mocks.executeAuditorStake).toHaveBeenCalledWith('auditor-token', '25000'));
  });

  it('submits a partial unstake request from the restored withdrawal card', async () => {
    const overview = { ...baseOverview, guard: { ...baseOverview.guard, walletLock: null } };
    render(<AuditorStakeAccountPanel isActive fetchAuditorResource={vi.fn().mockResolvedValue(overview)} />);

    fireEvent.change(await screen.findByRole('textbox', { name: /Số tiền muốn rút/ }), { target: { value: '100000000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Yêu cầu rút tiền' }));
    await waitFor(() => expect(mocks.requestAuditorUnstake).toHaveBeenCalledWith('auditor-token', '100000000'));
  });

  it('enables and submits withdrawal when the unbonding period has elapsed', async () => {
    const overview = { ...baseOverview, guard: { ...baseOverview.guard, walletLock: null }, onchain: { ...baseOverview.onchain, pendingWithdrawAmount: '100000', unbondingReleaseAt: '2020-01-01T00:00:00.000Z' } };
    render(<AuditorStakeAccountPanel isActive fetchAuditorResource={vi.fn().mockResolvedValue(overview)} />);

    const withdrawButton = await screen.findByRole('button', { name: 'Rút tiền ngay về ngân hàng' });
    expect(withdrawButton).toBeEnabled();
    fireEvent.click(withdrawButton);
    await waitFor(() => expect(mocks.withdrawAuditorStake).toHaveBeenCalledWith('auditor-token'));
  });

  it('shows a PayOS transfer dialog and confirms success for the payout created by the withdrawal', async () => {
    const overview = {
      ...baseOverview,
      guard: { ...baseOverview.guard, walletLock: null },
      onchain: { ...baseOverview.onchain, pendingWithdrawAmount: '100000', unbondingReleaseAt: '2020-01-01T00:00:00.000Z' }
    };
    mocks.getAuditorEarnings.mockResolvedValue({
      claimableRewardVnd: 0,
      ledgerEntries: [],
      payouts: [{
        payoutId: 'payout-1', payoutType: 'STAKE_WITHDRAWAL', status: 'BURNED', amountVnd: 100000,
        feeVnd: 5000, netAmountVnd: 95000,
        bankSnapshot: { bankName: 'MB', bankAccountNumberMasked: '****1234', accountHolderName: 'NGUYEN VAN A' },
        errorMessage: null, createdAt: '2026-08-26T00:00:00.000Z'
      }]
    });
    const settledOverview = {
      ...overview,
      onchain: { ...overview.onchain, stakedBalance: '0', pendingWithdrawAmount: '0', unbondingReleaseAt: null }
    };
    const fetchAuditorResource = vi.fn()
      .mockResolvedValueOnce(overview)
      .mockResolvedValueOnce(overview)
      .mockResolvedValue(settledOverview);
    render(<AuditorStakeAccountPanel isActive fetchAuditorResource={fetchAuditorResource} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Rút tiền ngay về ngân hàng' }));

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(await screen.findByText('Chuyển tiền thành công')).toBeInTheDocument();
    expect(screen.getByText('Số tiền chuyển:', { exact: false })).toHaveTextContent('95.000 VNĐ');
    await waitFor(() => expect(screen.getByText('Số tiền đang cọc').parentElement).toHaveTextContent('0 VNĐ'));
    expect(screen.getByRole('button', { name: 'Đóng' })).toBeEnabled();
  });

  it('keeps the PayOS transfer dialog in progress while the payout is still pending', async () => {
    const overview = {
      ...baseOverview,
      guard: { ...baseOverview.guard, walletLock: null },
      onchain: { ...baseOverview.onchain, pendingWithdrawAmount: '100000', unbondingReleaseAt: '2020-01-01T00:00:00.000Z' }
    };
    mocks.getAuditorEarnings.mockResolvedValue({
      claimableRewardVnd: 0,
      ledgerEntries: [],
      payouts: [{
        payoutId: 'payout-1', payoutType: 'STAKE_WITHDRAWAL', status: 'TRANSFERRING', amountVnd: 100000,
        feeVnd: 5000, netAmountVnd: 95000,
        bankSnapshot: { bankName: 'MB', bankAccountNumberMasked: '****1234', accountHolderName: 'NGUYEN VAN A' },
        errorMessage: null, createdAt: '2026-08-26T00:00:00.000Z'
      }]
    });
    render(<AuditorStakeAccountPanel isActive fetchAuditorResource={vi.fn().mockResolvedValue(overview)} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Rút tiền ngay về ngân hàng' }));

    expect(await screen.findByText('Đang thực hiện chuyển tiền')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Đóng' })).not.toBeInTheDocument();
  });

  it('waits for the token burn confirmation after PayOS has transferred the money', async () => {
    const overview = {
      ...baseOverview,
      guard: { ...baseOverview.guard, walletLock: null },
      onchain: { ...baseOverview.onchain, pendingWithdrawAmount: '100000', unbondingReleaseAt: '2020-01-01T00:00:00.000Z' }
    };
    mocks.getAuditorEarnings.mockResolvedValue({
      claimableRewardVnd: 0,
      ledgerEntries: [],
      payouts: [{
        payoutId: 'payout-1', payoutType: 'STAKE_WITHDRAWAL', status: 'TRANSFERRED', amountVnd: 100000,
        feeVnd: 5000, netAmountVnd: 95000,
        bankSnapshot: { bankName: 'MB', bankAccountNumberMasked: '****1234', accountHolderName: 'NGUYEN VAN A' },
        errorMessage: null, createdAt: '2026-08-26T00:00:00.000Z'
      }]
    });
    render(<AuditorStakeAccountPanel isActive fetchAuditorResource={vi.fn().mockResolvedValue(overview)} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Rút tiền ngay về ngân hàng' }));

    expect(await screen.findByText('Đang cập nhật số dư')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Đóng' })).not.toBeInTheDocument();
  });

  it('shows the provider failure reason when PayOS cannot complete the payout', async () => {
    const overview = {
      ...baseOverview,
      guard: { ...baseOverview.guard, walletLock: null },
      onchain: { ...baseOverview.onchain, pendingWithdrawAmount: '100000', unbondingReleaseAt: '2020-01-01T00:00:00.000Z' }
    };
    mocks.getAuditorEarnings.mockResolvedValue({
      claimableRewardVnd: 0,
      ledgerEntries: [],
      payouts: [{
        payoutId: 'payout-1', payoutType: 'STAKE_WITHDRAWAL', status: 'FAILED', amountVnd: 100000,
        feeVnd: 5000, netAmountVnd: 95000,
        bankSnapshot: { bankName: 'MB', bankAccountNumberMasked: '****1234', accountHolderName: 'NGUYEN VAN A' },
        errorMessage: 'PayOS từ chối giao dịch chi trả.', createdAt: '2026-08-26T00:00:00.000Z'
      }]
    });
    render(<AuditorStakeAccountPanel isActive fetchAuditorResource={vi.fn().mockResolvedValue(overview)} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Rút tiền ngay về ngân hàng' }));

    expect(await screen.findByText('Chuyển tiền cần xử lý thêm')).toBeInTheDocument();
    expect(screen.getByText('PayOS từ chối giao dịch chi trả.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Đóng' })).toBeEnabled();
  });

  it('shows four blockchain-unavailable summaries instead of misleading zero balances', async () => {
    const unavailableOverview = { ...baseOverview, onchain: null, onchainError: 'BLOCKCHAIN_UNAVAILABLE', guard: { ...baseOverview.guard, walletLock: null } };
    render(<AuditorStakeAccountPanel isActive fetchAuditorResource={vi.fn().mockResolvedValue(unavailableOverview)} />);

    expect(await screen.findAllByText('Không đọc được từ hệ thống')).toHaveLength(4);
    expect(screen.queryByText('0 DCT')).not.toBeInTheDocument();
  });

  it('renders the on-chain stake balance as a Vietnamese currency amount', async () => {
    const overview = { ...baseOverview, onchain: { ...baseOverview.onchain, stakedBalance: '3000000' }, guard: { ...baseOverview.guard, walletLock: null } };
    render(<AuditorStakeAccountPanel isActive fetchAuditorResource={vi.fn().mockResolvedValue(overview)} />);
    expect(await screen.findByText('3.000.000 VNĐ')).toBeInTheDocument();
    expect(screen.queryByText('Số tiền cọc đang có')).not.toBeInTheDocument();
  });

  it('keeps payout inputs hidden until the user starts an account update', async () => {
    const overview = { ...baseOverview, guard: { ...baseOverview.guard, walletLock: null }, payoutAccount: { bankName: 'MB', bankAccountNumberMasked: '****0325', accountHolderName: 'NGUYEN CAO DINH', branchName: 'Hà Nội' } };
    render(<AuditorStakeAccountPanel isActive fetchAuditorResource={vi.fn().mockResolvedValue(overview)} />);

    expect(await screen.findByText(/Tài khoản đang dùng:/)).toBeInTheDocument();
    const payoutSummary = screen.getByText(/Tài khoản đang dùng:/).parentElement;
    expect(payoutSummary).toHaveTextContent('****0325');
    expect(payoutSummary).not.toHaveTextContent('0367400325');
    expect(payoutSummary).toHaveTextContent('NGUYEN CAO DINH');
    expect(screen.queryByPlaceholderText('Nhập đầy đủ số tài khoản mới')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Cập nhật' }));
    expect(screen.getByPlaceholderText('Nhập đầy đủ số tài khoản mới')).toBeInTheDocument();
    expect(screen.getByDisplayValue('MB')).toBeInTheDocument();
    expect(screen.getByDisplayValue('NGUYEN CAO DINH')).toBeInTheDocument();
  });
});
