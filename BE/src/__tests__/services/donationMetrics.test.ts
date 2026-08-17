import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  donationEventsTotal,
  getMetricsRegistry,
  resetMetricsForTest
} from '../../config/metricsRegistry';
import type { DonationEventLog } from '../../services/donationService';

const mocks = vi.hoisted(() => ({
  findGuestWalletSessionByWalletAddress: vi.fn(),
  incrementSessionDonationCounters: vi.fn(),
  findGuestDonationRiskByWalletAddress: vi.fn(),
  updateAuditByTransactionHash: vi.fn(),
  applyDonationToMetrics: vi.fn(),
  findUserById: vi.fn(),
  updateUser: vi.fn(),
  findProjectByProjectId: vi.fn(),
  upsertDonationRecordByTransactionHash: vi.fn(),
  findDonationHistoryByProjectId: vi.fn(),
  findDonationSummaryByProjectId: vi.fn(),
  findPublicCampaignByProjectId: vi.fn(),
  findPublicCampaigns: vi.fn(),
  getLatestIndexedBlockNumberFromRepository: vi.fn(),
  createUserNotification: vi.fn(),
  logEvent: vi.fn(),
  jsonRpcProvider: vi.fn(),
  interfaceConstructor: vi.fn()
}));

vi.mock('../../config/logger', () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }))
}));

vi.mock('../../services/notificationService', () => ({
  createUserNotification: mocks.createUserNotification
}));
vi.mock('../../config/zeroDev', () => ({
  getZeroDevConfig: vi.fn()
}));
vi.mock('../../services/zeroDevService', () => ({
  createKernelClientFromEncryptedOwnerKey: vi.fn()
}));
vi.mock('../../repositories/guestWalletSessionRepository', () => ({
  findGuestWalletSessionByWalletAddress: mocks.findGuestWalletSessionByWalletAddress,
  incrementSessionDonationCounters: mocks.incrementSessionDonationCounters
}));
vi.mock('../../repositories/guestDonationRiskRepository', () => ({
  findGuestDonationRiskByWalletAddress: mocks.findGuestDonationRiskByWalletAddress
}));
vi.mock('../../repositories/anonymousDonationAuditRepository', () => ({
  updateAuditByTransactionHash: mocks.updateAuditByTransactionHash
}));
vi.mock('../../services/rankingIncrementalService', () => ({
  applyDonationToMetrics: mocks.applyDonationToMetrics
}));
vi.mock('../../services/event-logger.service', () => ({
  logEvent: mocks.logEvent
}));
vi.mock('../../models/authModel', () => ({
  findUserById: mocks.findUserById,
  updateUser: mocks.updateUser
}));
vi.mock('../../models/projectModel', () => ({
  findProjectByProjectId: mocks.findProjectByProjectId
}));
vi.mock('../../repositories/donationRepository', () => ({
  findDonationHistoryByProjectId: mocks.findDonationHistoryByProjectId,
  findDonationSummaryByProjectId: mocks.findDonationSummaryByProjectId,
  findPublicCampaignByProjectId: mocks.findPublicCampaignByProjectId,
  findPublicCampaigns: mocks.findPublicCampaigns,
  getLatestIndexedBlockNumberFromRepository: mocks.getLatestIndexedBlockNumberFromRepository,
  upsertDonationRecordByTransactionHash: mocks.upsertDonationRecordByTransactionHash
}));
vi.mock('ethers', () => ({
  ethers: {
    JsonRpcProvider: mocks.jsonRpcProvider,
    Interface: mocks.interfaceConstructor
  }
}));

import {
  handleDonationPostIndex,
  recordDonationFromTransactionHash
} from '../../services/donationService';

const DONOR_ADDRESS = '0x742d35cc6634c0532925a3b844bc9e7595f5c21a';
const TRANSACTION_HASH = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

/** Tạo donation event hợp lệ dùng chung cho các assertion metrics. */
function createDonationEvent(): DonationEventLog {
  const now = new Date();
  return {
    transactionHash: TRANSACTION_HASH,
    projectId: '123',
    donorAddress: DONOR_ADDRESS,
    amount: 50,
    timestamp: now,
    isAnonymous: false,
    blockNumber: 123,
    donationStatus: 'INDEXED',
    onChainConfirmedAt: now,
    indexedAt: now,
    correlationId: 'donation:test',
    createdAt: now,
    updatedAt: now
  };
}

