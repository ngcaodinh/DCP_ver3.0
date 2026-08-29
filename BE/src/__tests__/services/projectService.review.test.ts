import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectRecord } from '../../models/projectModel';

const {
  mockCreateProjectOnChain,
  mockFindProjectById,
  mockFindUserById,
  mockFindUsersByRole,
  mockCountActiveAuditors,
  mockCreateUserNotification,
  mockGetNetwork,
  mockGetProjectSnapshot,
  mockHasRole,
  mockParseError,
  mockProjectManagerRole,
  mockSetProjectStatus,
  mockUpdateProject
} = vi.hoisted(() => ({
  mockCreateProjectOnChain: vi.fn(),
  mockFindProjectById: vi.fn(),
  mockFindUserById: vi.fn(),
  mockFindUsersByRole: vi.fn(),
  mockCountActiveAuditors: vi.fn(),
  mockCreateUserNotification: vi.fn(),
  mockGetNetwork: vi.fn(),
  mockGetProjectSnapshot: vi.fn(),
  mockHasRole: vi.fn(),
  mockParseError: vi.fn(),
  mockProjectManagerRole: vi.fn(),
  mockSetProjectStatus: vi.fn(),
  mockUpdateProject: vi.fn()
}));

const donationRankingContractMock = {
  createProject: mockCreateProjectOnChain,
  getProjectSnapshot: mockGetProjectSnapshot,
  hasRole: mockHasRole,
  interface: { parseError: mockParseError },
  projectManagerRole: mockProjectManagerRole,
  setProjectStatus: mockSetProjectStatus
};

vi.mock('../../config/logger', () => ({
  getLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() })
}));

vi.mock('../../models/authModel', () => ({
  findUserById: mockFindUserById,
  findUsersByRole: mockFindUsersByRole,
  countActiveAuditors: mockCountActiveAuditors
}));

vi.mock('../../models/organizationKycModel', () => ({
  findSubmissionsByOrganizationId: vi.fn()
}));

vi.mock('../../services/notificationService', () => ({ createUserNotification: mockCreateUserNotification }));

vi.mock('../../repositories/projectRepository', () => ({
  createProject: vi.fn(),
  findProjectById: mockFindProjectById,
  findProjectByOrganizationAndName: vi.fn(),
  findProjectsByOrganizationIdFromRepository: vi.fn(),
  findProjectsByStatusFromRepository: vi.fn(),
  findProjectsByStatusListFromRepository: vi.fn(),
  findPublicSupportProjectDetailFromRepository: vi.fn(),
  findPublicSupportProjectsFromRepository: vi.fn(),
  updateProject: mockUpdateProject
}));

vi.mock('../../repositories/donationRepository', () => ({
  findLatestDonationTimestampByProjectIdFromRepository: vi.fn()
}));

vi.mock('../../utils/inMemoryCache', () => ({
  createInMemoryCache: vi.fn(() => ({ deleteByKey: vi.fn(), get: vi.fn(), set: vi.fn() }))
}));

vi.mock('ethers', () => ({
  ethers: {
    Contract: vi.fn(() => donationRankingContractMock),
    JsonRpcProvider: vi.fn(() => ({ getNetwork: mockGetNetwork })),
    Wallet: vi.fn(() => ({ address: '0x1234567890123456789012345678901234567890' }))
  }
}));

import { closeProjectOnBlockchain, reviewProjectByReviewer } from '../../services/projectService';

const blockchainEnvironmentVariableNames = [
  'BLOCKCHAIN_RPC_URL',
  'BLOCKCHAIN_CHAIN_ID',
  'DONATION_RANKING_CONTRACT_ADDRESS',
  'PROJECT_MANAGER_PRIVATE_KEY'
] as const;

type BlockchainEnvironmentVariableName = (typeof blockchainEnvironmentVariableNames)[number];

/** Tạo dữ liệu dự án đang chờ duyệt để kiểm tra chính xác luồng chuyển ACTIVE. */
function createPendingProjectFixture(): ProjectRecord {
  const createdAt = new Date('2026-08-18T00:00:00.000Z');
  return {
    projectId: '202608180000000001',
    organizationId: 'organization-1',
    name: 'Hỗ trợ vùng lũ',
    description: 'Cung cấp nhu yếu phẩm cho người dân vùng lũ.',
    goalAmount: 50_000_000,
    deadline: new Date('2026-12-31T00:00:00.000Z'),
    status: 'PENDING_APPROVAL',
    evidenceCids: [],
    evidenceFiles: [],
    submittedAt: createdAt,
    reviewedAt: null,
    reviewedBy: null,
    rejectionReason: null,
    createdAt,
    updatedAt: createdAt
  };
}

