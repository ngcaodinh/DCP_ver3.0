import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getProvider: vi.fn(),
  getContract: vi.fn(),
  getAddress: vi.fn(),
  findEarliestBlock: vi.fn(),
  findPendingEvents: vi.fn(),
  findCheckpoint: vi.fn(),
  saveCheckpoint: vi.fn(),
  projectEvent: vi.fn(),
  loggerError: vi.fn(),
  getLogs: vi.fn()
}));

vi.mock('../../config/sbtContract', () => ({
  getReadOnlyImpactSbtProvider: mocks.getProvider,
  getReadOnlyImpactSbtContract: mocks.getContract,
  getImpactSbtContractAddressLowercase: mocks.getAddress
}));

vi.mock('../../models/impactSbtMetadataModel', () => ({
  findEarliestConfirmedImpactSbtBlock: mocks.findEarliestBlock
}));

vi.mock('../../models/sbtStatusProjectionModel', () => ({
  findPendingSbtStatusProjectionEvents: mocks.findPendingEvents,
  findSbtStatusProjectionCheckpoint: mocks.findCheckpoint,
  saveSbtStatusProjectionCheckpoint: mocks.saveCheckpoint
}));

vi.mock('../../services/sbtStatusProjectionService', () => ({
  projectSbtTokenStatusUpdate: mocks.projectEvent
}));

  vi.mock('../../config/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: mocks.loggerError, debug: vi.fn() })
}));

import {
  __resetSbtStatusProjectionWorkerState,
  reconcileSbtTokenStatusProjection,
  startSbtStatusProjectionWorker,
  stopSbtStatusProjectionWorker
} from '../../workers/sbtStatusProjectionWorker';

