import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  contractSeatsBootstrapped: vi.fn(),
  contractGetSeats: vi.fn(),
  getBootstrapEvent: vi.fn(),
  createGovernanceSeatUser: vi.fn(),
  countActiveGovernanceSeats: vi.fn(),
  countActiveGovernanceSeatsMissingSlot: vi.fn(),
  findGovernanceSeats: vi.fn(),
  findUserByGovernanceWalletAddress: vi.fn(),
  revokeRefreshSessionsByUserId: vi.fn(),
  suspendGovernanceSeatByWalletAddress: vi.fn(),
  getBlockchainRpcUrl: vi.fn(),
  getNetwork: vi.fn(),
  getTransaction: vi.fn(),
  getTransactionReceipt: vi.fn(),
  findVerifiedGovernanceBootstrapState: vi.fn(),
  upsertVerifiedGovernanceBootstrapState: vi.fn(),
  isGovernanceSeatMigrationLocked: vi.fn()
}));

vi.mock('ethers', () => ({
  Contract: vi.fn(() => ({
    seatsBootstrapped: mocks.contractSeatsBootstrapped,
    getSeats: mocks.contractGetSeats,
    interface: { getEvent: mocks.getBootstrapEvent }
  })),
  JsonRpcProvider: vi.fn(() => ({
    getNetwork: mocks.getNetwork,
    getTransaction: mocks.getTransaction,
    getTransactionReceipt: mocks.getTransactionReceipt
  })),
  isAddress: vi.fn((value: string) => /^0x[a-fA-F0-9]{40}$/.test(value))
}));
vi.mock('../../config/blockchainRpc', () => ({ getBlockchainRpcUrl: mocks.getBlockchainRpcUrl }));
vi.mock('../../models/authModel', () => ({
  countActiveGovernanceSeats: mocks.countActiveGovernanceSeats,
  countActiveGovernanceSeatsMissingSlot: mocks.countActiveGovernanceSeatsMissingSlot,
  createGovernanceSeatUser: mocks.createGovernanceSeatUser,
  findGovernanceSeats: mocks.findGovernanceSeats,
  findUserByGovernanceWalletAddress: mocks.findUserByGovernanceWalletAddress,
  revokeRefreshSessionsByUserId: mocks.revokeRefreshSessionsByUserId,
  suspendGovernanceSeatByWalletAddress: mocks.suspendGovernanceSeatByWalletAddress
}));
vi.mock('../../models/governanceBootstrapStateModel', () => ({
  findVerifiedGovernanceBootstrapState: mocks.findVerifiedGovernanceBootstrapState,
  upsertVerifiedGovernanceBootstrapState: mocks.upsertVerifiedGovernanceBootstrapState
}));
vi.mock('../../models/governanceSeatMigrationStateModel', () => ({
  isGovernanceSeatMigrationLocked: mocks.isGovernanceSeatMigrationLocked
}));

import { confirmGovernanceBootstrap, createGovernanceSeat, suspendGovernanceSeat } from '../../services/governanceSeatService';

const VALID_WALLET = '0x1111111111111111111111111111111111111111';
const originalCommitteeGovernanceAddress = process.env.COMMITTEE_GOVERNANCE_ADDRESS;

/** Tạo bản ghi ghế tối thiểu để service chỉ kiểm tra đúng boundary đang test. */
function createSeatRecord() {
  return {
    id: 'seat-1',
    fullName: 'Ủy viên A',
    role: 'executive_member',
    governanceWalletAddress: VALID_WALLET,
    walletAddress: VALID_WALLET,
    accountStatus: 'ACTIVE',
    lastLoginAt: new Date(0)
  };
}