describe('project service review on-chain synchronization', () => {
  let originalBlockchainEnvironment: Record<BlockchainEnvironmentVariableName, string | undefined>;

  beforeEach(() => {
    vi.clearAllMocks();
    originalBlockchainEnvironment = Object.fromEntries(
      blockchainEnvironmentVariableNames.map(variableName => [variableName, process.env[variableName]])
    ) as Record<BlockchainEnvironmentVariableName, string | undefined>;
    process.env.BLOCKCHAIN_RPC_URL = 'http://rpc.test';
    delete process.env.BLOCKCHAIN_CHAIN_ID;
    process.env.DONATION_RANKING_CONTRACT_ADDRESS = '0x1234567890123456789012345678901234567890';
    process.env.PROJECT_MANAGER_PRIVATE_KEY = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

    mockFindUserById.mockResolvedValue({ id: 'reviewer-1', role: 'regulatory' });
    mockFindUsersByRole.mockResolvedValue([{ id: 'admin-1', role: 'admin' }]);
    mockCountActiveAuditors.mockResolvedValue(1);
    mockCreateUserNotification.mockResolvedValue(null);
    mockFindProjectById.mockResolvedValue(createPendingProjectFixture());
    mockGetNetwork.mockResolvedValue({ chainId: 80002n });
    mockProjectManagerRole.mockResolvedValue('PROJECT_MANAGER_ROLE');
    mockHasRole.mockResolvedValue(true);
    mockSetProjectStatus.mockResolvedValue({ hash: '0xactivate', wait: vi.fn().mockResolvedValue(undefined) });
    mockCreateProjectOnChain.mockResolvedValue({ hash: '0xcreate', wait: vi.fn().mockResolvedValue(undefined) });
    mockUpdateProject.mockImplementation(async (_projectId: string, payload: Partial<ProjectRecord>) => ({
      ...createPendingProjectFixture(),
      ...payload
    }));
  });

  afterEach(() => {
    blockchainEnvironmentVariableNames.forEach(variableName => {
      const originalValue = originalBlockchainEnvironment[variableName];
      if (originalValue === undefined) {
        delete process.env[variableName];
        return;
      }

      process.env[variableName] = originalValue;
    });
  });

  it('lists an approved project for the challenge window without touching blockchain', async () => {
    mockGetProjectSnapshot.mockResolvedValue({ exists: true, projectStatus: 0n });

    await expect(reviewProjectByReviewer('reviewer-1', '202608180000000001', 'APPROVE')).resolves.toMatchObject({
      status: 'PENDING_ACTIVATION'
    });

    expect(mockCreateProjectOnChain).not.toHaveBeenCalled();
    expect(mockSetProjectStatus).not.toHaveBeenCalled();
    expect(mockUpdateProject).toHaveBeenCalledWith('202608180000000001', expect.objectContaining({ status: 'PENDING_ACTIVATION', listedAt: expect.any(Date), activationEligibleAt: expect.any(Date) }));
  });

  it('does not perform legacy on-chain recovery during regulatory approval', async () => {
    mockGetProjectSnapshot.mockRejectedValue({ data: '0xproject-not-found' });
    mockParseError.mockReturnValue({ name: 'ProjectNotFound' });

    await reviewProjectByReviewer('reviewer-1', '202608180000000001', 'APPROVE');

    expect(mockCreateProjectOnChain).not.toHaveBeenCalled();
    expect(mockSetProjectStatus).not.toHaveBeenCalled();
  });

  it('does not depend on blockchain availability while listing a project', async () => {
    mockGetProjectSnapshot.mockRejectedValue(new Error('RPC unavailable'));

    await expect(reviewProjectByReviewer('reviewer-1', '202608180000000001', 'APPROVE')).resolves.toMatchObject({ status: 'PENDING_ACTIVATION' });

    expect(mockCreateProjectOnChain).not.toHaveBeenCalled();
    expect(mockUpdateProject).toHaveBeenCalledTimes(1);
  });

  it('reports the no-auditor operational warning without blocking listing', async () => {
    mockCountActiveAuditors.mockResolvedValue(0);

    await expect(reviewProjectByReviewer('reviewer-1', '202608180000000001', 'APPROVE')).resolves.toMatchObject({
      status: 'PENDING_ACTIVATION',
      warning: 'NO_ACTIVE_AUDITOR'
    });

    expect(mockGetProjectSnapshot).not.toHaveBeenCalled();
    expect(mockUpdateProject).toHaveBeenCalledTimes(1);
    expect(mockCreateUserNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: 'admin-1', notificationType: 'SYSTEM', metadata: { projectId: '202608180000000001', warning: 'NO_ACTIVE_AUDITOR' } }));
  });

  it('rejects an admin because only regulatory may review projects', async () => {
    mockFindUserById.mockResolvedValue({ id: 'admin-1', role: 'admin' });

    await expect(reviewProjectByReviewer('admin-1', '202608180000000001', 'APPROVE')).rejects.toMatchObject({
      errorCode: 'FORBIDDEN',
      statusCode: 403
    });

    expect(mockUpdateProject).not.toHaveBeenCalled();
  });
});

