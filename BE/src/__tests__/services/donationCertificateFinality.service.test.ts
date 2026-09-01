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
interface ReceiptEventOverrides {
  donor?: string;
  projectId?: bigint;
  amount?: bigint;
  isAnonymous?: boolean;
  blockHash?: string;
}

/** Tạo receipt có event DonationReceived với các biến thể cần kiểm thử. */
function createReceipt(overrides: ReceiptEventOverrides = {}): Record<string, unknown> {
  const eventInterface = new ethers.Interface(DONATION_RECEIVED_ABI);
  const donationReceivedEvent = eventInterface.getEvent('DonationReceived');
  if (!donationReceivedEvent) throw new Error('DonationReceived event phải tồn tại trong ABI test.');
  const encodedEvent = eventInterface.encodeEventLog(
    donationReceivedEvent,
    [overrides.donor ?? DONOR_ADDRESS, overrides.projectId ?? 1n, overrides.amount ?? 1000n, 1_788_179_200n, overrides.isAnonymous ?? false]
  );
  return {
    status: 1,
    blockNumber: 100,
    blockHash: overrides.blockHash ?? BLOCK_HASH,
    hash: TRANSACTION_HASH,
    logs: [{ address: CONTRACT_ADDRESS, topics: encodedEvent.topics, data: encodedEvent.data, index: 0 }]
  };
}

interface MockProviderOverrides {
  getNetwork?: ReturnType<typeof vi.fn>;
  getTransactionReceipt?: ReturnType<typeof vi.fn>;
  getBlock?: ReturnType<typeof vi.fn>;
  getBlockNumber?: ReturnType<typeof vi.fn>;
  send?: ReturnType<typeof vi.fn>;
}

/** Tạo provider giả lập với mặc định đã đủ để đi qua các bước đọc receipt và finality. */
function createMockProvider(overrides: MockProviderOverrides = {}): Record<string, ReturnType<typeof vi.fn>> {
  return {
    getNetwork: vi.fn().mockResolvedValue({ chainId: 80002n }),
    getTransactionReceipt: vi.fn().mockResolvedValue(createReceipt()),
    getBlock: vi.fn().mockResolvedValue({ hash: BLOCK_HASH }),
    getBlockNumber: vi.fn().mockResolvedValue(112),
    send: vi.fn().mockResolvedValue({ number: '0x64' }),
    ...overrides
  };
}

