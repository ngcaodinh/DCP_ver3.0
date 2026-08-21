import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectRecord } from '../../models/projectModel';

const { mockActivateOnChain, mockClaim, mockCountActive, mockFindProject, mockUpdate, mockClaimOrganizationLock, mockReleaseOrganizationLock } = vi.hoisted(() => ({
  mockActivateOnChain: vi.fn(), mockClaim: vi.fn(), mockCountActive: vi.fn(), mockFindProject: vi.fn(), mockUpdate: vi.fn(), mockClaimOrganizationLock: vi.fn(), mockReleaseOrganizationLock: vi.fn()
}));

vi.mock('../../services/projectService', () => ({ activateProjectOnBlockchain: mockActivateOnChain }));
vi.mock('../../repositories/projectRepository', () => ({
  claimProjectForActivationFromRepository: mockClaim,
  countActiveProjectsByOrganizationIdFromRepository: mockCountActive,
  findProjectById: mockFindProject,
  updateProject: mockUpdate
}));
vi.mock('../../repositories/organizationActivationLockRepository', () => ({
  claimOrganizationActivationLockFromRepository: mockClaimOrganizationLock,
  releaseOrganizationActivationLockFromRepository: mockReleaseOrganizationLock
}));

import { activateApprovedProject, retryFailedProjectActivation } from '../../services/projectActivation.service';

/** Tạo dự án đã được lease để kiểm tra service không phụ thuộc Mongo thật. */
function project(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  const now = new Date('2026-08-20T00:00:00.000Z');
  return { projectId: 'project-1', organizationId: 'org-1', name: 'Dự án', description: 'Mô tả hợp lệ', goalAmount: 100, deadline: now, status: 'PENDING_ACTIVATION', evidenceCids: [], evidenceFiles: [], submittedAt: now, reviewedAt: now, reviewedBy: 'regulatory-1', rejectionReason: null, milestonePlan: [], listedAt: now, activationEligibleAt: now, activationClaimedAt: now, activationState: 'NOT_STARTED', activationAttemptCount: 0, activationLastAttemptAt: null, activationLastError: null, listingRound: 1, createdAt: now, updatedAt: now, ...overrides };
}

describe('project activation service', () => {
  beforeEach(() => {
    vi.clearAllMocks(); mockClaim.mockResolvedValue(project()); mockClaimOrganizationLock.mockResolvedValue(true); mockReleaseOrganizationLock.mockResolvedValue(undefined); mockCountActive.mockResolvedValue(0); mockUpdate.mockResolvedValue(project());
  });

  it('moves to ACTIVE and SYNCED only after blockchain activation succeeds', async () => {
    mockActivateOnChain.mockResolvedValue(undefined);
    await expect(activateApprovedProject('project-1', 'PENDING_ACTIVATION')).resolves.toBe('ACTIVATED');
    expect(mockUpdate).toHaveBeenLastCalledWith('project-1', expect.objectContaining({ status: 'ACTIVE', activationState: 'SYNCED', activationClaimedAt: null }));
    expect(mockReleaseOrganizationLock).toHaveBeenCalledWith('org-1', 'project-1');
  });

  it('releases lease and retains status on blockchain failure', async () => {
    mockActivateOnChain.mockRejectedValue(new Error('RPC down'));
    await expect(activateApprovedProject('project-1', 'PENDING_ACTIVATION')).resolves.toBe('FAILED');
    expect(mockUpdate).toHaveBeenLastCalledWith('project-1', expect.objectContaining({ activationState: 'FAILED', activationClaimedAt: null, activationLastError: 'RPC down' }));
    expect(mockUpdate).not.toHaveBeenCalledWith('project-1', expect.objectContaining({ status: 'REJECTED' }));
    expect(mockReleaseOrganizationLock).toHaveBeenCalledWith('org-1', 'project-1');
  });

  it('does not activate when another worker owns the lease', async () => {
    mockClaim.mockResolvedValue(null);
    await expect(activateApprovedProject('project-1', 'PENDING_ACTIVATION')).resolves.toBe('ALREADY_CLAIMED');
    expect(mockActivateOnChain).not.toHaveBeenCalled();
  });

  it('releases the project lease without activating when another project owns the organization lock', async () => {
    mockClaimOrganizationLock.mockResolvedValue(false);

    await expect(activateApprovedProject('project-1', 'PENDING_ACTIVATION')).resolves.toBe('ORGANIZATION_LOCKED');

    expect(mockUpdate).toHaveBeenCalledWith('project-1', expect.objectContaining({ activationClaimedAt: null, activationEligibleAt: expect.any(Date) }));
    expect(mockActivateOnChain).not.toHaveBeenCalled();
    expect(mockReleaseOrganizationLock).not.toHaveBeenCalled();
  });

  it('keeps a project recoverable when the organization has five active projects', async () => {
    mockCountActive.mockResolvedValue(5);
    await expect(activateApprovedProject('project-1', 'PENDING_ACTIVATION')).resolves.toBe('ACTIVE_PROJECT_LIMIT_REACHED');
    expect(mockUpdate).toHaveBeenCalledWith('project-1', expect.objectContaining({ activationState: 'FAILED', activationClaimedAt: null }));
    expect(mockActivateOnChain).not.toHaveBeenCalled();
  });

  it('applies a six-hour backoff after the fifth failed blockchain attempt', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-20T00:00:00.000Z'));
    mockClaim.mockResolvedValue(project({ activationAttemptCount: 4 }));
    mockActivateOnChain.mockRejectedValue(new Error('RPC down'));

    await expect(activateApprovedProject('project-1', 'PENDING_ACTIVATION')).resolves.toBe('FAILED');

    expect(mockUpdate).toHaveBeenCalledWith('project-1', expect.objectContaining({ activationAttemptCount: 5 }));
    expect(mockUpdate).toHaveBeenLastCalledWith('project-1', expect.objectContaining({ activationEligibleAt: new Date('2026-08-20T06:00:00.000Z') }));
    vi.useRealTimers();
  });

  it('rejects retry for a project that did not fail activation', async () => {
    mockFindProject.mockResolvedValue(project({ activationState: 'NOT_STARTED' }));
    await expect(retryFailedProjectActivation('project-1')).resolves.toBe('INVALID_STATUS');
  });
});