describe('project service close on-chain synchronization', () => {
  let originalBlockchainEnvironment: Record<BlockchainEnvironmentVariableName, string | undefined>;

  beforeEach(() => {
    vi.clearAllMocks();
    originalBlockchainEnvironment = Object.fromEntries(
      blockchainEnvironmentVariableNames.map(variableName => [variableName, process.env[variableName]])
    ) as Record<BlockchainEnvironmentVariableName, string | undefined>;
    process.env.BLOCKCHAIN_RPC_URL = 'http://rpc.test';
    process.env.DONATION_RANKING_CONTRACT_ADDRESS = '0x1234567890123456789012345678901234567890';
    process.env.PROJECT_MANAGER_PRIVATE_KEY = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    mockGetNetwork.mockResolvedValue({ chainId: 80002n });
    mockProjectManagerRole.mockResolvedValue('PROJECT_MANAGER_ROLE');
    mockHasRole.mockResolvedValue(true);
    mockSetProjectStatus.mockResolvedValue({ hash: '0xclose', wait: vi.fn().mockResolvedValue(undefined) });
  });

  afterEach(() => {
    blockchainEnvironmentVariableNames.forEach(variableName => {
      const originalValue = originalBlockchainEnvironment[variableName];
      if (originalValue === undefined) delete process.env[variableName];
      else process.env[variableName] = originalValue;
    });
  });

  it('đóng duy nhất dự án Active/Completed bằng transition Closed trên chain', async () => {
    mockGetProjectSnapshot.mockResolvedValue({ exists: true, projectStatus: 1n });

    await expect(closeProjectOnBlockchain('202608180000000001')).resolves.toBeUndefined();

    expect(mockSetProjectStatus).toHaveBeenCalledWith(202608180000000001n, 3);
  });

  it('idempotent khi dự án đã Closed, không gửi giao dịch mới', async () => {
    mockGetProjectSnapshot.mockResolvedValue({ exists: true, projectStatus: 3n });

    await expect(closeProjectOnBlockchain('202608180000000001')).resolves.toBeUndefined();

    expect(mockSetProjectStatus).not.toHaveBeenCalled();
  });

  it('từ chối draft hoặc project chưa tồn tại thay vì tự tạo và khóa dữ liệu sai', async () => {
    mockGetProjectSnapshot.mockResolvedValueOnce({ exists: true, projectStatus: 0n }).mockResolvedValueOnce({ exists: false, projectStatus: 0n });

    await expect(closeProjectOnBlockchain('202608180000000001')).rejects.toMatchObject({ errorCode: 'INVALID_STATUS_TRANSITION', statusCode: 409 });
    await expect(closeProjectOnBlockchain('202608180000000002')).rejects.toMatchObject({ errorCode: 'INVALID_STATUS_TRANSITION', statusCode: 409 });

    expect(mockCreateProjectOnChain).not.toHaveBeenCalled();
    expect(mockSetProjectStatus).not.toHaveBeenCalled();
  });

  it('fail-closed trước RPC khi projectId không phải số hoặc không đọc được snapshot', async () => {
    await expect(closeProjectOnBlockchain('project-id')).rejects.toMatchObject({ errorCode: 'VALIDATION_ERROR', statusCode: 400 });
    expect(mockGetNetwork).not.toHaveBeenCalled();

    mockGetProjectSnapshot.mockRejectedValue(new Error('RPC unavailable'));
    await expect(closeProjectOnBlockchain('202608180000000001')).rejects.toMatchObject({ errorCode: 'BLOCKCHAIN_UNAVAILABLE', statusCode: 502 });
    expect(mockSetProjectStatus).not.toHaveBeenCalled();
  });

  it('không gửi giao dịch khi RPC network lỗi, sai chain hoặc giao dịch đóng revert', async () => {
    mockGetNetwork.mockRejectedValueOnce(new Error('network unavailable'));

    await expect(closeProjectOnBlockchain('202608180000000001')).rejects.toMatchObject({ errorCode: 'BLOCKCHAIN_UNAVAILABLE', statusCode: 502 });
    expect(mockGetProjectSnapshot).not.toHaveBeenCalled();

    process.env.BLOCKCHAIN_CHAIN_ID = '1';
    mockGetNetwork.mockResolvedValueOnce({ chainId: 80002n });
    await expect(closeProjectOnBlockchain('202608180000000001')).rejects.toMatchObject({ errorCode: 'CHAIN_MISMATCH', statusCode: 400 });
    expect(mockGetProjectSnapshot).not.toHaveBeenCalled();

    delete process.env.BLOCKCHAIN_CHAIN_ID;
    mockGetProjectSnapshot.mockResolvedValueOnce({ exists: true, projectStatus: 2n });
    mockSetProjectStatus.mockRejectedValueOnce(new Error('transaction reverted'));
    await expect(closeProjectOnBlockchain('202608180000000001')).rejects.toMatchObject({ errorCode: 'BLOCKCHAIN_UNAVAILABLE', statusCode: 502 });
  });
});
