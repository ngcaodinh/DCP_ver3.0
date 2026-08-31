import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthUser } from '../../models/authModel';
import { ApplicationError } from '../../utils/applicationError';

const DONATION_CONTRACT_ADDRESS = '0x1111111111111111111111111111111111111111' as const;
const CHARITY_TOKEN_ADDRESS = '0x2222222222222222222222222222222222222222' as const;
const SMART_ACCOUNT_ADDRESS = '0x3333333333333333333333333333333333333333' as const;

const mocks = vi.hoisted(() => {
  const donationContract = {
    charityToken: vi.fn(),
    interface: { encodeFunctionData: vi.fn() }
  };
  const charityTokenContract = {
    balanceOf: vi.fn(),
    allowance: vi.fn(),
    interface: { encodeFunctionData: vi.fn() }
  };
  const kernelClient = {
    account: { address: '0x3333333333333333333333333333333333333333' },
    sendTransaction: vi.fn()
  };

  return {
    getLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
    getZeroDevConfig: vi.fn(),
    createKernelClientFromEncryptedOwnerKey: vi.fn(),
    findUserById: vi.fn(),
    updateUser: vi.fn(),
    hasAuditorWalletLock: vi.fn(),
    findProjectByProjectId: vi.fn(),
    createUserNotification: vi.fn(),
    JsonRpcProvider: vi.fn(() => ({})),
    Contract: vi.fn(),
    donationContract,
    charityTokenContract,
    kernelClient
  };
});

vi.mock('../../config/logger', () => ({ getLogger: mocks.getLogger }));
vi.mock('../../config/zeroDev', () => ({ getZeroDevConfig: mocks.getZeroDevConfig }));
vi.mock('../../services/zeroDevService', () => ({
  createKernelClientFromEncryptedOwnerKey: mocks.createKernelClientFromEncryptedOwnerKey
}));
vi.mock('../../models/authModel', () => ({ findUserById: mocks.findUserById, updateUser: mocks.updateUser }));
vi.mock('../../models/auditorStakeGuardModel', () => ({ hasAuditorWalletLock: mocks.hasAuditorWalletLock }));
vi.mock('../../models/projectModel', () => ({ findProjectByProjectId: mocks.findProjectByProjectId }));
vi.mock('../../services/notificationService', () => ({ createUserNotification: mocks.createUserNotification }));
vi.mock('../../repositories/donationRepository', () => ({
  findDonationHistoryByProjectId: vi.fn(),
  findDonationSummaryByProjectId: vi.fn(),
  findPublicCampaignByProjectId: vi.fn(),
  findPublicCampaigns: vi.fn(),
  findPublicDonorListPaginated: vi.fn(),
  getLatestIndexedBlockNumberFromRepository: vi.fn(),
  upsertDonationRecordByTransactionHash: vi.fn()
}));
vi.mock('../../services/rankingIncrementalService', () => ({ applyDonationToMetrics: vi.fn() }));
vi.mock('../../services/rankingCacheService', () => ({ invalidateRankingCache: vi.fn() }));
vi.mock('../../repositories/guestWalletSessionRepository', () => ({
  findGuestWalletSessionByWalletAddress: vi.fn(),
  incrementSessionDonationCounters: vi.fn()
}));
vi.mock('../../repositories/guestDonationRiskRepository', () => ({ findGuestDonationRiskByWalletAddress: vi.fn() }));
vi.mock('../../repositories/anonymousDonationAuditRepository', () => ({ updateAuditByTransactionHash: vi.fn() }));
vi.mock('../../utils/donationMetrics', () => ({ recordDonationMetrics: vi.fn() }));
vi.mock('../../services/event-logger.service', () => ({ logEvent: vi.fn() }));
vi.mock('ethers', () => ({
  ethers: {
    JsonRpcProvider: mocks.JsonRpcProvider,
    Contract: mocks.Contract
  }
}));

import { executeOneClickDonation } from '../../services/donationService';

function createAuthenticatedUser(): AuthUser {
  return {
    id: 'user-001',
    walletAddress: SMART_ACCOUNT_ADDRESS,
    smartAccountOwnerEncryptedPrivateKey: 'encrypted-owner-key',
    correlationId: 'correlation-001'
  } as AuthUser;
}

