import { Response } from 'express';
import { z } from 'zod';
import { AuthenticatedRequest } from '../middleware/authenticationMiddleware';
import { findUsersByIds } from '../models/authModel';
import { findAuditorFieldReportsByAuditorUserId } from '../models/auditorFieldReportModel';
import { findGeofenceByProjectId } from '../models/projectGeofenceModel';
import { findListingVerificationsByAuditorUserId } from '../models/auditorListingVerificationModel';
import { ProjectArbitrationMongoModel } from '../models/projectArbitrationModel';
import { findProjectChallengesByChallengerUserId } from '../models/projectChallengeModel';
import { aggregateDonationSummaryByProjectId } from '../models/donationModel';
import { findProjectNamesByProjectIdList } from '../models/projectModel';
import { findAuditorFieldReportByProjectIdFromRepository, findAuditorFieldReportsByProjectIdsFromRepository } from '../repositories/auditorFieldReportRepository';
import { countProjectChallengesByProjectRoundFromRepository, findProjectChallengeProjectRoundsByUserFromRepository, findProjectChallengesFromRepository } from '../repositories/projectChallengeRepository';
import { findProjectById, findProjectsByIdList, findProjectsByStatusFromRepository } from '../repositories/projectRepository';
import { findPendingProjectArbitrationsFromRepository, findProjectArbitrationByIdFromRepository } from '../repositories/projectArbitrationRepository';
import { submitAuditorFieldReport } from '../services/auditorFieldReport.service';
import { prepareArbitrationVoteSignature, recoverDeadLetterProjectArbitrationOnChainDecision, voteOnArbitration } from '../services/projectArbitration.service';
import { recordAdminAuditLog } from '../services/audit-log.service';
import { retryFailedProjectActivation } from '../services/projectActivation.service';
import { submitProjectChallenge } from '../services/projectChallenge.service';
import { submitAuditorListingVerification } from '../services/auditorListingVerification.service';
import { updateProjectMilestonePlanForOrganization } from '../services/projectService';
import { buildExecutiveEvidencePhoto, getExecutiveActiveProjectDetail, listExecutiveActiveProjects } from '../services/executiveProjectMonitoring.service';
import { sendErrorFromUnknown, sendErrorResponse, sendSuccessResponse } from '../utils/apiResponse';
import { arbitrationOnChainDecisionRecoverySchema, arbitrationSigningPayloadSchema, arbitrationVoteSchema, auditorListingVerificationSchema, fieldReportSchema, projectChallengeSchema, retryActivationSchema, updateMilestonePlanSchema, validateProjectGovernancePayload } from '../validators/projectGovernanceValidator';
import { AUDITOR_ROLE } from '../constants/governanceRoles';
import { extractAuditRequestContext } from '../utils/auditRequestContext';
import { runMongoTransaction } from '../utils/mongoTransaction';

const DEFAULT_PORTAL_HISTORY_LIMIT = 50;
const MAX_PORTAL_HISTORY_LIMIT = 200;
const arbitrationRecoveryParamsSchema = z.object({ arbitrationId: z.string().trim().min(1).max(200) });

/** Chuẩn hóa tham số giới hạn lịch sử để truy vấn cá nhân không quét vô hạn collection. */
function getPortalHistoryLimit(rawLimit: unknown): number {
  const parsedLimit = Number(rawLimit);
  return Number.isFinite(parsedLimit) ? Math.max(1, Math.min(MAX_PORTAL_HISTORY_LIMIT, Math.floor(parsedLimit))) : DEFAULT_PORTAL_HISTORY_LIMIT;
}

