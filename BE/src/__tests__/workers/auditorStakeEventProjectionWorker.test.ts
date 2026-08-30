import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  clearFailure: vi.fn(),
  confirmPayout: vi.fn(),
  createPayout: vi.fn(),
  findCheckpoint: vi.fn(),
  findDebtSettlement: vi.fn(),
  findPayoutByHash: vi.fn(),
  findStakeGuard: vi.fn(),
  findUserByWallet: vi.fn(),
  fallbackGetLogs: vi.fn(),
  fallbackGetNetwork: vi.fn(),
  getFallbackProvider: vi.fn(),
  getLogs: vi.fn(),
  linkPayout: vi.fn(),
  loggerError: vi.fn(),
  loggerWarn: vi.fn(),
  markDeadLetter: vi.fn(),
  recordFailure: vi.fn(),
  reconcileStake: vi.fn(),
  saveCheckpoint: vi.fn()
}));

const CONTRACT_ADDRESS = '0x00000000000000000000000000000000000000a1';
const STAKER_TOPIC = `0x${'0'.repeat(24)}00000000000000000000000000000000000000b2`;
const WITHDRAWAL_HASH = `0x${'c'.repeat(64)}`;

/** Tạo lỗi ethers bọc RPC code 19 giống phản hồi tạm thời của eth_getLogs trên production. */
function createTemporaryGetLogsError(): Error & { error: { code: number; message: string } } {
  return Object.assign(
    new Error('could not coalesce error'),
    { error: { code: 19, message: 'Temporary internal error. Please retry.' } }
  );
}

/** Tạo HTTP 500 có responseBody tạm thời giống shape ethers phát sinh từ RPC production. */
function createTemporaryServerResponseError(): Error & { info: { responseBody: string } } {
  return Object.assign(
    new Error('server response 500 Internal Server Error'),
    { info: { responseBody: '{"error":{"message":"Temporary internal error. Please retry"}}' } }
  );
}

/** Tạo fallback provider cùng hoặc khác chain để kiểm tra worker không đọc nhầm blockchain. */
function createFallbackProvider(chainId = 31_337n) {
  return {
    getNetwork: mocks.fallbackGetNetwork.mockResolvedValue({ chainId }),
    getLogs: mocks.fallbackGetLogs
  };
}