describe('executeOneClickDonation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DONATION_RANKING_CONTRACT_ADDRESS = DONATION_CONTRACT_ADDRESS;

    mocks.getZeroDevConfig.mockReturnValue({
      projectId: 'test-project',
      rpcUrl: 'https://rpc.test',
      bundlerUrl: 'https://bundler.test',
      paymasterUrl: 'https://paymaster.test',
      entryPointAddress: '0x0000000071727De22E5E9d8BAf0edAc6f37da032'
    });
    mocks.findUserById.mockResolvedValue(createAuthenticatedUser());
    mocks.hasAuditorWalletLock.mockResolvedValue(false);
    mocks.createKernelClientFromEncryptedOwnerKey.mockResolvedValue(mocks.kernelClient);
    mocks.donationContract.charityToken.mockResolvedValue(CHARITY_TOKEN_ADDRESS);
    mocks.donationContract.interface.encodeFunctionData.mockReturnValue('0xd0nate');
    mocks.charityTokenContract.balanceOf.mockResolvedValue(100n);
    mocks.charityTokenContract.allowance.mockResolvedValue(100n);
    mocks.charityTokenContract.interface.encodeFunctionData.mockReturnValue('0xapprove');
    mocks.Contract.mockImplementation((address: string) => (
      address.toLowerCase() === DONATION_CONTRACT_ADDRESS.toLowerCase()
        ? mocks.donationContract
        : mocks.charityTokenContract
    ));
    mocks.kernelClient.sendTransaction.mockResolvedValue('0xtransactionhash');
    mocks.findProjectByProjectId.mockResolvedValue(null);
  });

  it('từ chối số tiền thập phân trước khi đọc tài khoản hoặc gửi giao dịch', async () => {
    await expect(executeOneClickDonation('user-001', '1787243072147450589', 1.5, false))
      .rejects.toMatchObject({ statusCode: 400, errorCode: 'VALIDATION_ERROR' });

    expect(mocks.findUserById).not.toHaveBeenCalled();
    expect(mocks.kernelClient.sendTransaction).not.toHaveBeenCalled();
  });

  it('giữ nguyên lỗi khôi phục khóa Smart Account để client không nhận 500 chung chung', async () => {
    mocks.createKernelClientFromEncryptedOwnerKey.mockRejectedValue(new ApplicationError(
      'Không thể khôi phục khóa ký Smart Account.',
      409,
      'DECRYPTION_ERROR'
    ));

    await expect(executeOneClickDonation('user-001', '1787243072147450589', 10, false))
      .rejects.toMatchObject({ statusCode: 409, errorCode: 'DECRYPTION_ERROR' });
  });

  it('phân loại lỗi RPC khi đọc token thành BLOCKCHAIN_UNAVAILABLE', async () => {
    mocks.donationContract.charityToken.mockRejectedValue(new Error('RPC unavailable'));

    await expect(executeOneClickDonation('user-001', '1787243072147450589', 10, false))
      .rejects.toMatchObject({ statusCode: 502, errorCode: 'BLOCKCHAIN_UNAVAILABLE' });

    expect(mocks.kernelClient.sendTransaction).not.toHaveBeenCalled();
  });

  it('phân loại lỗi relay không xác định thành TRANSACTION_FAILED thay vì 500 chung chung', async () => {
    mocks.kernelClient.sendTransaction.mockRejectedValue(new Error('bundler unavailable'));

    await expect(executeOneClickDonation('user-001', '1787243072147450589', 10, false))
      .rejects.toMatchObject({ statusCode: 502, errorCode: 'TRANSACTION_FAILED' });
  });

  it('trả transaction hash dù tác vụ thông báo hậu xử lý thất bại', async () => {
    mocks.findProjectByProjectId.mockRejectedValue(new Error('notification storage unavailable'));

    await expect(executeOneClickDonation('user-001', '1787243072147450589', 10, false))
      .resolves.toMatchObject({ transactionHash: '0xtransactionhash', isAnonymous: false });

    await Promise.resolve();
    expect(mocks.findProjectByProjectId).toHaveBeenCalledWith('1787243072147450589');
  });
});
