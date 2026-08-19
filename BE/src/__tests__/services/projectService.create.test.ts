import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectRecord } from '../../models/projectModel';
import type { CreateProjectDataAccessPayload } from '../../repositories/projectRepository';

const {
  mockCreateProject,
  mockFindProjectByOrganizationAndName,
  mockFindSubmissionsByOrganizationId,
  mockFindUserById
} = vi.hoisted(() => ({
  mockCreateProject: vi.fn(),
  mockFindProjectByOrganizationAndName: vi.fn(),
  mockFindSubmissionsByOrganizationId: vi.fn(),
  mockFindUserById: vi.fn()
}));

vi.mock('../../config/logger', () => ({
  getLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() })
}));

vi.mock('../../models/authModel', () => ({
  findUserById: mockFindUserById
}));

vi.mock('../../models/organizationKycModel', () => ({
  findSubmissionsByOrganizationId: mockFindSubmissionsByOrganizationId
}));

vi.mock('../../repositories/projectRepository', () => ({
  countActiveProjectsByOrganizationIdFromRepository: vi.fn(),
  createProject: mockCreateProject,
  findProjectById: vi.fn(),
  findProjectByOrganizationAndName: mockFindProjectByOrganizationAndName,
  findProjectsByOrganizationIdFromRepository: vi.fn(),
  findProjectsByStatusFromRepository: vi.fn(),
  findProjectsByStatusListFromRepository: vi.fn(),
  findPublicSupportProjectDetailFromRepository: vi.fn(),
  findPublicSupportProjectsFromRepository: vi.fn(),
  updateProject: vi.fn()
}));

vi.mock('../../repositories/donationRepository', () => ({
  findLatestDonationTimestampByProjectIdFromRepository: vi.fn()
}));

vi.mock('../../utils/inMemoryCache', () => ({
  createInMemoryCache: vi.fn(() => ({ deleteByKey: vi.fn(), get: vi.fn(), set: vi.fn() }))
}));

import { createProjectForOrganization } from '../../services/projectService';

const blockchainEnvironmentVariableNames = [
  'BLOCKCHAIN_RPC_URL',
  'DONATION_RANKING_CONTRACT_ADDRESS',
  'DONATION_RANKING_ADDRESS',
  'PROJECT_MANAGER_PRIVATE_KEY',
  'DONATION_RELAYER_PRIVATE_KEY'
] as const;

type BlockchainEnvironmentVariableName = (typeof blockchainEnvironmentVariableNames)[number];

const validCreateProjectPayload = {
  name: 'Hỗ trợ vùng lũ',
  description: 'Cung cấp nhu yếu phẩm cho các hộ dân bị ảnh hưởng bởi lũ lụt.',
  goalAmount: 50_000_000,
  deadline: '2026-12-31T00:00:00.000Z',
  evidenceCids: ['cid-1', 'cid-2', 'cid-3']
};

/** Tạo user tổ chức hợp lệ để kiểm thử riêng nghiệp vụ tạo bản nháp. */
function createOrganizationUserFixture() {
  return {
    id: 'organization-1',
    email: 'organization@example.com',
    fullName: 'Tổ chức kiểm thử',
    role: 'organizations',
    walletAddress: '0x1234567890123456789012345678901234567890',
    smartAccountOwnerAddress: null,
    smartAccountOwnerEncryptedPrivateKey: null,
    socialProvider: 'google',
    socialAccountId: 'google-organization-1',
    isEmailVerified: true,
    accountStatus: 'ACTIVE' as const,
    organizationName: 'Tổ chức kiểm thử',
    legalRegistrationNumber: 'REG-001',
    isSybil: false,
    lastLoginAt: new Date('2026-08-18T00:00:00.000Z'),
    lastLoginIp: null,
    lastLoginUserAgent: null,
    correlationId: 'correlation-1',
    fcmDeviceToken: null,
    phoneNumber: null,
    authVersion: 1
  };
}

describe('project service create', () => {
  let originalBlockchainEnvironment: Record<BlockchainEnvironmentVariableName, string | undefined>;

  beforeEach(() => {
    vi.clearAllMocks();
    originalBlockchainEnvironment = Object.fromEntries(
      blockchainEnvironmentVariableNames.map(variableName => [variableName, process.env[variableName]])
    ) as Record<BlockchainEnvironmentVariableName, string | undefined>;
    blockchainEnvironmentVariableNames.forEach(variableName => delete process.env[variableName]);

    mockFindUserById.mockResolvedValue(createOrganizationUserFixture());
    mockFindSubmissionsByOrganizationId.mockResolvedValue([{ status: 'APPROVED' }]);
    mockFindProjectByOrganizationAndName.mockResolvedValue(null);
    mockCreateProject.mockImplementation(async (projectPayload: CreateProjectDataAccessPayload): Promise<ProjectRecord> => projectPayload);
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

  it('creates a DRAFT when blockchain synchronization is not configured', async () => {
    const result = await createProjectForOrganization('organization-1', validCreateProjectPayload);

    expect(result).toMatchObject({
      organizationId: 'organization-1',
      name: 'Hỗ trợ vùng lũ',
      status: 'DRAFT'
    });
    expect(mockCreateProject).toHaveBeenCalledOnce();
    expect(mockCreateProject).toHaveBeenCalledWith(expect.objectContaining({ status: 'DRAFT' }));
  });

  it('rejects organizations without an approved beneficiary bank account', async () => {
    mockFindSubmissionsByOrganizationId.mockResolvedValue([{ status: 'PENDING' }]);

    await expect(createProjectForOrganization('organization-1', validCreateProjectPayload)).rejects.toMatchObject({
      errorCode: 'FORBIDDEN',
      statusCode: 403
    });
    expect(mockCreateProject).not.toHaveBeenCalled();
  });

  it('rejects a duplicate project name within the same organization', async () => {
    mockFindProjectByOrganizationAndName.mockResolvedValue({ projectId: 'existing-project' });

    await expect(createProjectForOrganization('organization-1', validCreateProjectPayload)).rejects.toMatchObject({
      errorCode: 'CONFLICT',
      statusCode: 409
    });
    expect(mockCreateProject).not.toHaveBeenCalled();
  });
});