vi.mock('../../config/auditorStakingContract', () => ({
  getAuditorStakingContractAddressLowercase: () => CONTRACT_ADDRESS,
  getReadOnlyAuditorStakingContract: () => ({
    interface: {
      getEvent: () => ({ topicHash: '0xevent-topic' }),
      parseLog: () => ({ name: 'Withdrawn', args: { amount: 100_000n } })
    }
  }),
  getReadOnlyAuditorStakingProvider: () => ({
    getNetwork: vi.fn().mockResolvedValue({ chainId: 31_337n }),
    getBlockNumber: vi.fn().mockResolvedValue(2),
    getLogs: mocks.getLogs
  }),
  getReadOnlyAuditorStakingFallbackProvider: mocks.getFallbackProvider,
  logAuditorStakingSignerAddressOnce: vi.fn()
}));
vi.mock('../../config/logger', () => ({ getLogger: () => ({ error: mocks.loggerError, warn: mocks.loggerWarn }) }));
vi.mock('../../config/requestContext', () => ({ runWithWorkerContext: async (_name: string, callback: () => Promise<void>) => callback() }));
vi.mock('../../constants/auditorStaking', () => ({
  AUDITOR_STAKE_CONFIRMATION_BLOCKS: 0,
  AUDITOR_STAKE_INTENT_TIMEOUT_MS: 86_400_000,
  AUDITOR_STAKE_MAX_BLOCKS_PER_REQUEST: 100,
  AUDITOR_STAKE_POLL_INTERVAL_MS: 15_000,
  AUDITOR_STAKE_TIMEOUT_SWEEP_INTERVAL_MS: 60_000
}));
vi.mock('../../models/auditorStakeEventCheckpointModel', () => ({
  findAuditorStakeEventCheckpoint: mocks.findCheckpoint,
  saveAuditorStakeEventCheckpoint: mocks.saveCheckpoint
}));
vi.mock('../../models/auditorStakeEventDeadLetterModel', () => ({
  clearAuditorStakeEventProjectionFailure: mocks.clearFailure,
  markAuditorStakeEventAsDeadLetter: mocks.markDeadLetter,
  recordAuditorStakeEventProjectionFailure: mocks.recordFailure
}));
vi.mock('../../models/auditorDebtSettlementModel', () => ({ findAuditorDebtSettlementById: mocks.findDebtSettlement }));
vi.mock('../../models/auditorStakeIntentModel', () => ({ findExpiredAuditorStakeIntents: vi.fn(), updateAuditorStakeIntent: vi.fn() }));
vi.mock('../../models/authModel', () => ({ findUserById: vi.fn(), findUserByWalletAddress: mocks.findUserByWallet }));
vi.mock('../../models/auditorStakeGuardModel', () => ({ findAuditorStakeGuardByUserId: mocks.findStakeGuard, releaseAuditorUnstakeLock: vi.fn() }));
vi.mock('../../models/auditorPayoutModel', () => ({
  findAuditorPayoutByOnchainTxHash: mocks.findPayoutByHash,
  linkAuditorPayoutToOnchainWithdrawal: mocks.linkPayout
}));
vi.mock('../../services/auditorRoleActivationService', () => ({ reconcileAuditorStakeForWallet: mocks.reconcileStake, suspendAuditorRole: vi.fn() }));
vi.mock('../../services/auditorPayoutCreationService', () => ({
  confirmStakeWithdrawalPayout: mocks.confirmPayout,
  createStakeWithdrawalPayout: mocks.createPayout
}));
vi.mock('../../utils/sanitizeProviderError', () => ({ sanitizeProviderError: (error: unknown) => error instanceof Error ? error.message : 'UNKNOWN_ERROR' }));
vi.mock('../../utils/withRpcTimeout', () => ({ withRpcTimeout: <T>(promise: Promise<T>) => promise }));

import {
  __auditorStakeEventProjectionWorkerTestHooks,
  __resetAuditorStakeEventProjectionWorkerState
} from '../../workers/auditorStakeEventProjectionWorker';

/** Tạo Withdrawn log có topic staker hợp lệ để test projector chạy cùng đường parse production. */
function createWithdrawalLog() {
  return {
    blockNumber: 1,
    index: 0,
    topics: ['0xevent-topic', STAKER_TOPIC],
    data: '0x',
    transactionHash: WITHDRAWAL_HASH
  };
}