/** Bảo vệ route đọc bằng role trong handler để tài khoản auditor bị suspend vẫn xem được dữ liệu của mình. */
function ensureAuditorPortalReadAccess(request: AuthenticatedRequest, response: Response): string | null {
  if (!request.authenticatedUser) {
    sendErrorResponse(response, 401, 'Bạn chưa đăng nhập.', 'UNAUTHENTICATED');
    return null;
  }
  if (request.authenticatedUser.role !== AUDITOR_ROLE) {
    sendErrorResponse(response, 403, 'Chỉ tài khoản Kiểm toán viên mới xem được thông tin này.', 'FORBIDDEN');
    return null;
  }
  return request.authenticatedUser.userId;
}

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

/** Ghi nhận kết luận dự án đúng sự thật mà không đổi trạng thái dự án hoặc mở vụ xét xử. */
export async function handleSubmitAuditorListingVerification(request: AuthenticatedRequest, response: Response): Promise<void> {
  if (!request.authenticatedUser) return sendErrorResponse(response, 401, 'Bạn chưa đăng nhập.', 'UNAUTHENTICATED');
  const validated = validateProjectGovernancePayload(auditorListingVerificationSchema, request.body);
  if (!validated.isValid || !validated.data) return sendErrorResponse(response, 400, 'Dữ liệu xác minh niêm yết không hợp lệ.', 'VALIDATION_ERROR', validated.errors);
  try {
    sendSuccessResponse(response, 201, 'Đã ghi nhận xác minh thực địa.', await submitAuditorListingVerification(request.authenticatedUser.userId, validated.data));
  } catch (error) { sendErrorFromUnknown(response, error, 'Không thể ghi nhận xác minh thực địa.'); }
}

/** Trả các biên bản hiện trường của chính Auditor, giữ GPS đầy đủ vì đây không phải dữ liệu công khai. */
export async function handleGetMyAuditorFieldReports(request: AuthenticatedRequest, response: Response): Promise<void> {
  const auditorUserId = ensureAuditorPortalReadAccess(request, response);
  if (!auditorUserId) return;
  try {
    const reports = await findAuditorFieldReportsByAuditorUserId(auditorUserId, getPortalHistoryLimit(request.query.limit));
    const names = await findProjectNamesByProjectIdList(reports.map(report => report.projectId));
    const projectNameById = new Map(names.map(project => [project.projectId, project.name]));
    sendSuccessResponse(response, 200, 'Đã lấy lịch sử biên bản hiện trường.', reports.map(report => ({
      reportId: report.reportId, projectId: report.projectId, projectName: projectNameById.get(report.projectId) || report.projectId,
      note: report.note, verifiedMilestoneIndexes: report.verifiedMilestoneIndexes, photos: report.photos, submittedAt: report.submittedAt
    })));
  } catch (error) { sendErrorFromUnknown(response, error, 'Không thể lấy lịch sử biên bản hiện trường.'); }
}

