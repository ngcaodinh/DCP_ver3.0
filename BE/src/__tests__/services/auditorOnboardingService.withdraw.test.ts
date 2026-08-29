import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  acquireWithdrawalLock: vi.fn(),
  acquireUnstakeLock: vi.fn(),
  acquirePartialUnstakeLock: vi.fn(),
  acquirePartialWithdrawalLock: vi.fn(),
  cancelPayout: vi.fn(),
  confirmPayout: vi.fn(),
  contract: vi.fn(),
  createKernelClient: vi.fn(),
  createPayout: vi.fn(),
  findPayoutAccount: vi.fn(),
  findLatestIntent: vi.fn(),
  findUserByEmail: vi.fn(),
  findUser: vi.fn(),
  initializeGuard: vi.fn(),
  hasWalletLock: vi.fn(),
  releaseLock: vi.fn(),
  releaseUnstakeLock: vi.fn(),
  sendWithdrawal: vi.fn(),
  stakingContract: vi.fn(),
  stakingProvider: vi.fn(),
  updateIntent: vi.fn(),
  updateUser: vi.fn(),
  verifyGoogleIdToken: vi.fn(),
  loginWithGoogle: vi.fn(),
  evaluateExitEligibility: vi.fn(),
  suspendAuditorRole: vi.fn()
}));

vi.mock('google-auth-library', () => ({
  OAuth2Client: vi.fn().mockImplementation(() => ({ verifyIdToken: mocks.verifyGoogleIdToken }))
}));
vi.mock('../../config/googleAuth', () => ({
  getGoogleAuthConfig: () => ({ clientId: 'google-client-id', tokenIssuers: ['accounts.google.com'] })
}));

vi.mock('ethers', () => ({
  ethers: {
    Contract: mocks.contract,
    getAddress: (address: string) => address,
    isAddress: (address: string) => /^0x[0-9a-fA-F]{40}$/.test(address)
  }
}));

vi.mock('../../config/auditorStakingContract', () => ({
  getReadOnlyAuditorStakingContract: mocks.stakingContract,
  getReadOnlyAuditorStakingProvider: mocks.stakingProvider
}));
vi.mock('../../config/zeroDev', () => ({ getZeroDevConfig: () => ({ entryPointAddress: '0x00000000000000000000000000000000000000e1' }) }));
vi.mock('../../config/logger', () => ({ getLogger: () => ({ error: vi.fn(), warn: vi.fn() }) }));
vi.mock('../../constants/auditorStaking', () => ({ AUDITOR_STAKE_CONFIRMATION_BLOCKS: 1, AUDITOR_STAKE_FAST_PATH_TIMEOUT_MS: 1_000 }));
vi.mock('../../models/auditorPayoutAccountModel', () => ({
  createAuditorPayoutAccount: vi.fn(),
  deleteAuditorPayoutAccountById: vi.fn(),
  findAuditorPayoutAccountByBankIdentity: vi.fn(),
  findAuditorPayoutAccountByUserId: mocks.findPayoutAccount,
  updateAuditorPayoutAccount: vi.fn()
}));
vi.mock('../../models/auditorStakeIntentModel', () => ({
  createAuditorStakeIntent: vi.fn(),
  findAuditorStakeIntentById: vi.fn(),
  findLatestAuditorStakeIntentByUserId: mocks.findLatestIntent,
  updateAuditorStakeIntent: mocks.updateIntent
}));
vi.mock('../../models/authModel', () => ({
  createUser: vi.fn(),
  deleteUserById: vi.fn(),
  findUserByEmail: mocks.findUserByEmail,
  findUserById: mocks.findUser,
  updateUser: mocks.updateUser
}));
vi.mock('../../validators/auditorPayoutAccountValidator', () => ({ resolveAuditorPayoutBankCode: vi.fn() }));
vi.mock('../../services/zeroDevService', () => ({
  createKernelClientFromEncryptedOwnerKey: mocks.createKernelClient,
  createZeroDevSmartAccount: vi.fn()
}));
vi.mock('../../services/auditorRoleActivationService', () => ({ reconcileAuditorStakeForWallet: vi.fn(), suspendAuditorRole: mocks.suspendAuditorRole }));
vi.mock('../../models/auditorPayoutModel', () => ({ cancelAuditorPayout: mocks.cancelPayout }));
vi.mock('../../models/auditorStakeGuardModel', () => ({
  acquireAuditorPayoutAccountUpdateLock: vi.fn(),
  acquireAuditorUnstakeLock: mocks.acquireUnstakeLock,
  acquireAuditorWithdrawalLock: mocks.acquireWithdrawalLock,
  acquireAuditorPartialUnstakeLock: mocks.acquirePartialUnstakeLock,
  acquireAuditorPartialWithdrawalLock: mocks.acquirePartialWithdrawalLock,
  hasAuditorWalletLock: mocks.hasWalletLock,
  initializeAuditorStakeGuard: mocks.initializeGuard,
  releaseAuditorUnstakeLock: mocks.releaseUnstakeLock,
  releaseAuditorWalletLock: mocks.releaseLock
}));
vi.mock('../../services/auditorPayoutCreationService', () => ({
  confirmStakeWithdrawalPayout: mocks.confirmPayout,
  createStakeWithdrawalPayout: mocks.createPayout
}));
vi.mock('../../services/auditorStakeEligibility.service', () => ({
  evaluateAuditorFullExitEligibility: mocks.evaluateExitEligibility
}));
vi.mock('../../services/authService', () => ({ loginWithGoogle: mocks.loginWithGoogle }));