describe('donation Prometheus metrics', () => {
  const originalBlockchainEnvironment = {
    BLOCKCHAIN_RPC_URL: process.env.BLOCKCHAIN_RPC_URL,
    DONATION_RANKING_CONTRACT_ADDRESS: process.env.DONATION_RANKING_CONTRACT_ADDRESS,
    BLOCKCHAIN_CHAIN_ID: process.env.BLOCKCHAIN_CHAIN_ID
  };

  beforeEach(() => {
    resetMetricsForTest();
    vi.resetAllMocks();
    mocks.findGuestWalletSessionByWalletAddress.mockResolvedValue(null);
    mocks.findGuestDonationRiskByWalletAddress.mockResolvedValue(null);
    mocks.updateAuditByTransactionHash.mockResolvedValue(0);
    mocks.applyDonationToMetrics.mockResolvedValue(undefined);
    mocks.incrementSessionDonationCounters.mockResolvedValue(null);
    mocks.createUserNotification.mockResolvedValue(null);
    mocks.findProjectByProjectId.mockResolvedValue(null);
    mocks.logEvent.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const [key, value] of Object.entries(originalBlockchainEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('increments the event counter and observes the donation amount once', async () => {
    await handleDonationPostIndex(createDonationEvent());

    const metrics = await getMetricsRegistry().metrics();
    expect(metrics).toContain('donation_events_total 1');
    expect(metrics).toContain('donation_amount_vnd_sum 50');
    expect(metrics).toContain('donation_amount_vnd_count 1');
  });

  it('does not double-count the registered-user transaction-hash path', async () => {
    process.env.BLOCKCHAIN_RPC_URL = 'https://rpc.test';
    process.env.DONATION_RANKING_CONTRACT_ADDRESS = '0x1111111111111111111111111111111111111111';
    process.env.BLOCKCHAIN_CHAIN_ID = '80002';

    const parseLog = vi.fn(() => ({
      name: 'DonationReceived',
      args: {
        projectId: 123n,
        donor: DONOR_ADDRESS,
        amount: 50n,
        timestamp: 1_700_000_000n,
        isAnonymous: false
      }
    }));
    mocks.interfaceConstructor.mockImplementation(() => ({ parseLog }));
    mocks.jsonRpcProvider.mockImplementation(() => ({
      getNetwork: vi.fn().mockResolvedValue({ chainId: 80002n }),
      waitForTransaction: vi.fn().mockResolvedValue({
        status: 1,
        blockNumber: 123,
        logs: [{
          address: process.env.DONATION_RANKING_CONTRACT_ADDRESS,
          topics: ['0xtopic'],
          data: '0xdata'
        }]
      })
    }));
    mocks.findUserById.mockResolvedValue({ walletAddress: DONOR_ADDRESS });
    mocks.upsertDonationRecordByTransactionHash.mockResolvedValue(undefined);

    await recordDonationFromTransactionHash('user-1', '123', TRANSACTION_HASH, false);

    const metrics = await getMetricsRegistry().metrics();
    expect(metrics).toMatch(/^donation_events_total(?:\{[^}]*\})? 0$/m);
    expect(metrics).not.toContain('donation_amount_vnd_count');
    expect(mocks.applyDonationToMetrics).toHaveBeenCalledWith('123', 50, DONOR_ADDRESS);
  });

  it('ghi DONATION_CONFIRMED đủ field trên đường record transaction hash', async () => {
    process.env.BLOCKCHAIN_RPC_URL = 'https://rpc.test';
    process.env.DONATION_RANKING_CONTRACT_ADDRESS = '0x1111111111111111111111111111111111111111';
    process.env.BLOCKCHAIN_CHAIN_ID = '80002';

    const timestampSeconds = 1_700_000_000n;
    const parseLog = vi.fn(() => ({
      name: 'DonationReceived',
      args: {
        projectId: 123n,
        donor: DONOR_ADDRESS,
        amount: 50n,
        timestamp: timestampSeconds,
        isAnonymous: true
      }
    }));
    mocks.interfaceConstructor.mockImplementation(() => ({ parseLog }));
    mocks.jsonRpcProvider.mockImplementation(() => ({
      getNetwork: vi.fn().mockResolvedValue({ chainId: 80002n }),
      waitForTransaction: vi.fn().mockResolvedValue({
        status: 1,
        blockNumber: 123,
        logs: [{
          address: process.env.DONATION_RANKING_CONTRACT_ADDRESS,
          topics: ['0xtopic'],
          data: '0xdata'
        }]
      })
    }));
    mocks.findUserById.mockResolvedValue({ walletAddress: DONOR_ADDRESS });
    mocks.upsertDonationRecordByTransactionHash.mockResolvedValue(undefined);

    await recordDonationFromTransactionHash('user-1', '123', TRANSACTION_HASH, false);

    expect(mocks.logEvent).toHaveBeenCalledWith({
      eventType: 'DONATION_CONFIRMED',
      projectId: '123',
      walletAddress: DONOR_ADDRESS,
      amount: 50,
      correlationId: `donation:${TRANSACTION_HASH}`,
      timestamp: new Date(Number(timestampSeconds) * 1000),
      payload: {
        transactionHash: TRANSACTION_HASH,
        blockNumber: 123,
        isAnonymous: true
      }
    });
  });

  it('does not fail the indexed donation when Prometheus registry recording throws', async () => {
    vi.spyOn(donationEventsTotal, 'inc').mockImplementation(() => {
      throw new Error('registry unavailable');
    });

    await expect(handleDonationPostIndex(createDonationEvent())).resolves.toBe(false);
    expect(mocks.applyDonationToMetrics).toHaveBeenCalledTimes(1);
  });
});
