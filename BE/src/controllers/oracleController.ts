import { Response } from 'express';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { getLogger } from '../config/logger';
import { sendSuccessResponse, sendErrorResponse, sendErrorFromUnknown } from '../utils/apiResponse';
import type { AuthenticatedRequest } from '../middleware/authenticationMiddleware';
import {
  verifyEvidenceImage
} from '../services/oracleService';
import {
  submitOverrideVote,
  VoteRejectedError
} from '../services/overrideVotingService';
import {
  enqueueOracleVerification,
  type OracleVerificationJobData
} from '../queues/oracleQueue';
import {
  findGeofenceByProjectId,
  upsertProjectGeofence
} from '../models/projectGeofenceModel';
import {
  findPendingOverrideRequests,
  countPendingOverrideRequests,
  findOverrideRequestById,
  findCommissionerInSnapshot
} from '../models/oracleOverrideRequestModel';
import { findVerificationById } from '../models/oracleVerificationResultModel';
import { findProjectById, findProjectsByIdList } from '../repositories/projectRepository';
import { validateGeofenceRequestBody } from '../validators/geofenceValidator';
import { extractAuditRequestContext } from '../utils/auditRequestContext';

const logger = getLogger();

/**
 * Schema validate body cho POST /api/oracle/override-requests/:overrideRequestId/vote.
 * Mục đích: thay thế validation thủ công bằng Zod để đảm bảo type-safety và bảo mật đầu vào.
 * - vote: enum APPROVE hoặc REJECT
 * - reason: string, trim, tối thiểu 10 ký tự, tối đa 1000 ký tự, loại bỏ control characters
 */
// eslint-disable-next-line no-control-regex -- Intentional: regex này được dùng để PHÁT HIỆN control characters trong `reason`, không phải pattern khớp dữ liệu người dùng.
const CONTROL_CHAR_REGEX = /[\u0000-\u001F\u007F]/;

const IPFS_CID_VERSION_ZERO_REGEX = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;
const IPFS_CID_VERSION_ONE_REGEX = /^b[a-z2-7]{20,}$/;
const MAX_EVIDENCE_CID_LENGTH = 128;

/** Chuẩn hóa và validate CID IPFS ở biên API trước khi service/queue xử lý. */
function normalizeEvidenceCid(evidenceCid: unknown): string | null {
  if (typeof evidenceCid !== 'string') return null;

  const normalizedEvidenceCid = evidenceCid.trim();
  if (!normalizedEvidenceCid || normalizedEvidenceCid.length > MAX_EVIDENCE_CID_LENGTH) {
    return null;
  }

  if (
    IPFS_CID_VERSION_ZERO_REGEX.test(normalizedEvidenceCid) ||
    IPFS_CID_VERSION_ONE_REGEX.test(normalizedEvidenceCid)
  ) {
    return normalizedEvidenceCid;
  }

  return null;
}

const voteOverrideBodySchema = z.object({
  vote: z.enum(['APPROVE', 'REJECT'], {
    errorMap: () => ({ message: 'vote phải là APPROVE hoặc REJECT.' })
  }),
  reason: z.string({ required_error: 'Thiếu lý do vote (reason).' })
    .trim()
    .min(10, 'Lý do vote phải tối thiểu 10 ký tự.')
    .max(1000, 'Lý do vote tối đa 1000 ký tự.')
    .refine(
      (value) => !CONTROL_CHAR_REGEX.test(value),
      { message: 'Lý do vote chứa ký tự điều khiển không hợp lệ.' }
    )
});

/**
 * POST /api/oracle/verify-image
 * Xác minh một ảnh minh chứng (synchronous — trực tiếp, không qua queue).
 * Dùng cho trường hợp cần kết quả ngay (FE upload + hiển thị GPS indicator real-time).
 *
 * Body: multipart/form-data
 *   - image: File (JPEG/PNG/WebP, max 10MB)
 *   - projectId: string
 *   - evidenceCid: string (IPFS CID của ảnh đã upload)
 */