describe('auditor stake event projection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getLogs.mockResolvedValue([createWithdrawalLog()]);
    mocks.getFallbackProvider.mockReturnValue(null);
    mocks.findCheckpoint.mockResolvedValue({
      chainId: '31337', contractAddress: CONTRACT_ADDRESS, lastProcessedBlock: 1, lastProcessedLogIndex: -1
    });
    mocks.clearFailure.mockResolvedValue(undefined);
    mocks.findPayoutByHash.mockResolvedValue(null);
    mocks.findStakeGuard.mockResolvedValue({ walletLock: 'DEBT_SETTLING', lockRefId: 'settlement-1' });
    mocks.findDebtSettlement.mockResolvedValue({ payoutId: 'payout-1' });
    mocks.linkPayout.mockResolvedValue({ payoutId: 'payout-1', onchainTxHash: WITHDRAWAL_HASH });
    mocks.reconcileStake.mockResolvedValue(undefined);
    mocks.saveCheckpoint.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    __resetAuditorStakeEventProjectionWorkerState();
  });

  it('links the prepared debt-settlement payout instead of creating a second payout for Withdrawn', async () => {
    mocks.findUserByWallet.mockResolvedValue({ id: 'auditor-1', role: 'auditor' });

    await __auditorStakeEventProjectionWorkerTestHooks.reconcileAuditorStakeEventsInternal();

    expect(mocks.linkPayout).toHaveBeenCalledWith('payout-1', WITHDRAWAL_HASH);
    expect(mocks.createPayout).not.toHaveBeenCalled();
    expect(mocks.saveCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({ contractAddress: CONTRACT_ADDRESS }),
      2,
      Number.MAX_SAFE_INTEGER
    );
  });

  it('dead-letters a deterministic event failure after three attempts and advances the checkpoint', async () => {
    mocks.findUserByWallet.mockRejectedValue(new Error('deterministic projection failure'));
    mocks.recordFailure
      .mockResolvedValueOnce({ failureCount: 1 })
      .mockResolvedValueOnce({ failureCount: 2 })
      .mockResolvedValueOnce({ failureCount: 3 });

    await __auditorStakeEventProjectionWorkerTestHooks.reconcileAuditorStakeEventsInternal();
    await __auditorStakeEventProjectionWorkerTestHooks.reconcileAuditorStakeEventsInternal();
    await __auditorStakeEventProjectionWorkerTestHooks.reconcileAuditorStakeEventsInternal();

    expect(mocks.markDeadLetter).toHaveBeenCalledWith(expect.objectContaining({
      transactionHash: WITHDRAWAL_HASH,
      logIndex: 0,
      minimumFailureCount: 3
    }));
    expect(mocks.loggerError).toHaveBeenCalledWith(
      expect.stringContaining('dead-letter'),
      expect.objectContaining({ transactionHash: WITHDRAWAL_HASH, failureCount: 3 })
    );
    expect(mocks.saveCheckpoint).toHaveBeenLastCalledWith(
      expect.objectContaining({ contractAddress: CONTRACT_ADDRESS }),
      2,
      Number.MAX_SAFE_INTEGER
    );
  });

  it('retries eth_getLogs after a temporary provider error and projects the recovered response', async () => {
    vi.useFakeTimers();
    mocks.getLogs
      .mockRejectedValueOnce(createTemporaryGetLogsError())
      .mockResolvedValueOnce([createWithdrawalLog()]);
    mocks.findUserByWallet.mockResolvedValue({ id: 'auditor-1', role: 'auditor' });

    const reconciliation = __auditorStakeEventProjectionWorkerTestHooks.reconcileAuditorStakeEventsInternal();
    await vi.runAllTimersAsync();
    await reconciliation;

    expect(mocks.getLogs).toHaveBeenCalledTimes(2);
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('eth_getLogs'),
      expect.objectContaining({ retryAttempt: 1, retryDelayMs: 250 })
    );
    expect(mocks.saveCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({ contractAddress: CONTRACT_ADDRESS }),
      2,
      Number.MAX_SAFE_INTEGER
    );
  });

  it('retries when ethers wraps a temporary RPC response in an HTTP 500 error', async () => {
    vi.useFakeTimers();
    mocks.getLogs
      .mockRejectedValueOnce(createTemporaryServerResponseError())
      .mockResolvedValueOnce([createWithdrawalLog()]);
    mocks.findUserByWallet.mockResolvedValue({ id: 'auditor-1', role: 'auditor' });

    const reconciliation = __auditorStakeEventProjectionWorkerTestHooks.reconcileAuditorStakeEventsInternal();
    await vi.runAllTimersAsync();
    await reconciliation;

    expect(mocks.getLogs).toHaveBeenCalledTimes(2);
    expect(mocks.saveCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({ contractAddress: CONTRACT_ADDRESS }),
      2,
      Number.MAX_SAFE_INTEGER
    );
  });

  it('uses the same-chain fallback RPC after primary eth_getLogs retries are exhausted', async () => {
    vi.useFakeTimers();
    mocks.getLogs.mockRejectedValue(createTemporaryGetLogsError());
    mocks.fallbackGetLogs.mockResolvedValue([createWithdrawalLog()]);
    mocks.getFallbackProvider.mockReturnValue(createFallbackProvider());
    mocks.findUserByWallet.mockResolvedValue({ id: 'auditor-1', role: 'auditor' });

    const reconciliation = __auditorStakeEventProjectionWorkerTestHooks.reconcileAuditorStakeEventsInternal();
    await vi.runAllTimersAsync();
    await reconciliation;

    expect(mocks.getLogs).toHaveBeenCalledTimes(3);
    expect(mocks.fallbackGetNetwork).toHaveBeenCalledOnce();
    expect(mocks.fallbackGetLogs).toHaveBeenCalledOnce();
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('fallback'),
      expect.any(Object)
    );
    expect(mocks.saveCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({ contractAddress: CONTRACT_ADDRESS }),
      2,
      Number.MAX_SAFE_INTEGER
    );
  });

  it('uses fallback directly during the cooldown after it recovers a temporary primary failure', async () => {
    vi.useFakeTimers();
    mocks.getLogs.mockRejectedValue(createTemporaryGetLogsError());
    mocks.fallbackGetLogs.mockResolvedValue([createWithdrawalLog()]);
    mocks.getFallbackProvider.mockReturnValue(createFallbackProvider());
    mocks.findUserByWallet.mockResolvedValue({ id: 'auditor-1', role: 'auditor' });

    const firstReconciliation = __auditorStakeEventProjectionWorkerTestHooks.reconcileAuditorStakeEventsInternal();
    await vi.runAllTimersAsync();
    await firstReconciliation;

    await __auditorStakeEventProjectionWorkerTestHooks.reconcileAuditorStakeEventsInternal();

    expect(mocks.getLogs).toHaveBeenCalledTimes(3);
    expect(mocks.fallbackGetLogs).toHaveBeenCalledTimes(2);
  });

  it('stops after bounded retries for a temporary eth_getLogs error without advancing the checkpoint', async () => {
    vi.useFakeTimers();
    mocks.getLogs.mockRejectedValue(createTemporaryGetLogsError());

    const reconciliation = __auditorStakeEventProjectionWorkerTestHooks.reconcileAuditorStakeEventsInternal();
    await vi.runAllTimersAsync();
    await reconciliation;

    expect(mocks.getLogs).toHaveBeenCalledTimes(3);
    expect(mocks.saveCheckpoint).not.toHaveBeenCalled();
    expect(mocks.loggerWarn).toHaveBeenLastCalledWith(
      expect.stringContaining('projector'),
      expect.any(Object)
    );
  });

  it('rejects a fallback RPC on another chain without querying its logs', async () => {
    vi.useFakeTimers();
    mocks.getLogs.mockRejectedValue(createTemporaryGetLogsError());
    mocks.getFallbackProvider.mockReturnValue(createFallbackProvider(80_002n));

    const reconciliation = __auditorStakeEventProjectionWorkerTestHooks.reconcileAuditorStakeEventsInternal();
    await vi.runAllTimersAsync();
    await reconciliation;

    expect(mocks.fallbackGetNetwork).toHaveBeenCalledOnce();
    expect(mocks.fallbackGetLogs).not.toHaveBeenCalled();
    expect(mocks.saveCheckpoint).not.toHaveBeenCalled();
  });

  it('does not retry a non-temporary eth_getLogs error', async () => {
    mocks.getLogs.mockRejectedValue(new Error('Invalid filter parameters'));

    await __auditorStakeEventProjectionWorkerTestHooks.reconcileAuditorStakeEventsInternal();

    expect(mocks.getLogs).toHaveBeenCalledOnce();
    expect(mocks.saveCheckpoint).not.toHaveBeenCalled();
  });

  it('does not retry a generic HTTP 500 error without the temporary RPC marker', async () => {
    mocks.getLogs.mockRejectedValue(new Error('server response 500 Internal Server Error'));

    await __auditorStakeEventProjectionWorkerTestHooks.reconcileAuditorStakeEventsInternal();

    expect(mocks.getLogs).toHaveBeenCalledOnce();
    expect(mocks.saveCheckpoint).not.toHaveBeenCalled();
  });
});