describe('governanceSeatService on-chain roster lock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.COMMITTEE_GOVERNANCE_ADDRESS = '';
    mocks.getBlockchainRpcUrl.mockReturnValue('https://rpc.example.test');
    mocks.contractSeatsBootstrapped.mockResolvedValue(false);
    mocks.contractGetSeats.mockResolvedValue([[], []]);
    mocks.getBootstrapEvent.mockReturnValue({ topicHash: '0xbootstrap' });
    mocks.findUserByGovernanceWalletAddress.mockResolvedValue(null);
    mocks.countActiveGovernanceSeats.mockResolvedValue(0);
    mocks.countActiveGovernanceSeatsMissingSlot.mockResolvedValue(0);
    mocks.isGovernanceSeatMigrationLocked.mockResolvedValue(false);
    mocks.createGovernanceSeatUser.mockResolvedValue(createSeatRecord());
    mocks.suspendGovernanceSeatByWalletAddress.mockResolvedValue(createSeatRecord());
    mocks.getNetwork.mockResolvedValue({ chainId: 80002n });
    mocks.getTransaction.mockResolvedValue({ to: VALID_WALLET });
    mocks.getTransactionReceipt.mockResolvedValue({ status: 1, logs: [{ address: VALID_WALLET, topics: ['0xbootstrap'] }] });
    mocks.findVerifiedGovernanceBootstrapState.mockResolvedValue(null);
  });

  afterEach(() => {
    if (originalCommitteeGovernanceAddress === undefined) delete process.env.COMMITTEE_GOVERNANCE_ADDRESS;
    else process.env.COMMITTEE_GOVERNANCE_ADDRESS = originalCommitteeGovernanceAddress;
  });

  it('cho phép lập ghế ở giai đoạn 1 khi contract chưa được cấu hình', async () => {
    await expect(createGovernanceSeat({ walletAddress: VALID_WALLET, role: 'executive_member', displayName: 'Ủy viên A' }))
      .resolves.toMatchObject({ walletAddress: VALID_WALLET });
    expect(mocks.contractSeatsBootstrapped).not.toHaveBeenCalled();
    expect(mocks.createGovernanceSeatUser).toHaveBeenCalledOnce();
  });

  it('khóa mutation khi còn ghế ACTIVE legacy chưa có slot để quota không thể bị vượt qua race', async () => {
    mocks.countActiveGovernanceSeatsMissingSlot.mockResolvedValue(3);

    await expect(createGovernanceSeat({ walletAddress: VALID_WALLET, role: 'executive_member', displayName: 'Ủy viên A' }))
      .rejects.toMatchObject({ statusCode: 503, errorCode: 'GOVERNANCE_SEAT_MIGRATION_REQUIRED' });
    expect(mocks.createGovernanceSeatUser).not.toHaveBeenCalled();
  });

  it('khóa mutation xuyên suốt cửa sổ migration dù backfill đã xong nhưng unique index chưa được xác minh', async () => {
    mocks.isGovernanceSeatMigrationLocked.mockResolvedValue(true);

    await expect(createGovernanceSeat({ walletAddress: VALID_WALLET, role: 'executive_member', displayName: 'Ủy viên A' }))
      .rejects.toMatchObject({ statusCode: 503, errorCode: 'GOVERNANCE_SEAT_MIGRATION_REQUIRED' });
    expect(mocks.createGovernanceSeatUser).not.toHaveBeenCalled();
  });

  it('từ chối tạo ghế trực tiếp sau khi contract đã bootstrap', async () => {
    process.env.COMMITTEE_GOVERNANCE_ADDRESS = VALID_WALLET;
    mocks.contractSeatsBootstrapped.mockResolvedValue(true);

    await expect(createGovernanceSeat({ walletAddress: VALID_WALLET, role: 'executive_member', displayName: 'Ủy viên A' }))
      .rejects.toMatchObject({ statusCode: 409, errorCode: 'INVALID_STATUS_TRANSITION' });
    expect(mocks.createGovernanceSeatUser).not.toHaveBeenCalled();
  });

  it('fail-closed khi proof bootstrap đã tồn tại nhưng operator làm mất cấu hình contract', async () => {
    mocks.findVerifiedGovernanceBootstrapState.mockResolvedValue({ transactionHash: `0x${'a'.repeat(64)}` });

    await expect(createGovernanceSeat({ walletAddress: VALID_WALLET, role: 'executive_member', displayName: 'Ủy viên A' }))
      .rejects.toMatchObject({ statusCode: 503, errorCode: 'BLOCKCHAIN_UNAVAILABLE' });
    expect(mocks.createGovernanceSeatUser).not.toHaveBeenCalled();
  });

  it('fail-closed khi không thể kiểm tra contract trước khi tạo ghế', async () => {
    process.env.COMMITTEE_GOVERNANCE_ADDRESS = VALID_WALLET;
    mocks.contractSeatsBootstrapped.mockRejectedValue(new Error('RPC unavailable'));

    await expect(createGovernanceSeat({ walletAddress: VALID_WALLET, role: 'executive_member', displayName: 'Ủy viên A' }))
      .rejects.toMatchObject({ statusCode: 503, errorCode: 'BLOCKCHAIN_UNAVAILABLE' });
    expect(mocks.createGovernanceSeatUser).not.toHaveBeenCalled();
  });

  it('từ chối thu ghế trực tiếp sau bootstrap', async () => {
    process.env.COMMITTEE_GOVERNANCE_ADDRESS = VALID_WALLET;
    mocks.contractSeatsBootstrapped.mockResolvedValue(true);

    await expect(suspendGovernanceSeat(VALID_WALLET))
      .rejects.toMatchObject({ statusCode: 409, errorCode: 'INVALID_STATUS_TRANSITION' });
    expect(mocks.suspendGovernanceSeatByWalletAddress).not.toHaveBeenCalled();
  });

  it('chỉ lưu proof bootstrap sau khi receipt, event và roster trên chain cùng khớp', async () => {
    process.env.COMMITTEE_GOVERNANCE_ADDRESS = VALID_WALLET;
    const seats = [
      { ...createSeatRecord(), id: 'chair', role: 'executive_chair' },
      ...Array.from({ length: 4 }, (_, index) => ({ ...createSeatRecord(), id: `member-${index}`, governanceWalletAddress: `0x${String(index + 2).repeat(40)}`, walletAddress: `0x${String(index + 2).repeat(40)}` }))
    ];
    mocks.findGovernanceSeats.mockResolvedValue(seats);
    mocks.contractSeatsBootstrapped.mockResolvedValue(true);
    mocks.contractGetSeats.mockResolvedValue([
      seats.map(seat => seat.governanceWalletAddress),
      [1n, 2n, 2n, 2n, 2n]
    ]);
    mocks.upsertVerifiedGovernanceBootstrapState.mockResolvedValue({ transactionHash: `0x${'a'.repeat(64)}` });

    await expect(confirmGovernanceBootstrap({ transactionHash: `0x${'a'.repeat(64)}` }))
      .resolves.toMatchObject({ transactionHash: `0x${'a'.repeat(64)}` });

    expect(mocks.upsertVerifiedGovernanceBootstrapState).toHaveBeenCalledWith(expect.objectContaining({
      contractAddress: VALID_WALLET,
      chainId: '80002',
      seats: expect.arrayContaining([expect.objectContaining({ role: 'executive_chair' })])
    }));
  });

  it('không lưu proof khi transaction không phát event bootstrap', async () => {
    process.env.COMMITTEE_GOVERNANCE_ADDRESS = VALID_WALLET;
    mocks.findGovernanceSeats.mockResolvedValue([
      { ...createSeatRecord(), id: 'chair', role: 'executive_chair' },
      ...Array.from({ length: 4 }, (_, index) => ({ ...createSeatRecord(), id: `member-${index}`, governanceWalletAddress: `0x${String(index + 2).repeat(40)}`, walletAddress: `0x${String(index + 2).repeat(40)}` }))
    ]);
    mocks.contractSeatsBootstrapped.mockResolvedValue(true);
    mocks.getTransactionReceipt.mockResolvedValue({ status: 1, logs: [] });

    await expect(confirmGovernanceBootstrap({ transactionHash: `0x${'b'.repeat(64)}` }))
      .rejects.toMatchObject({ errorCode: 'EVENT_NOT_FOUND' });
    expect(mocks.upsertVerifiedGovernanceBootstrapState).not.toHaveBeenCalled();
  });
});
