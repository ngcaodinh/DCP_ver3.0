import { getProjectActivationBackoffMs, PROJECT_ACTIVATION_CLAIM_TIMEOUT_MS, PROJECT_ACTIVATION_LOCK_RETRY_MS } from '../constants/projectListingPolicy';
import { claimOrganizationActivationLockFromRepository, releaseOrganizationActivationLockFromRepository } from '../repositories/organizationActivationLockRepository';
import { claimProjectForActivationFromRepository, findProjectById, updateProject } from '../repositories/projectRepository';
import { activateProjectOnBlockchain } from './projectService';

export type ActivationOutcome = 'ACTIVATED' | 'ALREADY_CLAIMED' | 'ORGANIZATION_LOCKED' | 'FAILED' | 'INVALID_STATUS';

/** Kích hoạt dự án đã được chấp thuận; idempotent và chỉ service này được gọi blockchain. */
export async function activateApprovedProject(projectId: string, fromStatus: 'PENDING_ACTIVATION' | 'DISPUTED' | 'REJECTED'): Promise<ActivationOutcome> {
  const claimed = await claimProjectForActivationFromRepository(projectId, fromStatus, new Date(Date.now() - PROJECT_ACTIVATION_CLAIM_TIMEOUT_MS));
  if (!claimed) return 'ALREADY_CLAIMED';

  const lockedAt = new Date();
  const hasOrganizationLock = await claimOrganizationActivationLockFromRepository(
    claimed.organizationId, projectId, new Date(lockedAt.getTime() + PROJECT_ACTIVATION_CLAIM_TIMEOUT_MS)
  );
  if (!hasOrganizationLock) {
    await updateProject(projectId, {
      activationClaimedAt: null,
      activationEligibleAt: new Date(lockedAt.getTime() + PROJECT_ACTIVATION_LOCK_RETRY_MS),
      updatedAt: lockedAt
    });
    return 'ORGANIZATION_LOCKED';
  }

  try {
    const attemptedAt = new Date();
    const attemptCount = (claimed.activationAttemptCount || 0) + 1;
    await updateProject(projectId, { activationAttemptCount: attemptCount, activationLastAttemptAt: attemptedAt, updatedAt: attemptedAt });
    try {
      await activateProjectOnBlockchain(projectId);
      await updateProject(projectId, { status: 'ACTIVE', activationClaimedAt: null, activationState: 'SYNCED', activationLastError: null, updatedAt: new Date() });
      return 'ACTIVATED';
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : 'Không thể đồng bộ blockchain.';
      const failureTime = new Date();
      await updateProject(projectId, {
        activationClaimedAt: null,
        activationState: 'FAILED',
        activationLastError: message,
        activationEligibleAt: new Date(failureTime.getTime() + getProjectActivationBackoffMs(attemptCount)),
        updatedAt: failureTime
      });
      return 'FAILED';
    }
  } finally {
    await releaseOrganizationActivationLockFromRepository(claimed.organizationId, projectId);
  }
}

/** Chạy lại đồng bộ RPC cho dự án thất bại mà không mở quyền duyệt dự án. */
export async function retryFailedProjectActivation(projectId: string): Promise<ActivationOutcome> {
  const project = await findProjectById(projectId);
  if (!project || project.activationState !== 'FAILED' || (project.status !== 'PENDING_ACTIVATION' && project.status !== 'DISPUTED')) return 'INVALID_STATUS';
  return activateApprovedProject(projectId, project.status);
}