export async function handleVerifyImage(
  request: AuthenticatedRequest,
  response: Response
): Promise<void> {
  if (!request.authenticatedUser) {
    sendErrorResponse(response, 401, 'Bạn chưa đăng nhập.', 'UNAUTHENTICATED');
    return;
  }

  const file = request.file;
  if (!file) {
    sendErrorResponse(response, 400, 'Thiếu file ảnh minh chứng.', 'VALIDATION_ERROR');
    return;
  }

  // validatedFile đã được magic bytes + size check bởi createUploadValidationMiddleware
  // Nếu invalid, middleware đã trả 413/415 và không gọi controller này
  if (request.validatedFile && !request.validatedFile.isValid) {
    sendErrorResponse(response, 415, 'File không hợp lệ.', 'UNSUPPORTED_MEDIA_TYPE');
    return;
  }

  const { projectId, evidenceCid } = request.body as { projectId?: string; evidenceCid?: string };

  if (!projectId?.trim()) {
    sendErrorResponse(response, 400, 'Thiếu projectId.', 'VALIDATION_ERROR');
    return;
  }
  const normalizedEvidenceCid = normalizeEvidenceCid(evidenceCid);
  if (!normalizedEvidenceCid) {
    sendErrorResponse(response, 400, 'evidenceCid không hợp lệ.', 'VALIDATION_ERROR');
    return;
  }

  try {
    // [B1-fix #2] Kiểm tra quyền sở hữu: chỉ tổ chức sở hữu project mới được verify ảnh — ngăn IDOR
    const project = await findProjectById(projectId);
    if (!project) {
      sendErrorResponse(response, 404, 'Dự án không tồn tại.', 'NOT_FOUND');
      return;
    }
    if (project.organizationId !== request.authenticatedUser.userId) {
      sendErrorResponse(response, 403, 'Bạn không có quyền xác minh ảnh cho dự án này.', 'FORBIDDEN');
      return;
    }

    const result = await verifyEvidenceImage(
      file.buffer,
      projectId,
      request.authenticatedUser.userId,
      normalizedEvidenceCid
    );

    logger.info('Oracle verify-image hoàn thành.', {
      projectId,
      evidenceCid: normalizedEvidenceCid,
      verificationId: result.verificationId,
      isValid: result.isValid
    });

    sendSuccessResponse(response, 200, 'Xác minh ảnh minh chứng thành công.', result);
  } catch (error) {
    logger.error('Oracle verify-image thất bại.', {
      projectId,
      evidenceCid: normalizedEvidenceCid,
      errorMessage: (error as Error)?.message
    });
    sendErrorFromUnknown(response, error, 'Không thể xác minh ảnh minh chứng.');
  }
}

/**
 * POST /api/oracle/verify-image/batch
 * Xác minh nhiều ảnh minh chứng bất đồng bộ qua Bull queue (concurrency 3).
 * Dùng khi tổ chức upload nhiều ảnh cùng lúc (disbursement evidence).
 *
 * Body: multipart/form-data
 *   - images[]: File[] (JPEG/PNG/WebP, mỗi file max 10MB)
 *   - projectId: string
 *   - evidenceCids: JSON array string (["cid1", "cid2", ...], độ dài = số ảnh)
 */
