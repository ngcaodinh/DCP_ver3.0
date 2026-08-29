import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  countActiveGovernanceSeats: vi.fn(),
  countActiveGovernanceSeatsMissingSlot: vi.fn(),
  createGovernanceSeatUser: vi.fn(),
  findUserByGovernanceWalletAddress: vi.fn(),
  revokeRefreshSessionsByUserId: vi.fn(),
  suspendGovernanceSeatByWalletAddress: vi.fn(),
  findVerifiedGovernanceBootstrapState: vi.fn(),
  isGovernanceSeatMigrationLocked: vi.fn()
}));

vi.mock('ethers', () => ({
  Contract: vi.fn(),
  JsonRpcProvider: vi.fn(),
  isAddress: vi.fn((value: string) => /^0x[a-fA-F0-9]{40}$/.test(value))
}));
vi.mock('../../config/blockchainRpc', () => ({ getBlockchainRpcUrl: vi.fn(() => '') }));
vi.mock('../../models/authModel', () => ({
  countActiveGovernanceSeats: mocks.countActiveGovernanceSeats,
  countActiveGovernanceSeatsMissingSlot: mocks.countActiveGovernanceSeatsMissingSlot,
  createGovernanceSeatUser: mocks.createGovernanceSeatUser,
  findGovernanceSeats: vi.fn(),
  findUserByGovernanceWalletAddress: mocks.findUserByGovernanceWalletAddress,
  revokeRefreshSessionsByUserId: mocks.revokeRefreshSessionsByUserId,
  suspendGovernanceSeatByWalletAddress: mocks.suspendGovernanceSeatByWalletAddress,
  upsertGovernanceSeatFromChain: vi.fn()
}));
vi.mock('../../models/governanceBootstrapStateModel', () => ({
  findVerifiedGovernanceBootstrapState: mocks.findVerifiedGovernanceBootstrapState,
  upsertVerifiedGovernanceBootstrapState: vi.fn()
}));
vi.mock('../../models/governanceSeatMigrationStateModel', () => ({
  isGovernanceSeatMigrationLocked: mocks.isGovernanceSeatMigrationLocked
}));

import { createGovernanceSeat, suspendGovernanceSeat } from '../../services/governanceSeatService';

const VALID_WALLET = '0x1111111111111111111111111111111111111111';
const MIXED_CASE_WALLET = `0xAb${'1'.repeat(38)}`;
const originalCommitteeGovernanceAddress = process.env.COMMITTEE_GOVERNANCE_ADDRESS;

/** Tạo bản ghi ghế đủ trường DTO và trường authVersion để kiểm tra revoke JWT. */
function createSeatRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'seat-1',
    fullName: 'Ủy viên A',
    role: 'executive_member',
    walletAddress: VALID_WALLET,
    governanceWalletAddress: VALID_WALLET,
    accountStatus: 'ACTIVE',
    authVersion: 1,
    lastLoginAt: null,
    ...overrides
  };
}

describe('committee seat service invariants', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.COMMITTEE_GOVERNANCE_ADDRESS = '';
    mocks.countActiveGovernanceSeatsMissingSlot.mockResolvedValue(0);
    mocks.isGovernanceSeatMigrationLocked.mockResolvedValue(false);
    mocks.findVerifiedGovernanceBootstrapState.mockResolvedValue(null);
    mocks.findUserByGovernanceWalletAddress.mockResolvedValue(null);
    mocks.countActiveGovernanceSeats.mockResolvedValue(0);
    mocks.createGovernanceSeatUser.mockImplementation(async (user: Record<string, unknown>) => user);
    mocks.suspendGovernanceSeatByWalletAddress.mockResolvedValue(createSeatRecord({ accountStatus: 'SUSPENDED', authVersion: 2 }));
  });

  afterEach(() => {
    if (originalCommitteeGovernanceAddress === undefined) delete process.env.COMMITTEE_GOVERNANCE_ADDRESS;
    else process.env.COMMITTEE_GOVERNANCE_ADDRESS = originalCommitteeGovernanceAddress;
  });

  it('từ chối địa chỉ EVM không hợp lệ ở service boundary', async () => {
    await expect(createGovernanceSeat({ walletAddress: '0xinvalid', role: 'executive_member', displayName: 'Member' }))
      .rejects.toMatchObject({ statusCode: 400, errorCode: 'VALIDATION_ERROR' });
    expect(mocks.createGovernanceSeatUser).not.toHaveBeenCalled();
  });

  it('từ chối wallet đã được gán trước đó bất kể role mới', async () => {
    mocks.findUserByGovernanceWalletAddress.mockResolvedValue(createSeatRecord());

    await expect(createGovernanceSeat({ walletAddress: VALID_WALLET, role: 'executive_member', displayName: 'Member' }))
      .rejects.toMatchObject({ statusCode: 409, errorCode: 'CONFLICT' });
    expect(mocks.createGovernanceSeatUser).not.toHaveBeenCalled();
  });

  it('giới hạn một Chair và từ chối Chair thứ hai', async () => {
    mocks.countActiveGovernanceSeats.mockResolvedValue(1);

    await expect(createGovernanceSeat({ walletAddress: VALID_WALLET, role: 'executive_chair', displayName: 'Chair 2' }))
      .rejects.toMatchObject({ statusCode: 409, errorCode: 'CONFLICT' });
  });

  it('giới hạn bốn Member và từ chối Member thứ năm', async () => {
    mocks.countActiveGovernanceSeats.mockResolvedValue(4);

    await expect(createGovernanceSeat({ walletAddress: VALID_WALLET, role: 'executive_member', displayName: 'Member 5' }))
      .rejects.toMatchObject({ statusCode: 409, errorCode: 'CONFLICT' });
  });

  it('normalize wallet không phân biệt hoa thường trước khi kiểm tra và lưu', async () => {
    await expect(createGovernanceSeat({ walletAddress: MIXED_CASE_WALLET, role: 'executive_member', displayName: 'Member' }))
      .resolves.toMatchObject({ walletAddress: MIXED_CASE_WALLET.toLowerCase() });
    expect(mocks.findUserByGovernanceWalletAddress).toHaveBeenCalledWith(MIXED_CASE_WALLET.toLowerCase());
    expect(mocks.createGovernanceSeatUser).toHaveBeenCalledWith(
      expect.objectContaining({ walletAddress: MIXED_CASE_WALLET.toLowerCase(), governanceWalletAddress: MIXED_CASE_WALLET.toLowerCase() }),
      1
    );
  });

  it('suspend seat bằng update atomic, tăng authVersion và giữ lại user để bảo toàn lịch sử', async () => {
    const suspendedSeat = createSeatRecord({ accountStatus: 'SUSPENDED', authVersion: 2 });
    mocks.suspendGovernanceSeatByWalletAddress.mockResolvedValue(suspendedSeat);

    await expect(suspendGovernanceSeat(MIXED_CASE_WALLET)).resolves.toMatchObject({
      accountStatus: 'SUSPENDED',
      walletAddress: VALID_WALLET
    });
    expect(mocks.suspendGovernanceSeatByWalletAddress).toHaveBeenCalledWith(MIXED_CASE_WALLET.toLowerCase());
    expect(mocks.revokeRefreshSessionsByUserId).toHaveBeenCalledWith('seat-1');
    expect(mocks.suspendGovernanceSeatByWalletAddress).toHaveBeenCalledOnce();
  });
});
