import { type ClientSession } from 'mongoose';
import {
  createProjectArbitration,
  findPendingArbitrationsExpiredBefore,
  findPendingProjectArbitrations,
  findPendingProjectArbitrationsByProjectRounds,
  findProjectArbitrationById,
  type ProjectArbitrationRecord,
  type ProjectArbitrationVotingSummaryRecord
} from '../models/projectArbitrationModel';

/** Tạo vụ xét xử và giữ atomic với lần khiếu nại đầu tiên khi có transaction. */
export async function createProjectArbitrationFromRepository(
  payload: Omit<ProjectArbitrationRecord, 'arbitrationId' | 'votes' | 'supersededVoteRounds' | 'verdict' | 'abusiveChallengeUserIds' | 'onChainDecisionTxHash' | 'onChainDecisionStatus' | 'onChainDecisionRecordedAt' | 'onChainDecisionAttemptCount' | 'onChainDecisionRecoveryCount' | 'onChainDecisionNextAttemptAt' | 'onChainDecisionLastError' | 'resolvedAt' | 'createdAt' | 'updatedAt'>,
  session?: ClientSession
): Promise<ProjectArbitrationRecord> {
  return createProjectArbitration(payload, session);
}

/** Tìm vụ xét xử theo ID công khai cho ủy ban. */
export async function findProjectArbitrationByIdFromRepository(arbitrationId: string): Promise<ProjectArbitrationRecord | null> {
  return findProjectArbitrationById(arbitrationId);
}

/** Lấy các vụ xét xử còn mở, tách data-access khỏi controller. */
export async function findPendingProjectArbitrationsFromRepository(committeeUserId?: string): Promise<ProjectArbitrationRecord[]> {
  return findPendingProjectArbitrations(committeeUserId);
}

/** Lấy batch case đang mở theo cặp project/vòng niêm yết để ghép đúng hồ sơ tranh chấp. */
export async function findPendingProjectArbitrationsByProjectRoundsFromRepository(
  projectRounds: Array<{ projectId: string; round: number }>
): Promise<ProjectArbitrationVotingSummaryRecord[]> {
  return findPendingProjectArbitrationsByProjectRounds(projectRounds);
}

/** Lấy các vụ quá hạn theo batch để worker không bị unbounded. */
export async function findPendingArbitrationsExpiredBeforeFromRepository(now: Date, limitCount: number): Promise<ProjectArbitrationRecord[]> {
  return findPendingArbitrationsExpiredBefore(now, limitCount);
}