export async function handleVerifyImageBatch(
  request: AuthenticatedRequest,
  response: Response
): Promise<void> {
  if (!request.authenticatedUser) {
    sendErrorResponse(response, 401, 'Bạn chưa đăng nhập.', 'UNAUTHENTICATED');
    return;
  }

  const files = request.files as Express.Multer.File[] | undefined;
  if (!files || files.length === 0) {
    sendErrorResponse(response, 400, 'Thiếu file ảnh.', 'VALIDATION_ERROR');
    return;
  }
  if (files.length > 10) {
    sendErrorResponse(response, 400, 'Tối đa 10 ảnh mỗi batch.', 'VALIDATION_ERROR');
    return;
  }

  const { projectId, evidenceCids: evidenceCidsRaw } = request.body as {
    projectId?: string;
    evidenceCids?: string;
  };

  if (!projectId?.trim()) {
    sendErrorResponse(response, 400, 'Thiếu projectId.', 'VALIDATION_ERROR');
    return;
  }

  let parsedEvidenceCids: unknown;
  try {
    parsedEvidenceCids = JSON.parse(evidenceCidsRaw ?? '[]');
  } catch {
    sendErrorResponse(response, 400, 'evidenceCids phải là JSON array hợp lệ.', 'VALIDATION_ERROR');
    return;
  }

  if (!Array.isArray(parsedEvidenceCids)) {
    sendErrorResponse(response, 400, 'evidenceCids phải là JSON array hợp lệ.', 'VALIDATION_ERROR');
    return;
  }

  const evidenceCids: string[] = [];
  for (const evidenceCid of parsedEvidenceCids) {
    const normalizedEvidenceCid = normalizeEvidenceCid(evidenceCid);
    if (!normalizedEvidenceCid) {
      sendErrorResponse(response, 400, 'evidenceCids chứa CID không hợp lệ.', 'VALIDATION_ERROR');
      return;
    }
    evidenceCids.push(normalizedEvidenceCid);
  }

  if (evidenceCids.length !== files.length) {
    sendErrorResponse(
      response, 400,
      'Số lượng evidenceCids phải bằng số ảnh upload.',
      'VALIDATION_ERROR'
    );
    return;
  }

  // validatedFiles đã được magic bytes + size check bởi createBatchUploadValidationMiddleware
  // Nếu có file invalid, middleware đã trả 413/415 và không gọi controller này

  // [B1-fix #2] Kiểm tra quyền sở hữu một lần cho cả batch — ngăn IDOR
  const project = await findProjectById(projectId);
  if (!project) {
    sendErrorResponse(response, 404, 'Dự án không tồn tại.', 'NOT_FOUND');
    return;
  }
  if (project.organizationId !== request.authenticatedUser.userId) {
    sendErrorResponse(response, 403, 'Bạn không có quyền xác minh ảnh cho dự án này.', 'FORBIDDEN');
    return;
  }

  const jobIds: Array<{ fileName: string; evidenceCid: string; jobId: string | number | undefined; enqueued: boolean }> = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const evidenceCid = evidenceCids[i];
    if (!file || !evidenceCid) continue;

    // [B1-fix #1] Chỉ lưu CID vào job — worker tự fetch buffer từ IPFS thay vì nhét base64 vào Redis
    const jobData: OracleVerificationJobData = {
      jobId: randomUUID(),
      projectId,
      organizationId: request.authenticatedUser.userId,
      evidenceCid,
      fileSizeBytes: file.size
    };

    const { jobId, enqueued } = await enqueueOracleVerification(jobData);
    jobIds.push({
      fileName: file.originalname,
      evidenceCid,
      jobId,
      enqueued
    });
  }

  const enqueuedCount = jobIds.filter(j => j.enqueued).length;
  const failedCount = jobIds.filter(j => !j.enqueued).length;

  logger.info('Oracle batch verify enqueued.', {
    projectId,
    totalFiles: files.length,
    enqueuedCount,
    failedCount
  });

  // [S4] Thông báo rõ khi enqueue thất bại — client biết job nào bị mất để retry
  if (enqueuedCount === 0) {
    sendErrorResponse(response, 503, 'Không thể đưa bất kỳ ảnh nào vào hàng đợi. Redis có thể tạm thời không khả dụng.', 'SERVICE_UNAVAILABLE');
    return;
  }

  // 207 Multi-Status khi một số job enqueue thất bại
  const statusCode = failedCount > 0 ? 207 : 202;
  sendSuccessResponse(response, statusCode, 'Đã đưa vào hàng đợi xác minh.', { jobs: jobIds, enqueuedCount, failedCount });
}

/**
 * GET /api/oracle/geofence/:projectId
 * Lấy dữ liệu geofence của một dự án.
 * Dùng cho FE hiển thị bản đồ (B3 GeofenceMap component).
 */
export async function handleGetGeofence(
  request: AuthenticatedRequest,
  response: Response
): Promise<void> {
  if (!request.authenticatedUser) {
    sendErrorResponse(response, 401, 'Bạn chưa đăng nhập.', 'UNAUTHENTICATED');
    return;
  }

  const { projectId } = request.params;
  if (!projectId?.trim()) {
    sendErrorResponse(response, 400, 'Thiếu projectId.', 'VALIDATION_ERROR');
    return;
  }

  try {
    if (request.authenticatedUser.role === 'organizations') {
      const project = await findProjectById(projectId);
      if (!project) {
        sendErrorResponse(response, 404, 'Dự án không tồn tại.', 'NOT_FOUND');
        return;
      }
      if (project.organizationId !== request.authenticatedUser.userId) {
        sendErrorResponse(response, 403, 'Bạn không có quyền xem geofence của dự án này.', 'FORBIDDEN');
        return;
      }
    }

    const geofence = await findGeofenceByProjectId(projectId);
    if (!geofence) {
      sendErrorResponse(response, 404, 'Dự án chưa có geofence.', 'NOT_FOUND');
      return;
    }
    sendSuccessResponse(response, 200, 'Lấy geofence thành công.', geofence);
  } catch (error) {
    logger.error('Lấy geofence thất bại.', { projectId, errorMessage: (error as Error)?.message });
    sendErrorFromUnknown(response, error, 'Không thể lấy dữ liệu geofence.');
  }
}