/** Trả lịch sử xác minh gồm cả kết luận đúng sự thật và khiếu nại, trộn theo thời gian. */
export async function handleGetMyAuditorListingRecords(request: AuthenticatedRequest, response: Response): Promise<void> {
  const auditorUserId = ensureAuditorPortalReadAccess(request, response);
  if (!auditorUserId) return;
  const limit = getPortalHistoryLimit(request.query.limit);
  try {
    const [verifications, challenges] = await Promise.all([
      findListingVerificationsByAuditorUserId(auditorUserId, limit),
      findProjectChallengesByChallengerUserId(auditorUserId, limit)
    ]);
    const projectIds = [...new Set([...verifications, ...challenges].map(record => record.projectId))];
    const [projectNames, arbitrations] = await Promise.all([
      findProjectNamesByProjectIdList(projectIds),
      ProjectArbitrationMongoModel.find({ projectId: { $in: projectIds } }, { projectId: 1, round: 1, status: 1, verdict: 1, resolvedAt: 1, deadlineAt: 1, abusiveChallengeUserIds: 1, _id: 0 }).lean().exec()
    ]);
    const nameByProjectId = new Map(projectNames.map(project => [project.projectId, project.name]));
    const arbitrationByProjectRound = new Map(arbitrations.map(item => [`${item.projectId}:${item.round}`, item]));
    const records = [
      ...verifications.map(verification => ({
        kind: 'CONFIRMED' as const, recordId: verification.verificationId, projectId: verification.projectId,
        projectName: nameByProjectId.get(verification.projectId) || verification.projectId, round: verification.round,
        submittedAt: verification.submittedAt, photos: verification.photos, note: verification.note, reason: null, arbitration: null
      })),
      ...challenges.map(challenge => {
        const arbitration = arbitrationByProjectRound.get(`${challenge.projectId}:${challenge.round}`);
        return {
          kind: 'CHALLENGE' as const, recordId: challenge.challengeId, projectId: challenge.projectId,
          projectName: nameByProjectId.get(challenge.projectId) || challenge.projectId, round: challenge.round,
          submittedAt: challenge.submittedAt, photos: challenge.evidencePhotos, note: null, reason: challenge.reason,
          arbitration: arbitration ? {
            status: arbitration.status, verdict: arbitration.verdict, deadlineAt: arbitration.deadlineAt,
            resolvedAt: arbitration.resolvedAt, isMarkedAbusive: arbitration.abusiveChallengeUserIds.includes(auditorUserId)
          } : null
        };
      })
    ].sort((left, right) => right.submittedAt.getTime() - left.submittedAt.getTime()).slice(0, limit);
    sendSuccessResponse(response, 200, 'Đã lấy lịch sử xác minh niêm yết.', records);
  } catch (error) { sendErrorFromUnknown(response, error, 'Không thể lấy lịch sử xác minh niêm yết.'); }
}

/** Xử lý phiếu xét xử của ủy ban điều hành. */
export async function handleVoteOnArbitration(request: AuthenticatedRequest, response: Response): Promise<void> {
  if (!request.authenticatedUser) return sendErrorResponse(response, 401, 'Bạn chưa đăng nhập.', 'UNAUTHENTICATED');
  const validated = validateProjectGovernancePayload(arbitrationVoteSchema, request.body);
  if (!validated.isValid || !validated.data) return sendErrorResponse(response, 400, 'Dữ liệu phiếu không hợp lệ.', 'VALIDATION_ERROR', validated.errors);
  try {
    sendSuccessResponse(response, 200, 'Đã ghi nhận phiếu.', await voteOnArbitration(request.authenticatedUser.userId, validated.data));
  } catch (error) { sendErrorFromUnknown(response, error, 'Không thể ghi nhận phiếu.'); }
}

/** Tạo EIP-712 payload từ roster epoch hiện tại trước khi portal mở MetaMask. */
export async function handlePrepareArbitrationVoteSignature(request: AuthenticatedRequest, response: Response): Promise<void> {
  if (!request.authenticatedUser) return sendErrorResponse(response, 401, 'Bạn chưa đăng nhập.', 'UNAUTHENTICATED');
  const validated = validateProjectGovernancePayload(arbitrationSigningPayloadSchema, request.body);
  if (!validated.isValid || !validated.data) return sendErrorResponse(response, 400, 'Yêu cầu tạo payload chữ ký không hợp lệ.', 'VALIDATION_ERROR', validated.errors);
  try {
    sendSuccessResponse(response, 200, 'Đã tạo payload chữ ký EIP-712.', await prepareArbitrationVoteSignature(request.authenticatedUser.userId, validated.data));
  } catch (error) { sendErrorFromUnknown(response, error, 'Không thể tạo payload chữ ký EIP-712.'); }
}

/** Xử lý retry vận hành sau lỗi RPC mà không trao quyền duyệt cho admin. */
export async function handleRetryProjectActivation(request: AuthenticatedRequest, response: Response): Promise<void> {
  const validated = validateProjectGovernancePayload(retryActivationSchema, request.body);
  if (!validated.isValid || !validated.data) return sendErrorResponse(response, 400, 'Dữ liệu retry không hợp lệ.', 'VALIDATION_ERROR', validated.errors);
  try { sendSuccessResponse(response, 200, 'Đã gửi yêu cầu đồng bộ lại blockchain.', await retryFailedProjectActivation(validated.data.projectId)); }
  catch (error) { sendErrorFromUnknown(response, error, 'Không thể đồng bộ lại blockchain.'); }
}

