import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectRecord } from '../../models/projectModel';

const {
  mockCountActiveProjects,
  mockCreateProjectOnChain,
  mockFindProjectById,
  mockFindUserById,
  mockGetNetwork,
  mockGetProjectSnapshot,
  mockHasRole,
  mockParseError,
  mockProjectManagerRole,
  mockSetProjectStatus,
  mockUpdateProject
} = vi.hoisted(() => ({
  mockCountActiveProjects: vi.fn(),
  mockCreateProjectOnChain: vi.fn(),
  mockFindProjectById: vi.fn(),
  mockFindUserById: vi.fn(),
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
  findUserById: mockFindUserById
}));

vi.mock('../../models/organizationKycModel', () => ({
  findSubmissionsByOrganizationId: vi.fn()
}));

vi.mock('../../repositories/projectRepository', () => ({
  countActiveProjectsByOrganizationIdFromRepository: mockCountActiveProjects,
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

import { reviewProjectByReviewer } from '../../services/projectService';

const blockchainEnvironmentVariableNames = [
  'BLOCKCHAIN_RPC_URL',
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
    process.env.DONATION_RANKING_CONTRACT_ADDRESS = '0x1234567890123456789012345678901234567890';
    process.env.PROJECT_MANAGER_PRIVATE_KEY = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

    mockFindUserById.mockResolvedValue({ id: 'reviewer-1', role: 'regulatory' });
    mockFindProjectById.mockResolvedValue(createPendingProjectFixture());
    mockCountActiveProjects.mockResolvedValue(0);
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

  it('activates a project that already exists as Draft on-chain', async () => {
    mockGetProjectSnapshot.mockResolvedValue({ exists: true, projectStatus: 0n });

    await expect(reviewProjectByReviewer('reviewer-1', '202608180000000001', 'APPROVE')).resolves.toMatchObject({
      status: 'ACTIVE'
    });

    expect(mockCreateProjectOnChain).not.toHaveBeenCalled();
    expect(mockSetProjectStatus).toHaveBeenCalledWith(202608180000000001n, 1);
  });

  it('self-heals only a verified ProjectNotFound error for legacy projects', async () => {
    mockGetProjectSnapshot.mockRejectedValue({ data: '0xproject-not-found' });
    mockParseError.mockReturnValue({ name: 'ProjectNotFound' });

    await reviewProjectByReviewer('reviewer-1', '202608180000000001', 'APPROVE');

    expect(mockCreateProjectOnChain).toHaveBeenCalledWith(202608180000000001n);
    expect(mockSetProjectStatus).toHaveBeenCalledWith(202608180000000001n, 1);
  });

  it('rolls the database status back when blockchain state cannot be read', async () => {
    mockGetProjectSnapshot.mockRejectedValue(new Error('RPC unavailable'));

    await expect(reviewProjectByReviewer('reviewer-1', '202608180000000001', 'APPROVE')).rejects.toMatchObject({
      errorCode: 'BLOCKCHAIN_UNAVAILABLE',
      statusCode: 502
    });

    expect(mockCreateProjectOnChain).not.toHaveBeenCalled();
    expect(mockUpdateProject).toHaveBeenCalledTimes(2);
    expect(mockUpdateProject).toHaveBeenLastCalledWith(
      '202608180000000001',
      expect.objectContaining({ status: 'PENDING_APPROVAL', reviewedAt: null, reviewedBy: null })
    );
  });

  it('returns a typed availability error when the RPC provider cannot connect', async () => {
    mockGetNetwork.mockRejectedValue(new Error('RPC unavailable'));

    await expect(reviewProjectByReviewer('reviewer-1', '202608180000000001', 'APPROVE')).rejects.toMatchObject({
      errorCode: 'BLOCKCHAIN_UNAVAILABLE',
      statusCode: 502
    });

    expect(mockGetProjectSnapshot).not.toHaveBeenCalled();
    expect(mockUpdateProject).toHaveBeenCalledTimes(2);
  });
});
