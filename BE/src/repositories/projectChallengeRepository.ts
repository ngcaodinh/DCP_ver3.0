import { type ClientSession } from 'mongoose';
import {
  createProjectChallenge,
  countProjectChallengesByProjectRound,
  countProjectChallengesByUserSince,
  findProjectChallengeReferencesByProjectRounds,
  findProjectChallengesByUserForProjectIds,
  findProjectChallengesByProjectRounds,
  findProjectChallenges,
  hasProjectChallengeByUser,
  type ProjectChallengeRecord
} from '../models/projectChallengeModel';

/** Tìm khiếu nại của auditor trong cùng vòng để chặn upload ảnh trùng trước Pinata. */
export async function findChallengeByProjectRoundAndUser(projectId: string, round: number, userId: string): Promise<boolean> {
  return hasProjectChallengeByUser(projectId, round, userId);
}

/** Lưu khiếu nại qua repository để service giữ đúng trách nhiệm nghiệp vụ. */
export async function createProjectChallengeFromRepository(
  payload: Omit<ProjectChallengeRecord, 'challengeId' | 'createdAt' | 'updatedAt'>,
  session?: ClientSession
): Promise<ProjectChallengeRecord> {
  return createProjectChallenge(payload, session);
}

/** Lấy khiếu nại của một vòng niêm yết phục vụ minh bạch và xét xử. */
export async function findProjectChallengesFromRepository(projectId: string, round: number): Promise<ProjectChallengeRecord[]> {
  return findProjectChallenges(projectId, round);
}

/** Lấy batch khiếu nại theo cặp project/vòng để read model Ủy ban không gọi N+1. */
export async function findProjectChallengesByProjectRoundsFromRepository(
  projectRounds: Array<{ projectId: string; round: number }>
): Promise<ProjectChallengeRecord[]> {
  return findProjectChallengesByProjectRounds(projectRounds);
}

/** Lấy khóa challenge tối thiểu để read model portal kiểm tra liên kết arbitration. */
export async function findProjectChallengeReferencesByProjectRoundsFromRepository(
  projectRounds: Array<{ projectId: string; round: number }>
): Promise<Array<Pick<ProjectChallengeRecord, 'challengeId' | 'projectId' | 'round'>>> {
  return findProjectChallengeReferencesByProjectRounds(projectRounds);
}

/** Kiểm tra bản ghi khiếu nại trùng trước khi mở lại UI auditor. */
export async function hasProjectChallengeByUserFromRepository(projectId: string, round: number, userId: string): Promise<boolean> {
  return hasProjectChallengeByUser(projectId, round, userId);
}

/** Lấy batch dấu khiếu nại của Auditor cho danh sách dự án niêm yết. */
export async function findProjectChallengeProjectRoundsByUserFromRepository(userId: string, projectIds: string[]): Promise<Array<Pick<ProjectChallengeRecord, 'projectId' | 'round'>>> {
  return findProjectChallengesByUserForProjectIds(userId, projectIds);
}

/** Đếm batch khiếu nại để endpoint công khai không phát sinh N+1 truy vấn. */
export async function countProjectChallengesByProjectRoundFromRepository(projectIds: string[]): Promise<Array<{ projectId: string; round: number; count: number }>> {
  return countProjectChallengesByProjectRound(projectIds);
}

/** Đếm quota khiếu nại theo ngày, tách khỏi service để dễ thay bằng storage phân tán sau này. */
export async function countProjectChallengesByUserSinceFromRepository(userId: string, from: Date): Promise<number> {
  return countProjectChallengesByUserSince(userId, from);
}