/** Cấu hình dữ liệu Mongo giả lập để nhánh VERIFIED có thể tạo snapshot đầy đủ. */
function mockVerifiedDatabase(): void {
  mocks.findUserById.mockResolvedValueOnce({ fullName: 'Nguyễn Văn An', walletAddress: DONOR_ADDRESS }).mockResolvedValueOnce({ organizationName: 'DCP Foundation' });
  mocks.findProjectByProjectId.mockResolvedValue({ projectId: '1', name: 'Project One', organizationId: 'organization-1' });
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
    const provider = createMockProvider({ getBlockNumber: vi.fn().mockResolvedValue(100), send: vi.fn().mockResolvedValue({ number: '0x63' }) });
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

  it('trả VERIFIED và snapshot đúng dữ liệu sau khi receipt đã finalized', async () => {
    const provider = createMockProvider();
    mocks.JsonRpcProvider.mockImplementation(() => provider);
    mockVerifiedDatabase();

    const verdict = await verifyDonationCertificateFinality({
      transactionHash: TRANSACTION_HASH,
      donorUserId: 'user-1',
      expectedProjectId: '1',
      expectedDonorAddress: DONOR_ADDRESS,
      expectedAmountRaw: '1000',
      expectedIsAnonymous: false,
      requestedMode: 'RPC_FINALIZED'
    });

    expect(verdict).toMatchObject({
      status: 'VERIFIED',
      currentConfirmations: 13,
      snapshot: {
        donorName: 'Nguyễn Văn An',
        donorAddress: DONOR_ADDRESS,
        projectId: '1',
        projectName: 'Project One',
        organizationName: 'DCP Foundation',
        amountRaw: '1000',
        blockNumber: 100,
        blockHash: BLOCK_HASH,
        logIndex: 0
      }
    });
  });

  it('trả REVOKED RECEIPT_MISSING khi RPC không tìm thấy receipt', async () => {
    const provider = createMockProvider({ getTransactionReceipt: vi.fn().mockResolvedValue(null) });
    mocks.JsonRpcProvider.mockImplementation(() => provider);

    await expect(verifyDonationCertificateFinality({
      transactionHash: TRANSACTION_HASH,
      donorUserId: 'user-1',
      expectedProjectId: '1',
      expectedDonorAddress: DONOR_ADDRESS,
      expectedAmountRaw: '1000',
      expectedIsAnonymous: false,
      requestedMode: 'RPC_FINALIZED'
    })).resolves.toMatchObject({ status: 'REVOKED', reasonCode: 'RECEIPT_MISSING' });
    expect(provider.getBlock).not.toHaveBeenCalled();
  });

  it('trả REVOKED RECEIPT_FAILED khi transaction receipt có status khác 1', async () => {
    const provider = createMockProvider({ getTransactionReceipt: vi.fn().mockResolvedValue(createReceipt({})) });
    provider.getTransactionReceipt.mockResolvedValue({ ...createReceipt(), status: 0 });
    mocks.JsonRpcProvider.mockImplementation(() => provider);

    await expect(verifyDonationCertificateFinality({
      transactionHash: TRANSACTION_HASH,
      donorUserId: 'user-1',
      expectedProjectId: '1',
      expectedDonorAddress: DONOR_ADDRESS,
      expectedAmountRaw: '1000',
      expectedIsAnonymous: false,
      requestedMode: 'RPC_FINALIZED'
    })).resolves.toMatchObject({ status: 'REVOKED', reasonCode: 'RECEIPT_FAILED' });
  });

  it('trả REVOKED BLOCK_HASH_MISMATCH khi block canonical khác receipt', async () => {
    const provider = createMockProvider({ getBlock: vi.fn().mockResolvedValue({ hash: '0xdeadbeef' }) });
    mocks.JsonRpcProvider.mockImplementation(() => provider);

    await expect(verifyDonationCertificateFinality({
      transactionHash: TRANSACTION_HASH,
      donorUserId: 'user-1',
      expectedProjectId: '1',
      expectedDonorAddress: DONOR_ADDRESS,
      expectedAmountRaw: '1000',
      expectedIsAnonymous: false,
      requestedMode: 'RPC_FINALIZED'
    })).resolves.toMatchObject({ status: 'REVOKED', reasonCode: 'BLOCK_HASH_MISMATCH' });
  });

  it.each([
    ['donor mismatch', { donor: '0x3333333333333333333333333333333333333333' }],
    ['project mismatch', { projectId: 2n }],
    ['amount mismatch', { amount: 1001n }],
    ['anonymous event', { isAnonymous: true }]
  ])('trả REVOKED EVENT_MISMATCH khi event có %s', async (_label, overrides) => {
    const provider = createMockProvider({ getTransactionReceipt: vi.fn().mockResolvedValue(createReceipt(overrides)) });
    mocks.JsonRpcProvider.mockImplementation(() => provider);

    await expect(verifyDonationCertificateFinality({
      transactionHash: TRANSACTION_HASH,
      donorUserId: 'user-1',
      expectedProjectId: '1',
      expectedDonorAddress: DONOR_ADDRESS,
      expectedAmountRaw: '1000',
      expectedIsAnonymous: false,
      requestedMode: 'RPC_FINALIZED'
    })).resolves.toMatchObject({ status: 'REVOKED', reasonCode: 'EVENT_MISMATCH' });
  });

  it('trả BLOCKED USER_NOT_FOUND trước khi tạo snapshot', async () => {
    const provider = createMockProvider();
    mocks.JsonRpcProvider.mockImplementation(() => provider);
    mocks.findUserById.mockResolvedValue(null);

    await expect(verifyDonationCertificateFinality({
      transactionHash: TRANSACTION_HASH,
      donorUserId: 'user-1',
      expectedProjectId: '1',
      expectedDonorAddress: DONOR_ADDRESS,
      expectedAmountRaw: '1000',
      expectedIsAnonymous: false,
      requestedMode: 'RPC_FINALIZED'
    })).resolves.toMatchObject({ status: 'BLOCKED', reasonCode: 'USER_NOT_FOUND' });
  });

  it('trả BLOCKED PROJECT_NOT_FOUND khi user hợp lệ nhưng project không còn', async () => {
    const provider = createMockProvider();
    mocks.JsonRpcProvider.mockImplementation(() => provider);
    mocks.findUserById.mockResolvedValueOnce({ fullName: 'Nguyễn Văn An', walletAddress: DONOR_ADDRESS });
    mocks.findProjectByProjectId.mockResolvedValue(null);

    await expect(verifyDonationCertificateFinality({
      transactionHash: TRANSACTION_HASH,
      donorUserId: 'user-1',
      expectedProjectId: '1',
      expectedDonorAddress: DONOR_ADDRESS,
      expectedAmountRaw: '1000',
      expectedIsAnonymous: false,
      requestedMode: 'RPC_FINALIZED'
    })).resolves.toMatchObject({ status: 'BLOCKED', reasonCode: 'PROJECT_NOT_FOUND' });
  });

  it('trả BLOCKED ORGANIZATION_NOT_FOUND khi project thiếu tổ chức hoặc tên tổ chức', async () => {
    const provider = createMockProvider();
    mocks.JsonRpcProvider.mockImplementation(() => provider);
    mocks.findUserById.mockResolvedValueOnce({ fullName: 'Nguyễn Văn An', walletAddress: DONOR_ADDRESS }).mockResolvedValueOnce(null);
    mocks.findProjectByProjectId.mockResolvedValue({ projectId: '1', name: 'Project One', organizationId: 'organization-1' });

    await expect(verifyDonationCertificateFinality({
      transactionHash: TRANSACTION_HASH,
      donorUserId: 'user-1',
      expectedProjectId: '1',
      expectedDonorAddress: DONOR_ADDRESS,
      expectedAmountRaw: '1000',
      expectedIsAnonymous: false,
      requestedMode: 'RPC_FINALIZED'
    })).resolves.toMatchObject({ status: 'BLOCKED', reasonCode: 'ORGANIZATION_NOT_FOUND' });
  });

  it('trả BLOCKED INVALID_CONFIGURATION khi không có RPC URL', async () => {
    delete process.env.BLOCKCHAIN_RPC_URL;

    await expect(verifyDonationCertificateFinality({
      transactionHash: TRANSACTION_HASH,
      donorUserId: 'user-1',
      expectedProjectId: '1',
      expectedDonorAddress: DONOR_ADDRESS,
      expectedAmountRaw: '1000',
      expectedIsAnonymous: false,
      requestedMode: 'RPC_FINALIZED'
    })).resolves.toMatchObject({ status: 'BLOCKED', reasonCode: 'INVALID_CONFIGURATION' });
    expect(mocks.JsonRpcProvider).not.toHaveBeenCalled();
  });

  it('trả UNAVAILABLE RPC_RATE_LIMITED khi RPC receipt bị rate limit', async () => {
    const provider = createMockProvider({ getTransactionReceipt: vi.fn().mockRejectedValue(new Error('429 rate limit')) });
    mocks.JsonRpcProvider.mockImplementation(() => provider);

    await expect(verifyDonationCertificateFinality({
      transactionHash: TRANSACTION_HASH,
      donorUserId: 'user-1',
      expectedProjectId: '1',
      expectedDonorAddress: DONOR_ADDRESS,
      expectedAmountRaw: '1000',
      expectedIsAnonymous: false,
      requestedMode: 'RPC_FINALIZED'
    })).resolves.toMatchObject({ status: 'UNAVAILABLE', errorCode: 'RPC_RATE_LIMITED', retryAfterMs: 2_000 });
  });

  it('trả FINALIZED_TAG_UNSUPPORTED khi provider không hỗ trợ tag finalized', async () => {
    const provider = createMockProvider({ send: vi.fn().mockRejectedValue(Object.assign(new Error('method not found'), { code: -32601 })) });
    mocks.JsonRpcProvider.mockImplementation(() => provider);

    await expect(verifyDonationCertificateFinality({
      transactionHash: TRANSACTION_HASH,
      donorUserId: 'user-1',
      expectedProjectId: '1',
      expectedDonorAddress: DONOR_ADDRESS,
      expectedAmountRaw: '1000',
      expectedIsAnonymous: false,
      requestedMode: 'RPC_FINALIZED'
    })).resolves.toMatchObject({ status: 'FINALIZED_TAG_UNSUPPORTED' });
  });

  it('trả PENDING trong confirmation fallback khi chưa đủ 12 confirmations', async () => {
    const provider = createMockProvider({ getBlockNumber: vi.fn().mockResolvedValue(105) });
    mocks.JsonRpcProvider.mockImplementation(() => provider);

    await expect(verifyDonationCertificateFinality({
      transactionHash: TRANSACTION_HASH,
      donorUserId: 'user-1',
      expectedProjectId: '1',
      expectedDonorAddress: DONOR_ADDRESS,
      expectedAmountRaw: '1000',
      expectedIsAnonymous: false,
      requestedMode: 'CONFIRMATION_FALLBACK'
    })).resolves.toMatchObject({ status: 'PENDING', finalityMode: 'CONFIRMATION_FALLBACK', currentConfirmations: 6 });
    expect(provider.send).not.toHaveBeenCalled();
  });

  it('trả VERIFIED trong confirmation fallback khi đủ 12 confirmations', async () => {
    const provider = createMockProvider({ getBlockNumber: vi.fn().mockResolvedValue(111) });
    mocks.JsonRpcProvider.mockImplementation(() => provider);
    mockVerifiedDatabase();

    await expect(verifyDonationCertificateFinality({
      transactionHash: TRANSACTION_HASH,
      donorUserId: 'user-1',
      expectedProjectId: '1',
      expectedDonorAddress: DONOR_ADDRESS,
      expectedAmountRaw: '1000',
      expectedIsAnonymous: false,
      requestedMode: 'CONFIRMATION_FALLBACK'
    })).resolves.toMatchObject({ status: 'VERIFIED', finalityMode: 'CONFIRMATION_FALLBACK', currentConfirmations: 12 });
    expect(provider.send).not.toHaveBeenCalled();
  });

  it('dùng provider fallback khi RPC chính lỗi lúc đọc receipt', async () => {
    const primaryProvider = createMockProvider({ getTransactionReceipt: vi.fn().mockRejectedValue(new Error('primary RPC timeout')) });
    const fallbackProvider = createMockProvider();
    process.env.BLOCKCHAIN_RPC_FALLBACK_URL = 'https://rpc-fallback.example';
    mocks.JsonRpcProvider.mockImplementation((url: string) => url === 'https://rpc-fallback.example' ? fallbackProvider : primaryProvider);
    mockVerifiedDatabase();

    await expect(verifyDonationCertificateFinality({
      transactionHash: TRANSACTION_HASH,
      donorUserId: 'user-1',
      expectedProjectId: '1',
      expectedDonorAddress: DONOR_ADDRESS,
      expectedAmountRaw: '1000',
      expectedIsAnonymous: false,
      requestedMode: 'RPC_FINALIZED'
    })).resolves.toMatchObject({ status: 'VERIFIED' });
    expect(primaryProvider.getTransactionReceipt).toHaveBeenCalledTimes(1);
    expect(fallbackProvider.getTransactionReceipt).toHaveBeenCalledTimes(1);
  });

  it('trả BLOCKED INVALID_CONFIGURATION khi RPC không khớp chain ID', async () => {
    const provider = createMockProvider({ getNetwork: vi.fn().mockResolvedValue({ chainId: 1n }) });
    mocks.JsonRpcProvider.mockImplementation(() => provider);

    await expect(verifyDonationCertificateFinality({
      transactionHash: TRANSACTION_HASH,
      donorUserId: 'user-1',
      expectedProjectId: '1',
      expectedDonorAddress: DONOR_ADDRESS,
      expectedAmountRaw: '1000',
      expectedIsAnonymous: false,
      requestedMode: 'RPC_FINALIZED'
    })).resolves.toMatchObject({ status: 'BLOCKED', reasonCode: 'INVALID_CONFIGURATION' });
  });
});
