import { getProjectActivationBackoffMs, PROJECT_ACTIVATION_CLAIM_TIMEOUT_MS } from '../constants/projectListingPolicy';
import { getLogger } from '../config/logger';
import { claimProjectForClosureFromRepository, updateProject } from '../repositories/projectRepository';
import { closeProjectOnBlockchain } from './projectService';

const logger = getLogger();

export type ProjectClosureOutcome = 'CLOSED' | 'ALREADY_CLAIMED' | 'FAILED';

/** Đóng dự án đã bị 5/5 ghế hủy trên blockchain, có lease và backoff để retry không phát giao dịch trùng. */
export async function closeRejectedProject(projectId: string): Promise<ProjectClosureOutcome> {
  const claimed = await claimProjectForClosureFromRepository(
    projectId,
    new Date(Date.now() - PROJECT_ACTIVATION_CLAIM_TIMEOUT_MS)
  );
  if (!claimed) return 'ALREADY_CLAIMED';

  const attemptedAt = new Date();
  const attemptCount = (claimed.closureAttemptCount || 0) + 1;
  await updateProject(projectId, {
    closureAttemptCount: attemptCount,
    closureClaimedAt: claimed.closureClaimedAt,
    closureLastError: null,
    updatedAt: attemptedAt
  });
  try {
    await closeProjectOnBlockchain(projectId);
    await updateProject(projectId, {
      closureState: 'SYNCED',
      closureClaimedAt: null,
      closureNextAttemptAt: null,
      closureLastError: null,
      updatedAt: new Date()
    });
    return 'CLOSED';
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message.slice(0, 500) : 'Không thể đóng dự án trên blockchain.';
    const failedAt = new Date();
    await updateProject(projectId, {
      closureState: 'FAILED',
      closureClaimedAt: null,
      closureNextAttemptAt: new Date(failedAt.getTime() + getProjectActivationBackoffMs(attemptCount)),
      closureLastError: errorMessage,
      updatedAt: failedAt
    });
    logger.error('Không thể đóng dự án đã bị Ủy ban hủy trên blockchain; đã lên lịch retry.', { projectId, attemptCount, errorMessage });
    return 'FAILED';
  }
}