describe('reconcileSbtTokenStatusProjection', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.resetAllMocks();
    __resetSbtStatusProjectionWorkerState();
    mocks.getAddress.mockReturnValue('0x0000000000000000000000000000000000000001');
    mocks.getProvider.mockReturnValue({
      getNetwork: vi.fn().mockResolvedValue({ chainId: 490000n }),
      getBlockNumber: vi.fn().mockResolvedValue(20),
      getLogs: mocks.getLogs.mockResolvedValue([
        {
          transactionHash: '0xexternal-status',
          blockHash: '0xblock',
          blockNumber: 8,
          index: 2,
          topics: ['0xtopic'],
          data: '0x'
        }
      ])
    });
    mocks.getContract.mockReturnValue({
      interface: {
        getEvent: vi.fn().mockReturnValue({ topicHash: '0xtopic' }),
        parseLog: vi.fn().mockReturnValue({
          name: 'TokenStatusUpdated',
          args: { tokenId: 12n, newStatus: 2n, reason: 'Evidence invalidated.' }
        })
      }
    });
    mocks.findCheckpoint.mockResolvedValue({
      chainId: '490000',
      contractAddress: '0x0000000000000000000000000000000000000001',
      lastProcessedBlock: 8,
      lastProcessedLogIndex: -1
    });
    mocks.findPendingEvents.mockResolvedValue([]);
    mocks.projectEvent.mockResolvedValue(true);
    mocks.saveCheckpoint.mockResolvedValue(undefined);
  });

  it('replays a confirmed direct contract event and advances the durable checkpoint only after projection', async () => {
    await reconcileSbtTokenStatusProjection();

    expect(mocks.projectEvent).toHaveBeenCalledWith({
      chainId: '490000',
      contractAddress: '0x0000000000000000000000000000000000000001',
      transactionHash: '0xexternal-status',
      logIndex: 2,
      blockNumber: 8,
      blockHash: '0xblock',
      tokenId: 12,
      newStatus: 'REVOKED',
      reason: 'Evidence invalidated.'
    });
    expect(mocks.saveCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({ chainId: '490000' }),
      8,
      Number.MAX_SAFE_INTEGER
    );
  });

  it('skips an event at or before the stored log checkpoint during replay', async () => {
    mocks.findCheckpoint.mockResolvedValue({
      chainId: '490000',
      contractAddress: '0x0000000000000000000000000000000000000001',
      lastProcessedBlock: 8,
      lastProcessedLogIndex: 2
    });

    await reconcileSbtTokenStatusProjection();

    expect(mocks.projectEvent).not.toHaveBeenCalled();
    expect(mocks.saveCheckpoint).toHaveBeenCalled();
  });

  it('does not advance the checkpoint when a projection fails so the durable event is replayed later', async () => {
    mocks.projectEvent.mockRejectedValue(new Error('Mongo unavailable'));

    await reconcileSbtTokenStatusProjection();

    expect(mocks.saveCheckpoint).not.toHaveBeenCalled();
  });

  it('advances the checkpoint and projects a valid log after an earlier durable event is deferred', async () => {
    mocks.getProvider.mockReturnValue({
      getNetwork: vi.fn().mockResolvedValue({ chainId: 490000n }),
      getBlockNumber: vi.fn().mockResolvedValue(20),
      getLogs: vi.fn().mockResolvedValue([
        {
          transactionHash: '0xunmanaged-status',
          blockHash: '0xblock',
          blockNumber: 8,
          index: 1,
          topics: ['0xtopic'],
          data: '0xunmanaged'
        },
        {
          transactionHash: '0xmanaged-revoke',
          blockHash: '0xblock',
          blockNumber: 8,
          index: 2,
          topics: ['0xtopic'],
          data: '0xmanaged'
        }
      ])
    });
    mocks.getContract.mockReturnValue({
      interface: {
        getEvent: vi.fn().mockReturnValue({ topicHash: '0xtopic' }),
        parseLog: vi.fn().mockImplementation(({ data }: { data: string }) => ({
          name: 'TokenStatusUpdated',
          args: {
            tokenId: data === '0xunmanaged' ? 999n : 12n,
            newStatus: data === '0xunmanaged' ? 1n : 2n,
            reason: 'Evidence invalidated.'
          }
        }))
      }
    });
    mocks.projectEvent.mockImplementation((event: { tokenId: number }) => Promise.resolve(event.tokenId !== 999));

    await reconcileSbtTokenStatusProjection();

    expect(mocks.projectEvent).toHaveBeenNthCalledWith(1, expect.objectContaining({ tokenId: 999 }));
    expect(mocks.projectEvent).toHaveBeenNthCalledWith(2, expect.objectContaining({ tokenId: 12 }));
    expect(mocks.saveCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({ chainId: '490000' }),
      8,
      Number.MAX_SAFE_INTEGER
    );
  });

  it('does not persist a finalized-block sentinel when no confirmed mint exists, then retries bootstrap later', async () => {
    mocks.findCheckpoint.mockResolvedValue(null);
    mocks.findEarliestBlock.mockResolvedValueOnce(null).mockResolvedValue(5);

    await reconcileSbtTokenStatusProjection();
    expect(mocks.saveCheckpoint).not.toHaveBeenCalled();
    expect(mocks.getLogs).not.toHaveBeenCalled();

    await reconcileSbtTokenStatusProjection();
    expect(mocks.getLogs).toHaveBeenCalledWith(expect.objectContaining({ fromBlock: 5 }));
    expect(mocks.saveCheckpoint).toHaveBeenCalled();
  });

  it('does not query Mongo or logs when the chain has not reached the confirmation depth', async () => {
    mocks.getProvider.mockReturnValue({
      getNetwork: vi.fn().mockResolvedValue({ chainId: 490000n }),
      getBlockNumber: vi.fn().mockResolvedValue(10),
      getLogs: mocks.getLogs
    });

    await reconcileSbtTokenStatusProjection();

    expect(mocks.findCheckpoint).not.toHaveBeenCalled();
    expect(mocks.findEarliestBlock).not.toHaveBeenCalled();
    expect(mocks.getLogs).not.toHaveBeenCalled();
  });

  it('contains an unknown provider failure without leaving the running guard set', async () => {
    mocks.getProvider.mockReturnValue({
      getNetwork: vi.fn().mockRejectedValue(null),
      getBlockNumber: vi.fn().mockResolvedValue(20),
      getLogs: mocks.getLogs
    });

    await reconcileSbtTokenStatusProjection();
    await reconcileSbtTokenStatusProjection();

    expect(mocks.loggerError).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ errorMessage: 'UNKNOWN_ERROR' })
    );
    expect(mocks.getProvider).toHaveBeenCalledTimes(2);
  });

  it('does not scan logs when the checkpoint already covers the finalized block', async () => {
    mocks.findCheckpoint.mockResolvedValue({
      chainId: '490000',
      contractAddress: '0x0000000000000000000000000000000000000001',
      lastProcessedBlock: 8,
      lastProcessedLogIndex: Number.MAX_SAFE_INTEGER
    });

    await reconcileSbtTokenStatusProjection();

    expect(mocks.getLogs).not.toHaveBeenCalled();
    expect(mocks.saveCheckpoint).not.toHaveBeenCalled();
  });

  it('logs and exits safely when the contract ABI has no TokenStatusUpdated event', async () => {
    mocks.getContract.mockReturnValue({
      interface: {
        getEvent: vi.fn().mockReturnValue(null)
      }
    });

    await reconcileSbtTokenStatusProjection();

    expect(mocks.getLogs).not.toHaveBeenCalled();
    expect(mocks.saveCheckpoint).not.toHaveBeenCalled();
    expect(mocks.loggerError).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ errorMessage: expect.stringContaining('ABI ImpactSBT') })
    );
  });

  it('runs due pending events before scanning new finalized logs', async () => {
    const pendingEvent = {
      chainId: '490000',
      contractAddress: '0x0000000000000000000000000000000000000001',
      transactionHash: '0xpending',
      logIndex: 0,
      blockNumber: 7,
      blockHash: '0xpending-block',
      tokenId: 12,
      newStatus: 'FROZEN' as const,
      reason: 'Retry.'
    };
    mocks.findPendingEvents.mockResolvedValue([pendingEvent]);

    await reconcileSbtTokenStatusProjection();

    expect(mocks.projectEvent).toHaveBeenNthCalledWith(1, pendingEvent);
    expect(mocks.getLogs).toHaveBeenCalled();
  });

  it('skips a poison log and still projects a valid status log later in the same chunk', async () => {
    mocks.getLogs.mockResolvedValue([
      {
        transactionHash: '0xpoison',
        blockHash: '0xpoison-block',
        blockNumber: 8,
        index: 1,
        topics: ['0xtopic'],
        data: '0xpoison'
      },
      {
        transactionHash: '0xvalid-revoke',
        blockHash: '0xvalid-block',
        blockNumber: 8,
        index: 2,
        topics: ['0xtopic'],
        data: '0xvalid'
      }
    ]);
    mocks.getContract.mockReturnValue({
      interface: {
        getEvent: vi.fn().mockReturnValue({ topicHash: '0xtopic' }),
        parseLog: vi.fn().mockImplementation(({ data }: { data: string }) => {
          if (data === '0xpoison') {
            return {
              name: 'TokenStatusUpdated',
              args: { tokenId: 12n, newStatus: 9n, reason: 'Unknown status.' }
            };
          }
          return {
            name: 'TokenStatusUpdated',
            args: { tokenId: 12n, newStatus: 2n, reason: 'Evidence invalidated.' }
          };
        })
      }
    });

    await reconcileSbtTokenStatusProjection();

    expect(mocks.projectEvent).toHaveBeenCalledTimes(1);
    expect(mocks.projectEvent).toHaveBeenCalledWith(expect.objectContaining({
      transactionHash: '0xvalid-revoke',
      newStatus: 'REVOKED'
    }));
    expect(mocks.saveCheckpoint).toHaveBeenCalled();
    expect(mocks.loggerError).toHaveBeenCalledWith(
      'Bỏ qua TokenStatusUpdated log không thể parse.',
      expect.objectContaining({ transactionHash: '0xpoison', logIndex: 1 })
    );
  });

  it('skips parseLog null, wrong event, invalid token and non-canonical logs', async () => {
    const baseLog = {
      blockNumber: 8,
      index: 1,
      topics: ['0xtopic'],
      data: '0x'
    };
    mocks.getLogs.mockResolvedValue([
      { ...baseLog, transactionHash: '0xnull-parse', blockHash: '0xblock-null', data: '0xnull' },
      { ...baseLog, transactionHash: '0xwrong-event', blockHash: '0xblock-wrong', data: '0xwrong', index: 2 },
      { ...baseLog, transactionHash: '0xinvalid-token', blockHash: '0xblock-token', data: '0xtoken', index: 3 },
      { ...baseLog, transactionHash: undefined, blockHash: undefined, data: '0xlocation', index: 4 },
      { ...baseLog, transactionHash: '0xfallback-error', blockHash: '0xblock-fallback', data: '0xfallback', index: 5 },
      { ...baseLog, transactionHash: '0xvalid-after-errors', blockHash: '0xblock-valid', data: '0xvalid', index: 6 }
    ]);
    mocks.getContract.mockReturnValue({
      interface: {
        getEvent: vi.fn().mockReturnValue({ topicHash: '0xtopic' }),
        parseLog: vi.fn().mockImplementation(({ data }: { data: string }) => {
          if (data === '0xnull') return null;
          if (data === '0xwrong') return { name: 'OtherEvent', args: {} };
          if (data === '0xtoken') {
            return { name: 'TokenStatusUpdated', args: { tokenId: -1n, newStatus: 1n, reason: '' } };
          }
          if (data === '0xfallback') throw null;
          return { name: 'TokenStatusUpdated', args: { tokenId: 12n, newStatus: 1n, reason: '' } };
        })
      }
    });

    await reconcileSbtTokenStatusProjection();

    expect(mocks.projectEvent).toHaveBeenCalledTimes(1);
    expect(mocks.projectEvent).toHaveBeenCalledWith(expect.objectContaining({
      transactionHash: '0xvalid-after-errors'
    }));
    expect(mocks.loggerError).toHaveBeenCalledTimes(5);
    expect(mocks.loggerError).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ errorMessage: 'UNKNOWN_ERROR' })
    );
    expect(mocks.saveCheckpoint).toHaveBeenCalled();
  });

  it('releases the running guard after a single-call RPC timeout so a later cycle can retry', async () => {
    vi.useFakeTimers();
    let networkCallCount = 0;
    mocks.getProvider.mockReturnValue({
      getNetwork: vi.fn().mockImplementation(() => {
        networkCallCount += 1;
        return networkCallCount === 1
          ? new Promise<never>(() => undefined)
          : Promise.resolve({ chainId: 490000n });
      }),
      getBlockNumber: vi.fn().mockResolvedValue(20),
      getLogs: mocks.getLogs.mockResolvedValue([])
    });
    const firstRun = reconcileSbtTokenStatusProjection();
    const skippedRun = reconcileSbtTokenStatusProjection();

    await skippedRun;

    await vi.advanceTimersByTimeAsync(5_000);
    await firstRun;
    expect(mocks.saveCheckpoint).not.toHaveBeenCalled();

    await reconcileSbtTokenStatusProjection();
    expect(mocks.getLogs).toHaveBeenCalledTimes(1);
  });

  it('allows a log scan to exceed the single-call timeout and completes before the log timeout', async () => {
    vi.useFakeTimers();
    let resolveLogs: ((logs: never[]) => void) | undefined;
    mocks.getLogs.mockReturnValue(new Promise<never[]>((resolve) => {
      resolveLogs = resolve;
    }));

    const run = reconcileSbtTokenStatusProjection();
    await vi.advanceTimersByTimeAsync(0);
    expect(resolveLogs).toBeDefined();

    await vi.advanceTimersByTimeAsync(5_001);
    expect(mocks.saveCheckpoint).not.toHaveBeenCalled();

    resolveLogs?.([]);
    await run;

    expect(mocks.saveCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({ chainId: '490000' }),
      8,
      Number.MAX_SAFE_INTEGER
    );
  });

  it('starts only one polling timer and stops it idempotently', async () => {
    vi.useFakeTimers();

    startSbtStatusProjectionWorker();
    startSbtStatusProjectionWorker();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(mocks.getProvider).toHaveBeenCalledTimes(2);
    stopSbtStatusProjectionWorker();
    stopSbtStatusProjectionWorker();

    expect(vi.getTimerCount()).toBe(0);
  });
});
