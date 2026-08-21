import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/authenticationMiddleware';
import { findUsersByIds } from '../models/authModel';
import { findAuditorFieldReportByProjectIdFromRepository, findAuditorFieldReportsByProjectIdsFromRepository } from '../repositories/auditorFieldReportRepository';
import { countProjectChallengesByProjectRoundFromRepository, findProjectChallengeProjectRoundsByUserFromRepository, findProjectChallengesFromRepository } from '../repositories/projectChallengeRepository';
import { findProjectById, findProjectsByIdList, findProjectsByStatusFromRepository } from '../repositories/projectRepository';
import { findPendingProjectArbitrationsFromRepository, findProjectArbitrationByIdFromRepository } from '../repositories/projectArbitrationRepository';
import { submitAuditorFieldReport } from '../services/auditorFieldReport.service';
import { voteOnArbitration } from '../services/projectArbitration.service';
import { retryFailedProjectActivation } from '../services/projectActivation.service';
import { submitProjectChallenge } from '../services/projectChallenge.service';
import { updateProjectMilestonePlanForOrganization } from '../services/projectService';
import { sendErrorFromUnknown, sendErrorResponse, sendSuccessResponse } from '../utils/apiResponse';
import { arbitrationVoteSchema, fieldReportSchema, projectChallengeSchema, retryActivationSchema, updateMilestonePlanSchema, validateProjectGovernancePayload } from '../validators/projectGovernanceValidator';

/** Xử lý cập nhật riêng kế hoạch cột mốc của tổ chức. */
export async function handleUpdateMilestonePlan(request: AuthenticatedRequest, response: Response): Promise<void> {
  if (!request.authenticatedUser) return sendErrorResponse(response, 401, 'Bạn chưa đăng nhập.', 'UNAUTHENTICATED');
  const validated = validateProjectGovernancePayload(updateMilestonePlanSchema, request.body);
  if (!validated.isValid || !validated.data) return sendErrorResponse(response, 400, 'Dữ liệu kế hoạch không hợp lệ.', 'VALIDATION_ERROR', validated.errors);
  try {
    sendSuccessResponse(response, 200, 'Đã cập nhật kế hoạch cột mốc.', await updateProjectMilestonePlanForOrganization(
      request.authenticatedUser.userId, validated.data.projectId, validated.data.milestonePlan
    ));
  } catch (error) { sendErrorFromUnknown(response, error, 'Không thể cập nhật kế hoạch cột mốc.'); }
}

/** Xử lý khiếu nại chỉ dành cho Kiểm toán viên. */
export async function handleSubmitProjectChallenge(request: AuthenticatedRequest, response: Response): Promise<void> {
  if (!request.authenticatedUser) return sendErrorResponse(response, 401, 'Bạn chưa đăng nhập.', 'UNAUTHENTICATED');
  const validated = validateProjectGovernancePayload(projectChallengeSchema, request.body);
  if (!validated.isValid || !validated.data) return sendErrorResponse(response, 400, 'Dữ liệu khiếu nại không hợp lệ.', 'VALIDATION_ERROR', validated.errors);
  try {
    sendSuccessResponse(response, 201, 'Đã ghi nhận khiếu nại.', await submitProjectChallenge(request.authenticatedUser.userId, {
      ...validated.data,
      serverReceivedAt: new Date()
    }));
  } catch (error) { sendErrorFromUnknown(response, error, 'Không thể ghi nhận khiếu nại.'); }
}

/** Xử lý phiếu xét xử của ủy ban điều hành. */
export async function handleVoteOnArbitration(request: AuthenticatedRequest, response: Response): Promise<void> {
  if (!request.authenticatedUser) return sendErrorResponse(response, 401, 'Bạn chưa đăng nhập.', 'UNAUTHENTICATED');
  const validated = validateProjectGovernancePayload(arbitrationVoteSchema, request.body);
  if (!validated.isValid || !validated.data) return sendErrorResponse(response, 400, 'Dữ liệu phiếu không hợp lệ.', 'VALIDATION_ERROR', validated.errors);
  try {
    sendSuccessResponse(response, 200, 'Đã ghi nhận phiếu.', await voteOnArbitration(request.authenticatedUser.userId, {
      ...validated.data, markedAbusive: validated.data.markedAbusive || false
    }));
  } catch (error) { sendErrorFromUnknown(response, error, 'Không thể ghi nhận phiếu.'); }
}

/** Xử lý retry vận hành sau lỗi RPC mà không trao quyền duyệt cho admin. */
export async function handleRetryProjectActivation(request: AuthenticatedRequest, response: Response): Promise<void> {
  const validated = validateProjectGovernancePayload(retryActivationSchema, request.body);
  if (!validated.isValid || !validated.data) return sendErrorResponse(response, 400, 'Dữ liệu retry không hợp lệ.', 'VALIDATION_ERROR', validated.errors);
  try { sendSuccessResponse(response, 200, 'Đã gửi yêu cầu đồng bộ lại blockchain.', await retryFailedProjectActivation(validated.data.projectId)); }
  catch (error) { sendErrorFromUnknown(response, error, 'Không thể đồng bộ lại blockchain.'); }
}