/**
 * POST /api/oracle/geofence/:projectId
 * Tạo hoặc cập nhật geofence của dự án (upsert).
 * Dùng cho B5 GeofenceEditor (tổ chức vẽ polygon).
 *
 * Body strict: { polygon: [{lat, lng}, ...], radiusMeters?: number }
 */
export async function handleUpsertGeofence(
  request: AuthenticatedRequest,
  response: Response
): Promise<void> {
  if (!request.authenticatedUser) {
    sendErrorResponse(response, 401, 'Bạn chưa đăng nhập.', 'UNAUTHENTICATED');
    return;
  }

  const { projectId } = request.params;
  if (!projectId?.trim()) {
    sendErrorResponse(response, 400, 'Thiếu projectId.', 'VALIDATION_ERROR');
    return;
  }

  const validationResult = validateGeofenceRequestBody(request.body);
  if (!validationResult.isValid) {
    sendErrorResponse(
      response,
      400,
      'Dữ liệu geofence không hợp lệ.',
      'VALIDATION_ERROR',
      validationResult.errors
    );
    return;
  }

  try {
    // [B1] Kiểm tra quyền sở hữu: chỉ tổ chức sở hữu project mới được cập nhật geofence
    const project = await findProjectById(projectId);
    if (!project) {
      sendErrorResponse(response, 404, 'Dự án không tồn tại.', 'NOT_FOUND');
      return;
    }
    if (project.organizationId !== request.authenticatedUser.userId) {
      sendErrorResponse(response, 403, 'Bạn không có quyền chỉnh sửa geofence của dự án này.', 'FORBIDDEN');
      return;
    }

    const geofence = await upsertProjectGeofence(
      projectId,
      validationResult.data.polygon,
      validationResult.data.radiusMeters
    );
    sendSuccessResponse(response, 200, 'Cập nhật geofence thành công.', geofence);
  } catch (error) {
    logger.error('Upsert geofence thất bại.', { projectId, errorMessage: (error as Error)?.message });
    sendErrorFromUnknown(response, error, 'Không thể cập nhật geofence.');
  }
}

/**
 * POST /api/oracle/override-requests/:overrideRequestId/vote
 * Commissioner (admin hoặc regulatory) vote APPROVE/REJECT cho một override request.
 *
 * Yêu cầu:
 * - Người dùng phải có trong commissionerSnapshot tại thời điểm request tạo (403 nếu không)
 * - Chưa vote lần nào cho request này (409 nếu đã vote)
 * - Request phải ở trạng thái PENDING (422 nếu đã resolve)
 * - Commissioner set không được thay đổi kể từ khi tạo (409 nếu đã thay đổi → EXPIRED)
 *
 * Body: { vote: "APPROVE" | "REJECT", reason: string }
 */