import { requestAuditorUnstake, resumeAuditorIntent, withdrawAuditorStake } from '../../services/auditorOnboardingService';

const WALLET_ADDRESS = '0x00000000000000000000000000000000000000b2';

describe('withdrawAuditorStake', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUser.mockResolvedValue({
      id: 'auditor-1',
      role: 'auditor',
      accountStatus: 'ACTIVE',
      walletAddress: WALLET_ADDRESS,
      smartAccountOwnerEncryptedPrivateKey: 'encrypted-owner-key'
    });
    mocks.findPayoutAccount.mockResolvedValue({ id: 'account-1' });
    mocks.findLatestIntent.mockResolvedValue({
      id: 'intent-1', userId: 'auditor-1', walletAddress: WALLET_ADDRESS, status: 'PENDING_TX', txHash: null, failureReason: null
    });
    mocks.updateIntent.mockResolvedValue(undefined);
    mocks.hasWalletLock.mockResolvedValue(false);
    mocks.initializeGuard.mockResolvedValue(undefined);
    mocks.acquireWithdrawalLock.mockResolvedValue({ walletLock: 'WITHDRAWING' });
    mocks.acquireUnstakeLock.mockResolvedValue({ walletLock: 'UNSTAKING' });
    mocks.acquirePartialUnstakeLock.mockResolvedValue({ walletLock: 'UNSTAKING' });
    mocks.acquirePartialWithdrawalLock.mockResolvedValue({ walletLock: 'WITHDRAWING' });
    mocks.evaluateExitEligibility.mockResolvedValue({ eligible: true, reasons: [] });
    mocks.createPayout.mockResolvedValue({ payoutId: 'payout-1' });
    mocks.confirmPayout.mockResolvedValue({ payoutId: 'payout-1' });
    mocks.cancelPayout.mockResolvedValue(undefined);
    mocks.releaseLock.mockResolvedValue(undefined);
    mocks.releaseUnstakeLock.mockResolvedValue(undefined);
    mocks.sendWithdrawal.mockResolvedValue('0xwithdraw');
    mocks.createKernelClient.mockResolvedValue({ account: { address: WALLET_ADDRESS }, sendTransaction: mocks.sendWithdrawal });
    mocks.stakingContract.mockReturnValue({
      pendingWithdrawAmount: vi.fn().mockResolvedValue(100_000n),
      minimumStakeThreshold: vi.fn().mockResolvedValue(100_000n),
      stakedBalance: vi.fn().mockResolvedValue(0n),
      unbondingPeriodSeconds: vi.fn().mockResolvedValue(604_800n),
      unbondingReleaseAt: vi.fn().mockResolvedValue(0n),
      getAddress: vi.fn().mockResolvedValue('0x00000000000000000000000000000000000000a1'),
      interface: { encodeFunctionData: vi.fn().mockReturnValue('0xcalldata') }
    });
    mocks.stakingProvider.mockReturnValue({ waitForTransaction: vi.fn().mockResolvedValue({ status: 1 }) });
    mocks.contract.mockReturnValue({
      balanceOf: vi.fn().mockResolvedValue(100_000n),
      allowance: vi.fn().mockResolvedValue(0n),
      interface: { encodeFunctionData: vi.fn().mockReturnValue('0xtoken-calldata') }
    });
    process.env.CHARITY_TOKEN_CONTRACT_ADDRESS = '0x00000000000000000000000000000000000000c3';
  });

  it('creates the payout and wallet lock before broadcasting withdrawal, then confirms it after a successful receipt', async () => {
    const result = await withdrawAuditorStake('auditor-1');

    expect(result).toMatchObject({ txHash: '0xwithdraw' });
    expect(mocks.createPayout).toHaveBeenCalledWith(expect.objectContaining({
      auditorUserId: 'auditor-1',
      onchainTxHash: null,
      amount: 100_000n
    }));
    expect(mocks.confirmPayout).toHaveBeenCalledWith('auditor-1', result.payoutId, '0xwithdraw');
    expect(mocks.createPayout.mock.invocationCallOrder[0]).toBeLessThan(mocks.sendWithdrawal.mock.invocationCallOrder[0]);
    expect(mocks.releaseLock).not.toHaveBeenCalled();
  });

  it('cancels the prepared payout and releases only its withdrawal lock when broadcasting fails', async () => {
    mocks.sendWithdrawal.mockRejectedValue(new Error('bundler unavailable'));

    await expect(withdrawAuditorStake('auditor-1')).rejects.toThrow('bundler unavailable');

    expect(mocks.cancelPayout).toHaveBeenCalledWith(expect.any(String), 'bundler unavailable');
    expect(mocks.releaseLock).toHaveBeenCalledWith('auditor-1', expect.any(String), 'WITHDRAWING');
  });

  it('re-checks full exit eligibility before taking the claim lock', async () => {
    mocks.evaluateExitEligibility.mockResolvedValue({ eligible: false, reasons: [{ message: 'Còn tranh chấp mở.' }] });

    await expect(withdrawAuditorStake('auditor-1')).rejects.toMatchObject({ errorCode: 'FULL_EXIT_NOT_ELIGIBLE' });

    expect(mocks.acquireWithdrawalLock).not.toHaveBeenCalled();
    expect(mocks.acquirePartialWithdrawalLock).not.toHaveBeenCalled();
  });

  it('allows a partial claim even when a new full-exit blocker exists', async () => {
    mocks.evaluateExitEligibility.mockResolvedValue({ eligible: false, reasons: [{ message: 'Còn tranh chấp mở.' }] });
    mocks.stakingContract.mockReturnValue({
      pendingWithdrawAmount: vi.fn().mockResolvedValue(100_000n),
      stakedBalance: vi.fn().mockResolvedValue(200_000n),
      getAddress: vi.fn().mockResolvedValue('0x00000000000000000000000000000000000000a1'),
      interface: { encodeFunctionData: vi.fn().mockReturnValue('0xcalldata') }
    });

    await expect(withdrawAuditorStake('auditor-1')).resolves.toMatchObject({ txHash: '0xwithdraw' });

    expect(mocks.evaluateExitEligibility).not.toHaveBeenCalled();
    expect(mocks.acquirePartialWithdrawalLock).toHaveBeenCalledWith('auditor-1', expect.any(String));
  });

  it('keeps a partial claim blocked when the penalty-debt guard cannot acquire its lock', async () => {
    mocks.stakingContract.mockReturnValue({
      pendingWithdrawAmount: vi.fn().mockResolvedValue(100_000n),
      stakedBalance: vi.fn().mockResolvedValue(200_000n),
      getAddress: vi.fn().mockResolvedValue('0x00000000000000000000000000000000000000a1'),
      interface: { encodeFunctionData: vi.fn().mockReturnValue('0xcalldata') }
    });
    mocks.acquirePartialWithdrawalLock.mockResolvedValue(null);

    await expect(withdrawAuditorStake('auditor-1')).rejects.toMatchObject({ errorCode: 'CONFLICT' });

    expect(mocks.sendWithdrawal).not.toHaveBeenCalled();
  });

  describe('requestAuditorUnstake', () => {
    it('rejects a remaining stake strictly between zero and the minimum without locking or broadcasting', async () => {
      mocks.stakingContract.mockReturnValue({
        stakedBalance: vi.fn().mockResolvedValue(1_000_000n),
        minimumStakeThreshold: vi.fn().mockResolvedValue(500_000n),
        unbondingPeriodSeconds: vi.fn().mockResolvedValue(604_800n),
        unbondingReleaseAt: vi.fn().mockResolvedValue(0n),
        getAddress: vi.fn().mockResolvedValue('0x00000000000000000000000000000000000000a1'),
        interface: { encodeFunctionData: vi.fn().mockReturnValue('0xunstake-calldata') }
      });

      await expect(requestAuditorUnstake('auditor-1', 600_000n)).rejects.toMatchObject({ errorCode: 'AMOUNT_BELOW_MINIMUM_FLOOR' });

      expect(mocks.acquireUnstakeLock).not.toHaveBeenCalled();
      expect(mocks.acquirePartialUnstakeLock).not.toHaveBeenCalled();
      expect(mocks.sendWithdrawal).not.toHaveBeenCalled();
    });

    it('rejects a blocked full exit before acquiring its lock', async () => {
      mocks.stakingContract.mockReturnValue({
        stakedBalance: vi.fn().mockResolvedValue(1_000_000n),
        minimumStakeThreshold: vi.fn().mockResolvedValue(500_000n),
        unbondingPeriodSeconds: vi.fn().mockResolvedValue(604_800n),
        unbondingReleaseAt: vi.fn().mockResolvedValue(0n),
        getAddress: vi.fn().mockResolvedValue('0x00000000000000000000000000000000000000a1'),
        interface: { encodeFunctionData: vi.fn().mockReturnValue('0xunstake-calldata') }
      });
      mocks.evaluateExitEligibility.mockResolvedValue({ eligible: false, reasons: [{ message: 'Còn tranh chấp mở.' }] });

      await expect(requestAuditorUnstake('auditor-1', 1_000_000n)).rejects.toMatchObject({ errorCode: 'FULL_EXIT_NOT_ELIGIBLE' });

      expect(mocks.acquireUnstakeLock).not.toHaveBeenCalled();
      expect(mocks.sendWithdrawal).not.toHaveBeenCalled();
    });

    it('allows a partial unstake at the floor despite a full-exit blocker', async () => {
      mocks.stakingContract.mockReturnValue({
        stakedBalance: vi.fn().mockResolvedValue(1_000_000n),
        minimumStakeThreshold: vi.fn().mockResolvedValue(500_000n),
        unbondingPeriodSeconds: vi.fn().mockResolvedValue(604_800n),
        unbondingReleaseAt: vi.fn().mockResolvedValue(1_800_000_000n),
        getAddress: vi.fn().mockResolvedValue('0x00000000000000000000000000000000000000a1'),
        interface: { encodeFunctionData: vi.fn().mockReturnValue('0xunstake-calldata') }
      });
      mocks.evaluateExitEligibility.mockResolvedValue({ eligible: false, reasons: [{ message: 'Còn tranh chấp mở.' }] });
      mocks.sendWithdrawal.mockResolvedValue('0xunstake');

      await expect(requestAuditorUnstake('auditor-1', 500_000n)).resolves.toMatchObject({ txHash: '0xunstake', previousReleaseAt: new Date(1_800_000_000_000) });

      expect(mocks.evaluateExitEligibility).not.toHaveBeenCalled();
      expect(mocks.acquirePartialUnstakeLock).toHaveBeenCalledWith('auditor-1', expect.any(String));
      expect(mocks.sendWithdrawal).toHaveBeenCalled();
    });
  });

  it('allows an active auditor to stake an explicit additional amount above the minimum', async () => {
    mocks.findUser.mockResolvedValue({
      id: 'auditor-1',
      role: 'auditor',
      accountStatus: 'ACTIVE',
      suspendedReasonCode: null,
      walletAddress: WALLET_ADDRESS,
      smartAccountOwnerEncryptedPrivateKey: 'encrypted-owner-key'
    });
    mocks.findLatestIntent.mockResolvedValue(null);
    mocks.stakingContract.mockReturnValue({
      minimumStakeThreshold: vi.fn().mockResolvedValue(3_000_000n),
      stakedBalance: vi.fn().mockResolvedValue(3_000_000n),
      getAddress: vi.fn().mockResolvedValue('0x00000000000000000000000000000000000000a1'),
      interface: { encodeFunctionData: vi.fn().mockReturnValue('0xadditional-stake-calldata') }
    });
    const encodeTokenFunctionData = vi.fn().mockReturnValue('0xadditional-approve-calldata');
    mocks.contract.mockReturnValue({
      balanceOf: vi.fn().mockResolvedValue(25_000n),
      allowance: vi.fn().mockResolvedValue(0n),
      interface: { encodeFunctionData: encodeTokenFunctionData }
    });
    mocks.sendWithdrawal.mockResolvedValue('0xadditional-stake');

    const { executeAuditorStake } = await import('../../services/auditorOnboardingService');
    await expect(executeAuditorStake('auditor-1', 25_000n)).resolves.toEqual({ status: 'VERIFYING', txHash: '0xadditional-stake' });

    expect(encodeTokenFunctionData).toHaveBeenCalledWith('approve', ['0x00000000000000000000000000000000000000a1', 25_000n]);
    expect(mocks.sendWithdrawal).toHaveBeenCalledWith(expect.objectContaining({
      calls: expect.arrayContaining([expect.objectContaining({ data: '0xadditional-stake-calldata' })])
    }));
    expect(mocks.updateIntent).not.toHaveBeenCalled();
  });

  it('rejects an active auditor explicit stake when the wallet token balance is insufficient', async () => {
    mocks.findUser.mockResolvedValue({
      id: 'auditor-1',
      role: 'auditor',
      accountStatus: 'ACTIVE',
      suspendedReasonCode: null,
      walletAddress: WALLET_ADDRESS,
      smartAccountOwnerEncryptedPrivateKey: 'encrypted-owner-key'
    });
    mocks.findLatestIntent.mockResolvedValue(null);
    mocks.stakingContract.mockReturnValue({
      minimumStakeThreshold: vi.fn().mockResolvedValue(3_000_000n),
      stakedBalance: vi.fn().mockResolvedValue(3_000_000n),
      getAddress: vi.fn().mockResolvedValue('0x00000000000000000000000000000000000000a1'),
      interface: { encodeFunctionData: vi.fn().mockReturnValue('0xunused') }
    });
    mocks.contract.mockReturnValue({
      balanceOf: vi.fn().mockResolvedValue(25_000n),
      allowance: vi.fn().mockResolvedValue(0n),
      interface: { encodeFunctionData: vi.fn().mockReturnValue('0xunused') }
    });

    const { executeAuditorStake } = await import('../../services/auditorOnboardingService');
    await expect(executeAuditorStake('auditor-1', 30_000n)).rejects.toMatchObject({ errorCode: 'INSUFFICIENT_TOKEN_BALANCE' });
    expect(mocks.sendWithdrawal).not.toHaveBeenCalled();
  });

  it('stakes only the shortfall and persists the submitted transaction for later projection', async () => {
    mocks.findUser.mockResolvedValue({
      id: 'auditor-1',
      accountStatus: 'PENDING_STAKE_VERIFICATION',
      suspendedReasonCode: null,
      walletAddress: WALLET_ADDRESS,
      smartAccountOwnerEncryptedPrivateKey: 'encrypted-owner-key'
    });
    mocks.stakingContract.mockReturnValue({
      minimumStakeThreshold: vi.fn().mockResolvedValue(100_000n),
      stakedBalance: vi.fn().mockResolvedValue(40_000n),
      getAddress: vi.fn().mockResolvedValue('0x00000000000000000000000000000000000000a1'),
      interface: { encodeFunctionData: vi.fn().mockReturnValue('0xstake-calldata') }
    });
    const encodeTokenFunctionData = vi.fn().mockReturnValue('0xapprove-calldata');
    mocks.contract.mockReturnValue({
      balanceOf: vi.fn().mockResolvedValue(60_000n),
      allowance: vi.fn().mockResolvedValue(0n),
      interface: { encodeFunctionData: encodeTokenFunctionData }
    });
    mocks.sendWithdrawal.mockResolvedValue('0xstake');

    const { executeAuditorStake } = await import('../../services/auditorOnboardingService');
    await expect(executeAuditorStake('auditor-1')).resolves.toEqual({ status: 'VERIFYING', txHash: '0xstake' });

    expect(mocks.sendWithdrawal).toHaveBeenCalledWith(expect.objectContaining({
      calls: expect.arrayContaining([expect.objectContaining({ data: '0xstake-calldata' })])
    }));
    expect(encodeTokenFunctionData).toHaveBeenCalledWith(
      'approve',
      ['0x00000000000000000000000000000000000000a1', 60_000n]
    );
    expect(mocks.updateIntent).toHaveBeenCalledWith(expect.objectContaining({ status: 'VERIFYING', txHash: '0xstake' }));
  });

  it('trả lỗi policy tài trợ gas khi nguyên nhân nằm trong lỗi RPC lồng nhau', async () => {
    mocks.findUser.mockResolvedValue({
      id: 'auditor-1',
      accountStatus: 'PENDING_STAKE_VERIFICATION',
      suspendedReasonCode: null,
      walletAddress: WALLET_ADDRESS,
      smartAccountOwnerEncryptedPrivateKey: 'encrypted-owner-key'
    });
    mocks.sendWithdrawal.mockRejectedValue({
      message: 'UserOperation submission failed.',
      cause: { details: 'did not match any gas sponsoring policies' }
    });

    const { executeAuditorStake } = await import('../../services/auditorOnboardingService');
    await expect(executeAuditorStake('auditor-1')).rejects.toMatchObject({
      errorCode: 'PAYMASTER_POLICY_MISMATCH'
    });
  });

  it.each(['PENDING_TX', 'FAILED'] as const)('khôi phục intent %s chỉ khi Google subject khớp với hồ sơ Auditor đã lưu', async (intentStatus) => {
    mocks.findUserByEmail.mockResolvedValue({
      id: 'auditor-1',
      role: 'donor',
      accountStatus: 'PENDING_STAKE_VERIFICATION',
      socialProvider: 'google',
      socialAccountId: 'google-subject-1',
      walletAddress: WALLET_ADDRESS
    });
    mocks.findLatestIntent.mockResolvedValue({
      id: 'intent-1', userId: 'auditor-1', walletAddress: WALLET_ADDRESS, status: intentStatus, txHash: null, failureReason: null
    });
    mocks.verifyGoogleIdToken.mockResolvedValue({
      getPayload: () => ({ email: 'auditor@example.com', sub: 'google-subject-1', iss: 'accounts.google.com' })
    });
    mocks.loginWithGoogle.mockResolvedValue({
      accessToken: 'access-token', refreshToken: 'refresh-token', csrfToken: 'csrf-token', refreshSessionId: 'session-1',
      expiresAt: new Date('2026-08-25T00:00:00.000Z'), correlationId: 'correlation-1'
    });
    mocks.stakingContract.mockReturnValue({ minimumStakeThreshold: vi.fn().mockResolvedValue(3_000_000n) });
    mocks.contract.mockReturnValue({ balanceOf: vi.fn().mockResolvedValue(1_000_000n) });

    await expect(resumeAuditorIntent({
      identityToken: 'google-identity-token', ipAddress: '127.0.0.1', userAgent: 'vitest'
    })).resolves.toMatchObject({
      intentId: 'intent-1', minimumStakeThreshold: '3000000', currentTokenBalance: '1000000', walletAddress: WALLET_ADDRESS,
      accessToken: 'access-token'
    });
    expect(mocks.loginWithGoogle).toHaveBeenCalledWith('google-identity-token', 'donor', '127.0.0.1', 'vitest');
  });

  it('không khôi phục intent khi Google subject không khớp dù email trùng nhau', async () => {
    mocks.findUserByEmail.mockResolvedValue({
      id: 'auditor-1',
      role: 'donor',
      accountStatus: 'PENDING_STAKE_VERIFICATION',
      socialProvider: 'google',
      socialAccountId: 'google-subject-khac',
      walletAddress: WALLET_ADDRESS
    });
    mocks.verifyGoogleIdToken.mockResolvedValue({
      getPayload: () => ({ email: 'auditor@example.com', sub: 'google-subject-1', iss: 'accounts.google.com' })
    });

    await expect(resumeAuditorIntent({
      identityToken: 'google-identity-token', ipAddress: '127.0.0.1', userAgent: 'vitest'
    })).rejects.toMatchObject({ errorCode: 'AUDITOR_ONBOARDING_NOT_FOUND' });
    expect(mocks.loginWithGoogle).not.toHaveBeenCalled();
  });

  it.each([
    ['không có hồ sơ theo email', null, null, 'AUDITOR_ONBOARDING_NOT_FOUND'],
    ['Auditor đã hoạt động', {
      id: 'auditor-1', role: 'auditor', accountStatus: 'ACTIVE', socialProvider: 'google', socialAccountId: 'google-subject-1', walletAddress: WALLET_ADDRESS
    }, null, 'ALREADY_AUDITOR'],
    ['tài khoản donor đang hoạt động', {
      id: 'donor-1', role: 'donor', accountStatus: 'ACTIVE', socialProvider: 'google', socialAccountId: 'google-subject-1', walletAddress: WALLET_ADDRESS
    }, null, 'AUDITOR_ONBOARDING_NOT_FOUND'],
    ['hồ sơ không còn ở trạng thái chờ cọc', {
      id: 'auditor-1', role: 'donor', accountStatus: 'SUSPENDED', socialProvider: 'google', socialAccountId: 'google-subject-1', walletAddress: WALLET_ADDRESS
    }, null, 'ONBOARDING_RESUME_UNAVAILABLE'],
    ['thiếu intent đặt cọc', {
      id: 'auditor-1', role: 'donor', accountStatus: 'PENDING_STAKE_VERIFICATION', socialProvider: 'google', socialAccountId: 'google-subject-1', walletAddress: WALLET_ADDRESS
    }, null, 'ONBOARDING_RESUME_UNAVAILABLE'],
    ['intent đã kích hoạt', {
      id: 'auditor-1', role: 'donor', accountStatus: 'PENDING_STAKE_VERIFICATION', socialProvider: 'google', socialAccountId: 'google-subject-1', walletAddress: WALLET_ADDRESS
    }, { id: 'intent-1', status: 'ACTIVATED' }, 'ALREADY_AUDITOR'],
    ['intent đang xác minh on-chain', {
      id: 'auditor-1', role: 'donor', accountStatus: 'PENDING_STAKE_VERIFICATION', socialProvider: 'google', socialAccountId: 'google-subject-1', walletAddress: WALLET_ADDRESS
    }, { id: 'intent-1', status: 'VERIFYING' }, 'ALREADY_SUBMITTED']
  ])('từ chối khôi phục khi %s', async (_scenario, user, intent, expectedErrorCode) => {
    mocks.verifyGoogleIdToken.mockResolvedValue({
      getPayload: () => ({ email: 'auditor@example.com', sub: 'google-subject-1', iss: 'accounts.google.com' })
    });
    mocks.findUserByEmail.mockResolvedValue(user);
    mocks.findLatestIntent.mockResolvedValue(intent);

    await expect(resumeAuditorIntent({
      identityToken: 'google-identity-token', ipAddress: '127.0.0.1', userAgent: 'vitest'
    })).rejects.toMatchObject({ errorCode: expectedErrorCode });
    expect(mocks.loginWithGoogle).not.toHaveBeenCalled();
  });
});