/** Xử lý biên bản hiện trường độc lập của Kiểm toán viên. */
export async function handleSubmitAuditorFieldReport(request: AuthenticatedRequest, response: Response): Promise<void> {
  if (!request.authenticatedUser) return sendErrorResponse(response, 401, 'Bạn chưa đăng nhập.', 'UNAUTHENTICATED');
  const validated = validateProjectGovernancePayload(fieldReportSchema, request.body);
  if (!validated.isValid || !validated.data) return sendErrorResponse(response, 400, 'Dữ liệu biên bản không hợp lệ.', 'VALIDATION_ERROR', validated.errors);
  try { sendSuccessResponse(response, 201, 'Đã ghi nhận biên bản hiện trường.', await submitAuditorFieldReport(request.authenticatedUser.userId, validated.data)); }
  catch (error) { sendErrorFromUnknown(response, error, 'Không thể ghi nhận biên bản hiện trường.'); }
}

/** Lấy dự án niêm yết cho auditor cùng cờ khóa nút khiếu nại của chính người dùng. */
export async function handleGetAuditorPendingProjects(request: AuthenticatedRequest, response: Response): Promise<void> {
  if (!request.authenticatedUser) return sendErrorResponse(response, 401, 'Bạn chưa đăng nhập.', 'UNAUTHENTICATED');
  try {
    const pendingProjects = (await Promise.all([
      findProjectsByStatusFromRepository('PENDING_ACTIVATION'),
      findProjectsByStatusFromRepository('DISPUTED')
    ])).flat();
    const challengedProjectRounds = await findProjectChallengeProjectRoundsByUserFromRepository(
      request.authenticatedUser.userId, pendingProjects.map(project => project.projectId)
    );
    const challengedKeys = new Set(challengedProjectRounds.map(challenge => `${challenge.projectId}:${challenge.round}`));
    sendSuccessResponse(response, 200, 'Lấy dự án đang niêm yết thành công.', pendingProjects.map(project => ({
      projectId: project.projectId, name: project.name, description: project.description, status: project.status,
      listedAt: project.listedAt || null, activationEligibleAt: project.activationEligibleAt || null,
      milestonePlan: project.milestonePlan || [], evidenceCids: project.evidenceCids,
      hasCurrentUserChallenged: challengedKeys.has(`${project.projectId}:${Math.max(1, project.listingRound || 1)}`)
    })));
  } catch (error) { sendErrorFromUnknown(response, error, 'Không thể lấy dự án đang niêm yết.'); }
}

/** Lấy dự án active và thông tin khóa biên bản để auditor không nộp đè. */
export async function handleGetAuditorActiveProjects(request: AuthenticatedRequest, response: Response): Promise<void> {
  try {
    const activeProjects = await findProjectsByStatusFromRepository('ACTIVE');
    const [reports, organizations] = await Promise.all([
      findAuditorFieldReportsByProjectIdsFromRepository(activeProjects.map(project => project.projectId)),
      findUsersByIds(activeProjects.map(project => project.organizationId))
    ]);
    const reportByProjectId = new Map(reports.map(report => [report.projectId, report]));
    const organizationByUserId = new Map(organizations.map(organization => [organization.id, organization]));
    sendSuccessResponse(response, 200, 'Lấy dự án active thành công.', activeProjects.map(project => {
      const report = reportByProjectId.get(project.projectId);
      const organization = organizationByUserId.get(project.organizationId);
      return {
        projectId: project.projectId, name: project.name,
        organizationName: organization?.organizationName || organization?.fullName || 'Tổ chức chưa xác định', milestonePlan: project.milestonePlan || [],
        fieldReport: report ? {
          reportId: report.reportId, auditorLabel: `Kiểm toán viên #${report.auditorUserId.slice(-6)}`,
          isMine: report.auditorUserId === request.authenticatedUser?.userId,
          verifiedMilestoneIndexes: report.verifiedMilestoneIndexes, submittedAt: report.submittedAt
        } : null
      };
    }));
  } catch (error) { sendErrorFromUnknown(response, error, 'Không thể lấy dự án active.'); }
}

/** Lấy một biên bản nội bộ của auditor, bao gồm GPS khi chính auditor cần đối chiếu. */
export async function handleGetAuditorFieldReport(request: AuthenticatedRequest, response: Response): Promise<void> {
  if (!request.authenticatedUser) return sendErrorResponse(response, 401, 'Bạn chưa đăng nhập.', 'UNAUTHENTICATED');
  const projectId = String(request.query.projectId || '').trim();
  if (!projectId) return sendErrorResponse(response, 400, 'projectId là bắt buộc.', 'VALIDATION_ERROR');
  try {
    const report = await findAuditorFieldReportByProjectIdFromRepository(projectId);
    if (report && report.auditorUserId !== request.authenticatedUser.userId) {
      return sendErrorResponse(response, 403, 'Bạn không có quyền xem biên bản này.', 'FORBIDDEN');
    }
    sendSuccessResponse(response, 200, 'Lấy biên bản hiện trường thành công.', report);
  } catch (error) { sendErrorFromUnknown(response, error, 'Không thể lấy biên bản hiện trường.'); }
}