export async function handleVoteOverrideRequest(
  request: AuthenticatedRequest,
  response: Response
): Promise<void> {
  if (!request.authenticatedUser) {
    sendErrorResponse(response, 401, 'Bạn chưa đăng nhập.', 'UNAUTHENTICATED');
    return;
  }

  const { overrideRequestId } = request.params;
  if (!overrideRequestId?.trim()) {
    sendErrorResponse(response, 400, 'Thiếu overrideRequestId.', 'VALIDATION_ERROR');
    return;
  }

  // Validate body bằng Zod schema thay vì manual ad-hoc checks
  const parseResult = voteOverrideBodySchema.safeParse(request.body);
  if (!parseResult.success) {
    // Zod trả về lỗi đầu tiên cho UX tốt nhất
    const firstIssue = parseResult.error.issues[0];
    sendErrorResponse(response, 400, firstIssue.message, 'VALIDATION_ERROR');
    return;
  }
  const { vote, reason } = parseResult.data;

  const { userId, role } = request.authenticatedUser;

  // Chỉ commissioner (admin hoặc regulatory) mới được vote
  if (role !== 'admin' && role !== 'regulatory') {
    sendErrorResponse(response, 403, 'Bạn không có quyền vote override request.', 'FORBIDDEN');
    return;
  }

  try {
    // [B4-fix #2] Kiểm tra IDOR: role của caller phải khớp với role lưu trong commissionerSnapshot
    // tại thời điểm tạo request. Ngăn chặn tình huống admin bị demote sang 'donor' nhưng vote
    // bằng JWT hiện tại → vẫn được ghi nhận vote với role lúc tạo request.
    // [S5-fix] Wrap trong try-catch riêng để trả 503 thay vì 500 khi DB timeout/drop
    let snapshotEntry: { userId: string; role: 'admin' | 'regulatory' } | null = null;
    try {
      snapshotEntry = await findCommissionerInSnapshot(overrideRequestId, userId);
    } catch (dbError) {
      logger.error('findCommissionerInSnapshot DB query thất bại.', {
        overrideRequestId,
        authenticatedUserId: userId,
        errorMessage: (dbError as Error)?.message
      });
      sendErrorResponse(response, 503, 'Dịch vụ tạm thời không khả dụng. Vui lòng thử lại sau.', 'SERVICE_UNAVAILABLE');
      return;
    }

    if (!snapshotEntry) {
      // 403 — không có trong snapshot, không thể vote
      sendErrorResponse(response, 403, 'Bạn không có trong danh sách ủy viên của yêu cầu này.', 'FORBIDDEN');
      return;
    }
    if (snapshotEntry.role !== role) {
      // 403 — role hiện tại khác role lúc tạo snapshot → IDOR prevention
      logger.warn('Role của commissioner thay đổi so với snapshot, từ chối vote.', {
        overrideRequestId,
        authenticatedUserId: userId
      });
      sendErrorResponse(
        response,
        403,
        'Quyền hạn của bạn đã thay đổi kể từ khi yêu cầu được tạo. Vui lòng liên hệ admin để cập nhật.',
        'ROLE_MISMATCH'
      );
      return;
    }

    const auditRequestContext = extractAuditRequestContext(request);
    const outcome = auditRequestContext.ipAddress || auditRequestContext.userAgent
      ? await submitOverrideVote(overrideRequestId, userId, role, vote, reason.trim(), auditRequestContext)
      : await submitOverrideVote(overrideRequestId, userId, role, vote, reason.trim());

    switch (outcome.outcome) {
      case 'VOTE_RECORDED':
        sendSuccessResponse(response, 200, 'Đã ghi nhận vote.', {
          outcome: 'VOTE_RECORDED',
          pendingVoters: outcome.pendingVoters,
          totalVoters: outcome.totalVoters
        });
        break;

      case 'RESOLVED_APPROVED':
        sendSuccessResponse(response, 200, 'Override request đã được toàn bộ ủy viên chấp thuận.', {
          outcome: 'RESOLVED_APPROVED',
          disbursementAutoApproved: outcome.disbursementAutoApproved
        });
        break;

      case 'RESOLVED_REJECTED':
        sendSuccessResponse(response, 200, 'Override request đã bị từ chối.', {
          outcome: 'RESOLVED_REJECTED'
        });
        break;

      case 'EXPIRED_COMMISSIONER_SET_CHANGED':
        // 410 Gone — request đã hết hiệu lực vì danh sách commissioner thay đổi, không phải duplicate
        sendErrorResponse(
          response, 410,
          'Danh sách ủy viên đã thay đổi kể từ khi yêu cầu này được tạo. Yêu cầu đã bị hủy, vui lòng tạo lại.',
          'COMMISSIONER_SET_CHANGED'
        );
        break;
    }
  } catch (error) {
    if (error instanceof VoteRejectedError) {
      switch (error.rejectionReason) {
        case 'REQUEST_NOT_FOUND':
          sendErrorResponse(response, 404, 'Không tìm thấy override request.', 'NOT_FOUND');
          break;
        case 'NOT_IN_SNAPSHOT':
          sendErrorResponse(response, 403, 'Bạn không có trong danh sách ủy viên của yêu cầu này.', 'FORBIDDEN');
          break;
        case 'ALREADY_VOTED':
          sendErrorResponse(response, 409, 'Bạn đã vote cho yêu cầu này rồi.', 'ALREADY_VOTED');
          break;
        case 'REQUEST_NOT_PENDING':
          sendErrorResponse(response, 422, 'Yêu cầu không còn ở trạng thái chờ vote.', 'INVALID_STATE');
          break;
      }
      return;
    }

    logger.error('Vote override request thất bại.', {
      overrideRequestId,
      errorMessage: (error as Error)?.message
    });
    sendErrorFromUnknown(response, error, 'Không thể xử lý vote.');
  }
}