/** Khôi phục có audit một phán quyết xét xử khỏi DLQ sau khi admin đã đối soát chữ ký và hạ tầng relay. */
export async function handleRecoverProjectArbitrationOnChainDecision(request: AuthenticatedRequest, response: Response): Promise<void> {
  const authenticatedUser = request.authenticatedUser;
  if (!authenticatedUser) {
    sendErrorResponse(response, 401, 'Bạn chưa đăng nhập.', 'UNAUTHENTICATED');
    return;
  }
  const params = arbitrationRecoveryParamsSchema.safeParse(request.params);
  const body = validateProjectGovernancePayload(arbitrationOnChainDecisionRecoverySchema, request.body);
  if (!params.success || !body.isValid || !body.data) {
    sendErrorResponse(response, 400, 'Dữ liệu khôi phục phán quyết xét xử không hợp lệ.', 'VALIDATION_ERROR');
    return;
  }
  const recoveryReason = body.data.reason;
  try {
    await runMongoTransaction(async session => {
      if (session) await recoverDeadLetterProjectArbitrationOnChainDecision(params.data.arbitrationId, session);
      else await recoverDeadLetterProjectArbitrationOnChainDecision(params.data.arbitrationId);
      await recordAdminAuditLog({
        actorType: 'ADMIN',
        adminId: authenticatedUser.userId,
        adminRole: authenticatedUser.role,
        actionType: 'ARBITRATION_ON_CHAIN_DECISION_RECOVERED',
        targetId: params.data.arbitrationId,
        targetType: 'PROJECT_ARBITRATION',
        reason: recoveryReason,
        requestContext: extractAuditRequestContext(request),
        context: { arbitrationId: params.data.arbitrationId, onChainDecisionStatus: 'PENDING' },
        session
      });
    });
    sendSuccessResponse(response, 200, 'Đã đưa phán quyết xét xử về hàng đợi relay on-chain.', { arbitrationId: params.data.arbitrationId, onChainDecisionStatus: 'PENDING' });
  } catch (error) {
    sendErrorFromUnknown(response, error, 'Không thể khôi phục phán quyết xét xử.');
  }
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
    const [challengedProjectRounds, confirmedProjectRounds] = await Promise.all([
      findProjectChallengeProjectRoundsByUserFromRepository(request.authenticatedUser.userId, pendingProjects.map(project => project.projectId)),
      findListingVerificationsByAuditorUserId(request.authenticatedUser.userId, MAX_PORTAL_HISTORY_LIMIT)
    ]);
    const challengedKeys = new Set(challengedProjectRounds.map(challenge => `${challenge.projectId}:${challenge.round}`));
    const confirmedKeys = new Set(confirmedProjectRounds.map(verification => `${verification.projectId}:${verification.round}`));
    sendSuccessResponse(response, 200, 'Lấy dự án đang niêm yết thành công.', pendingProjects.map(project => ({
      projectId: project.projectId, name: project.name, description: project.description, status: project.status,
      listedAt: project.listedAt || null, activationEligibleAt: project.activationEligibleAt || null,
      milestonePlan: project.milestonePlan || [], evidenceCids: project.evidenceCids,
      hasCurrentUserChallenged: challengedKeys.has(`${project.projectId}:${Math.max(1, project.listingRound || 1)}`) || confirmedKeys.has(`${project.projectId}:${Math.max(1, project.listingRound || 1)}`),
      hasCurrentUserVerified: confirmedKeys.has(`${project.projectId}:${Math.max(1, project.listingRound || 1)}`)
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

/** Lấy dashboard dự án ACTIVE dành riêng cho Ủy ban, không tái dùng route auditor có gate và DTO khác. */
export async function handleGetExecutiveActiveProjects(request: AuthenticatedRequest, response: Response): Promise<void> {
  try {
    const rawCursor = typeof request.query.cursor === 'string' ? request.query.cursor.trim() : '';
    const rawLimit = Number(request.query.limit || 20);
    const limitCount = Number.isInteger(rawLimit) && rawLimit >= 1 && rawLimit <= 50 ? rawLimit : 20;
    sendSuccessResponse(response, 200, 'Đã lấy dự án đang hoạt động.', await listExecutiveActiveProjects(rawCursor || null, limitCount));
  } catch (error) {
    sendErrorFromUnknown(response, error, 'Không thể lấy dự án đang hoạt động.');
  }
}

/** Lấy một hồ sơ dự án ACTIVE cùng đối chiếu ảnh-geofence cho Ủy ban cân nhắc, không tự động chặn quyết định. */
export async function handleGetExecutiveActiveProjectDetail(request: AuthenticatedRequest, response: Response): Promise<void> {
  const projectId = String(request.params.projectId || '').trim();
  if (!projectId) {
    sendErrorResponse(response, 400, 'projectId là bắt buộc.', 'VALIDATION_ERROR');
    return;
  }
  try {
    sendSuccessResponse(response, 200, 'Đã lấy hồ sơ giám sát dự án.', await getExecutiveActiveProjectDetail(projectId));
  } catch (error) {
    sendErrorFromUnknown(response, error, 'Không thể lấy hồ sơ giám sát dự án.');
  }
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
    const [project, challenges, geofence, donationSummary] = await Promise.all([
      findProjectById(arbitration.projectId),
      findProjectChallengesFromRepository(arbitration.projectId, arbitration.round),
      findGeofenceByProjectId(arbitration.projectId),
      aggregateDonationSummaryByProjectId(arbitration.projectId)
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
    // Áp dụng cùng chính sách GPS cho ảnh của lời tố, không đọc nhầm field report ACTIVE.
    const challengesWithGeofence = namedChallenges.map(challenge => ({
      ...challenge,
      evidencePhotos: (challenge.evidencePhotos || []).map(photo => {
        const evidence = buildExecutiveEvidencePhoto({
          cid: photo.cid,
          source: 'AUDITOR_FIELD_REPORT',
          gps: { lat: photo.gps.latitude, lng: photo.gps.longitude },
          accuracyMeters: photo.accuracyMeters,
          geofence,
          isLowAccuracyOverride: photo.isLowAccuracyOverride,
          lowAccuracyReason: photo.lowAccuracyReason,
          capturedAt: photo.capturedAt
        });
        // ChallengeEvidenceGallery dùng tên latitude/longitude từ model lịch sử; chỉ chuyển shape tại boundary.
        return { ...evidence, gps: evidence.gps ? { latitude: evidence.gps.lat, longitude: evidence.gps.lng } : null };
      })
    }));
    const namedVotes = arbitration.votes.map(vote => ({ ...vote, voterName: userById.get(vote.voterUserId)?.fullName || vote.voterUserId }));
    sendSuccessResponse(response, 200, 'Lấy chi tiết hồ sơ xét xử thành công.', {
      ...arbitration,
      project: project ? {
        projectId: project.projectId, name: project.name, description: project.description, status: project.status,
        organizationName: organization?.organizationName || organization?.fullName || 'Tổ chức chưa xác định',
        milestonePlan: project.milestonePlan || [], evidenceCids: project.evidenceCids, evidenceFiles: project.evidenceFiles,
        totalDonationAmount: donationSummary.totalAmount
      } : null,
      geofence,
      challenges: challengesWithGeofence, votes: namedVotes
    });
  } catch (error) { sendErrorFromUnknown(response, error, 'Không thể lấy chi tiết hồ sơ xét xử.'); }
}