/** Lấy danh sách hồ sơ xét xử còn mở cho ủy ban. */
export async function handleGetExecutiveCases(request: AuthenticatedRequest, response: Response): Promise<void> {
  if (!request.authenticatedUser) return sendErrorResponse(response, 401, 'Bạn chưa đăng nhập.', 'UNAUTHENTICATED');
  try {
    const cases = await findPendingProjectArbitrationsFromRepository(request.authenticatedUser.userId);
    const [projects, challengeCounts] = await Promise.all([
      findProjectsByIdList(cases.map(item => item.projectId)),
      countProjectChallengesByProjectRoundFromRepository(cases.map(item => item.projectId))
    ]);
    const organizations = await findUsersByIds(projects.map(project => project.organizationId));
    const projectById = new Map(projects.map(project => [project.projectId, project]));
    const organizationById = new Map(organizations.map(organization => [organization.id, organization]));
    const challengeCountByProjectRound = new Map(challengeCounts.map(item => [`${item.projectId}:${item.round}`, item.count]));
    sendSuccessResponse(response, 200, 'Lấy danh sách hồ sơ xét xử thành công.', cases.map(item => {
      const project = projectById.get(item.projectId);
      const organization = project ? organizationById.get(project.organizationId) : null;
      return {
        arbitrationId: item.arbitrationId, projectId: item.projectId, round: item.round, projectName: project?.name || item.projectId,
        organizationName: organization?.organizationName || organization?.fullName || 'Tổ chức chưa xác định', openedAt: item.openedAt, deadlineAt: item.deadlineAt,
        challengeCount: challengeCountByProjectRound.get(`${item.projectId}:${item.round}`) || 0,
        upholdVoteCount: item.votes.filter(vote => vote.decision === 'UPHOLD_PROJECT').length,
        rejectVoteCount: item.votes.filter(vote => vote.decision === 'REJECT_PROJECT').length,
        chairVoted: item.votes.some(vote => vote.voterRole === 'executive_chair'), requiredMemberVotes: item.requiredMemberVotes,
        totalMemberSeats: item.committeeSnapshot.filter(member => member.role === 'executive_member').length,
        hasCurrentUserVoted: item.votes.some(vote => vote.voterUserId === request.authenticatedUser!.userId)
      };
    }));
  } catch (error) { sendErrorFromUnknown(response, error, 'Không thể lấy danh sách hồ sơ xét xử.'); }
}

/** Lấy chi tiết hồ sơ xét xử cho thành viên trong snapshot ủy ban. */
export async function handleGetExecutiveCaseDetail(request: AuthenticatedRequest, response: Response): Promise<void> {
  if (!request.authenticatedUser) return sendErrorResponse(response, 401, 'Bạn chưa đăng nhập.', 'UNAUTHENTICATED');
  const arbitrationId = String(request.params.arbitrationId || '').trim();
  try {
    const arbitration = await findProjectArbitrationByIdFromRepository(arbitrationId);
    if (!arbitration) return sendErrorResponse(response, 404, 'Không tìm thấy hồ sơ xét xử.', 'NOT_FOUND');
    if (!arbitration.committeeSnapshot.some(member => member.userId === request.authenticatedUser!.userId)) {
      return sendErrorResponse(response, 403, 'Bạn không thuộc snapshot ủy ban của vụ việc này.', 'NOT_COMMITTEE_MEMBER');
    }
    const [project, challenges] = await Promise.all([
      findProjectById(arbitration.projectId),
      findProjectChallengesFromRepository(arbitration.projectId, arbitration.round)
    ]);
    const users = await findUsersByIds([
      ...(project ? [project.organizationId] : []),
      ...challenges.map(challenge => challenge.challengerUserId),
      ...arbitration.votes.map(vote => vote.voterUserId)
    ]);
    const userById = new Map(users.map(user => [user.id, user]));
    const organization = project ? userById.get(project.organizationId) : null;
    const namedChallenges = challenges.map(challenge => ({
      ...challenge,
      challengerName: userById.get(challenge.challengerUserId)?.fullName || `Kiểm toán viên #${challenge.challengerUserId.slice(-6)}`
    }));
    const namedVotes = arbitration.votes.map(vote => ({ ...vote, voterName: userById.get(vote.voterUserId)?.fullName || vote.voterUserId }));
    sendSuccessResponse(response, 200, 'Lấy chi tiết hồ sơ xét xử thành công.', {
      ...arbitration,
      project: project ? {
        projectId: project.projectId, name: project.name, description: project.description,
        organizationName: organization?.organizationName || organization?.fullName || 'Tổ chức chưa xác định',
        milestonePlan: project.milestonePlan || [], evidenceCids: project.evidenceCids, evidenceFiles: project.evidenceFiles
      } : null,
      challenges: namedChallenges, votes: namedVotes
    });
  } catch (error) { sendErrorFromUnknown(response, error, 'Không thể lấy chi tiết hồ sơ xét xử.'); }
}