/**
 * GET /api/oracle/override-requests/:overrideRequestId
 * Lấy chi tiết một override request theo ID (dùng cho B4 OverrideVoteDrawer).
 *
 * [B2-fix #6] Endpoint này bị thiếu — B4 UI cần: project name, GPS from image,
 * GPS from project, Haversine distance, vote progress, hasCurrentUserVoted.
 * Response enrich thêm pendingVoters và hasCurrentUserVoted để FE render đúng.
 */
export async function handleGetOverrideRequestById(
  request: AuthenticatedRequest,
  response: Response
): Promise<void> {
  if (!request.authenticatedUser) {
    sendErrorResponse(response, 401, 'Bạn chưa đăng nhập.', 'UNAUTHENTICATED');
    return;
  }

  const { overrideRequestId } = request.params;
  if (!overrideRequestId?.trim()) {
    sendErrorResponse(response, 400, 'Thiếu overrideRequestId.', 'VALIDATION_ERROR');
    return;
  }

  try {
    const overrideRequest = await findOverrideRequestById(overrideRequestId);
    if (!overrideRequest) {
      sendErrorResponse(response, 404, 'Không tìm thấy override request.', 'NOT_FOUND');
      return;
    }

    const { userId } = request.authenticatedUser;
    const totalVoters = overrideRequest.commissionerSnapshot.length;
    const pendingVoters = totalVoters - overrideRequest.votes.length;
    const hasCurrentUserVoted = overrideRequest.votes.some(v => v.commissionerId === userId);

    // Nếu request đã resolve, trả đủ thông tin votes.
    // Nếu còn PENDING, ẩn vote của người khác để tránh collusion (chỉ cho biết số lượng).
    const votes = overrideRequest.status !== 'PENDING'
      ? overrideRequest.votes
      : overrideRequest.votes
          .filter(v => v.commissionerId === userId)
          .map(v => ({ ...v, commissionerId: userId }));

    // [B4-fix #3] Redact userId trong commissionerSnapshot — ngăn chặn enumerate danh sách
    // admin/regulatory. Mỗi entry chỉ giữ role + isCurrentUser (theo userId, không theo role —
    // tránh multi-admin cùng role đều bị đánh dấu isCurrentUser: true).
    // Caller hiện tại vẫn nhận được role riêng của mình qua trường currentCommissionerRole.
    const sanitizedCommissionerSnapshot = overrideRequest.commissionerSnapshot.map(
      (entry) => ({
        role: entry.role,
        isCurrentUser: entry.userId === userId
      })
    );
    const currentCommissionerRole = overrideRequest.commissionerSnapshot.find(
      c => c.userId === userId
    )?.role ?? null;

    // [B3][perf] projectName và geofenceSnapshot đều chỉ phụ thuộc overrideRequest và độc lập
    // với nhau → chạy song song để bớt một round-trip DB mỗi lần mở drawer.
    // Hai lookup được xử lý lỗi KHÁC NHAU theo mức độ quan trọng:
    //  - projectName: không quan trọng cho quyết định vote → nuốt lỗi, fallback về projectId.
    //  - geofenceSnapshot: là dữ liệu quyết định vote → KHÔNG nuốt lỗi. Phân biệt rõ giữa
    //    "đọc DB thất bại" (geofenceSnapshotUnavailable=true) và "record cũ/NO_GEOFENCE thật sự
    //    không có snapshot" (geofenceSnapshot=null). FE dựa vào flag này để hiển thị trạng thái
    //    lỗi/retry riêng cho khối bản đồ thay vì banner "record cũ thiếu snapshot" gây hiểu nhầm.
    const [projectRecord, verificationOutcome] = await Promise.all([
      findProjectById(overrideRequest.projectId).catch(() => null),
      findVerificationById(overrideRequest.verificationId)
        .then((record) => ({ readFailed: false, record }))
        .catch((verificationError: unknown) => {
          logger.error('Đọc geofence snapshot của verification thất bại.', {
            overrideRequestId,
            verificationId: overrideRequest.verificationId,
            errorMessage: (verificationError as Error)?.message
          });
          return { readFailed: true, record: null };
        })
    ]);

    const enrichedProjectName = projectRecord?.name ?? null;

    // Chỉ trả null khi thực sự không có snapshot (record cũ/NO_GEOFENCE). Khi đọc DB thất bại,
    // giữ snapshot=null NHƯNG bật cờ geofenceSnapshotUnavailable để FE không diễn giải sai.
    const geofenceSnapshotUnavailable = verificationOutcome.readFailed;
    const geofenceSnapshot = verificationOutcome.record?.geofenceSnapshot ?? null;

    sendSuccessResponse(response, 200, 'Lấy override request thành công.', {
      ...overrideRequest,
      projectName: enrichedProjectName,
      projectDisplayName: enrichedProjectName ?? overrideRequest.projectId,
      geofenceSnapshot,
      geofenceSnapshotUnavailable,
      commissionerSnapshot: sanitizedCommissionerSnapshot,
      currentCommissionerRole,
      votes,
      pendingVoters,
      totalVoters,
      hasCurrentUserVoted
    });
  } catch (error) {
    logger.error('Lấy override request thất bại.', {
      overrideRequestId,
      errorMessage: (error as Error)?.message
    });
    sendErrorFromUnknown(response, error, 'Không thể lấy override request.');
  }
}

