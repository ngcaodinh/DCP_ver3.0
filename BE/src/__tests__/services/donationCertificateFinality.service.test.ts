import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  JsonRpcProvider: vi.fn(),
  getDonationCertificateConfig: vi.fn(),
  findUserById: vi.fn(),
  findProjectByProjectId: vi.fn()
}));

vi.mock('ethers', async importOriginal => {
  const actual = await importOriginal<typeof import('ethers')>();
  return {
    ...actual,
    ethers: {
      ...actual.ethers,
      JsonRpcProvider: mocks.JsonRpcProvider
    }
  };
});

vi.mock('../../config/donationCertificateConfig', () => ({
  getDonationCertificateConfig: mocks.getDonationCertificateConfig
}));

vi.mock('../../models/authModel', () => ({
  findUserById: mocks.findUserById
}));

vi.mock('../../models/projectModel', () => ({
  findProjectByProjectId: mocks.findProjectByProjectId
}));

import { ethers } from 'ethers';
import { verifyDonationCertificateFinality } from '../../services/donationCertificateFinality.service';

const DONATION_RECEIVED_ABI = ['event DonationReceived(address indexed donor, uint256 indexed projectId, uint256 amount, uint256 timestamp, bool isAnonymous)'];
const DONOR_ADDRESS = '0x1111111111111111111111111111111111111111';
const CONTRACT_ADDRESS = '0x2222222222222222222222222222222222222222';
const TRANSACTION_HASH = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
const BLOCK_HASH = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd';

/** Tạo receipt có event DonationReceived hợp lệ để cô lập nhánh kiểm tra finality. */
function createReceipt(): Record<string, unknown> {
  const eventInterface = new ethers.Interface(DONATION_RECEIVED_ABI);
  const donationReceivedEvent = eventInterface.getEvent('DonationReceived');
  if (!donationReceivedEvent) throw new Error('DonationReceived event phải tồn tại trong ABI test.');
  const encodedEvent = eventInterface.encodeEventLog(
    donationReceivedEvent,
    [DONOR_ADDRESS, 1n, 1000n, 1_788_179_200n, false]
  );
  return {
    status: 1,
    blockNumber: 100,
    blockHash: BLOCK_HASH,
    hash: TRANSACTION_HASH,
    logs: [{ address: CONTRACT_ADDRESS, topics: encodedEvent.topics, data: encodedEvent.data, index: 0 }]
  };
}

describe('donationCertificateFinality.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.BLOCKCHAIN_RPC_URL = 'https://rpc.example';
    delete process.env.BLOCKCHAIN_RPC_FALLBACK_URL;
    mocks.getDonationCertificateConfig.mockReturnValue({
      chainId: 80002,
      donationContractAddress: CONTRACT_ADDRESS,
      networkName: 'Polygon Amoy',
      pollIntervalMs: 2_000,
      fallbackConfirmations: 12
    });
  });

  it('trả PENDING trước khi đọc user, project hoặc organization khi block chưa finalized', async () => {
    const provider = {
      getNetwork: vi.fn().mockResolvedValue({ chainId: 80002n }),
      getTransactionReceipt: vi.fn().mockResolvedValue(createReceipt()),
      getBlock: vi.fn().mockResolvedValue({ hash: BLOCK_HASH }),
      getBlockNumber: vi.fn().mockResolvedValue(100),
      send: vi.fn().mockResolvedValue({ number: '0x63' })
    };
    mocks.JsonRpcProvider.mockImplementation(() => provider);

    const verdict = await verifyDonationCertificateFinality({
      transactionHash: TRANSACTION_HASH,
      donorUserId: 'user-1',
      expectedProjectId: '1',
      expectedDonorAddress: DONOR_ADDRESS,
      expectedAmountRaw: '1000',
      expectedIsAnonymous: false,
      requestedMode: 'RPC_FINALIZED'
    });

    expect(verdict).toMatchObject({ status: 'PENDING', finalityMode: 'RPC_FINALIZED', finalizedBlockNumber: 99 });
    expect(mocks.findUserById).not.toHaveBeenCalled();
    expect(mocks.findProjectByProjectId).not.toHaveBeenCalled();
  });
});