/**
 * GET /api/oracle/pending-overrides
 * Lấy danh sách override request đang PENDING (dùng cho B4 Admin UI).
 *
 * [B4-fix #3] Redact userId trong commissionerSnapshot ở cả list endpoint
 * để ngăn chặn enumerate danh sách admin/regulatory qua API list.
 */
export async function handleGetPendingOverrides(
  request: AuthenticatedRequest,
  response: Response
): Promise<void> {
  if (!request.authenticatedUser) {
    sendErrorResponse(response, 401, 'Bạn chưa đăng nhập.', 'UNAUTHENTICATED');
    return;
  }

  const limitRaw = request.query['limit'];
  const skipRaw = request.query['skip'];
  const limit = typeof limitRaw === 'string' ? Math.min(parseInt(limitRaw, 10) || 20, 100) : 20;
  const skip = typeof skipRaw === 'string' ? parseInt(skipRaw, 10) || 0 : 0;

  try {
    const [items, total] = await Promise.all([
      findPendingOverrideRequests(limit, skip),
      countPendingOverrideRequests()
    ]);

    const { userId } = request.authenticatedUser;

    // [P1-fix] Batch lookup projectName sử dụng $in query thay vì N concurrent queries
    // Trước đây: Promise.all(uniqueIds.map(id => findProjectById(id))) tạo N queries riêng lẻ
    // Bây giờ: findProjectsByIdList dùng $in để fetch tất cả trong 1 query
    const uniqueProjectIds = [...new Set(items.map(item => item.projectId))];
    const projectRecords = await findProjectsByIdList(uniqueProjectIds);
    const projectRecordsMap = new Map(
      projectRecords.map(p => [p.projectId, p])
    );

    // [B4-fix #6] Enrich từng item với projectName từ map. Fallback về projectId khi project bị xóa.
    const sanitizedItems = items.map((item) => {
      const projectRecord = projectRecordsMap.get(item.projectId) ?? null;
      const enrichedProjectName = projectRecord?.name ?? null;
      return {
        ...item,
        projectName: enrichedProjectName,
        projectDisplayName: enrichedProjectName ?? item.projectId,
        commissionerSnapshot: item.commissionerSnapshot.map((entry) => ({
          role: entry.role,
          isCurrentUser: entry.userId === userId
        })),
        currentCommissionerRole: item.commissionerSnapshot.find(c => c.userId === userId)?.role ?? null,
        // Ở PENDING, votes của người khác bị ẩn để chống collusion.
        votes: item.votes.filter(v => v.commissionerId === userId)
      };
    });

    sendSuccessResponse(response, 200, 'Lấy danh sách override request thành công.', {
      items: sanitizedItems,
      total,
      limit,
      skip
    });
  } catch (error) {
    logger.error('Lấy pending overrides thất bại.', { errorMessage: (error as Error)?.message });
    sendErrorFromUnknown(response, error, 'Không thể lấy danh sách override request.');
  }
}
