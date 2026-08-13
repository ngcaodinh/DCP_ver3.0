import { getLogger } from '../config/logger';
import {
  findOverrideRequestById,
  addVoteToOverrideRequest,
  resolveOverrideRequest,
  expireOverrideRequest,
  type CommissionerVote,
  type OracleOverrideRequestRecord
} from '../models/oracleOverrideRequestModel';
import { findActiveCommissioners, type AuthUser } from '../models/authModel';
import {
  findDisbursementByRequestId,
  updateDisbursementByRequestIdWithCondition
} from '../models/disbursementModel';
import { recordAdminAuditLog } from './audit-log.service';
import type { AuditRequestContext } from '../utils/auditRequestContext';
import { runMongoTransaction } from '../utils/mongoTransaction';
import { logOverrideApproved, logOverrideRejected, logOverrideExpired } from './multisigOverrideLog.service';
import { createUserNotification } from './notificationService';
import { oracleEvents, type OverrideExecutedEventPayload } from '../events/oracleEvents';
import { getRedisClientIfReady } from '../config/redis';
import type { ClientSession } from 'mongoose';

const logger = getLogger();

/**
 * Kết quả trả về sau khi xử lý một lượt vote.
 * Controller dùng outcome để map sang HTTP status code tương ứng.
 */
export type VoteOutcome =
  | { outcome: 'VOTE_RECORDED'; pendingVoters: number; totalVoters: number }
  | { outcome: 'RESOLVED_APPROVED'; disbursementAutoApproved: boolean }
  | { outcome: 'RESOLVED_REJECTED' }
  | { outcome: 'EXPIRED_COMMISSIONER_SET_CHANGED' };

/**
 * Lý do lỗi business rule khi vote bị từ chối.
 * Controller map sang 403/409/422 tương ứng.
 */
export type VoteRejectionReason =
  | 'NOT_IN_SNAPSHOT'         // 403 — commissioner không có trong snapshot
  | 'ALREADY_VOTED'           // 409 — đã vote rồi
  | 'REQUEST_NOT_PENDING'     // 422 — request không ở trạng thái PENDING
  | 'REQUEST_NOT_FOUND';      // 404

export class VoteRejectedError extends Error {
  constructor(public readonly rejectionReason: VoteRejectionReason) {
    super(`Vote rejected: ${rejectionReason}`);
    this.name = 'VoteRejectedError';
  }
}

/**
 * Hàm xử lý lượt vote của một commissioner cho override request.
 *
 * Flow:
 * 1. Load request, kiểm tra tồn tại và trạng thái PENDING
 * 2. Kiểm tra commissionerId có trong snapshot (403 nếu không)
 * 3. Phát hiện thay đổi commissioner set — expire nếu khác snapshot
 * 4. Thêm vote vào DB với atomic check ngăn duplicate vote (chặn race condition ở tầng DB)
 * 5. Kiểm tra điều kiện kết thúc:
 *    - Bất kỳ REJECT → resolve REJECTED, notify org
 *    - Tất cả APPROVE → resolve APPROVED, auto-approve disbursement nếu có, emit override.executed
 *
 * @param overrideRequestId - ID override request cần vote
 * @param commissionerId    - userId của commissioner đang vote (từ JWT)
 * @param commissionerRole  - role của commissioner (từ JWT)
 * @param vote              - APPROVE hoặc REJECT
 * @param reason            - Lý do vote (bắt buộc theo spec)
 */
export async function submitOverrideVote(
  overrideRequestId: string,
  commissionerId: string,
  commissionerRole: string,
  vote: 'APPROVE' | 'REJECT',
  reason: string,
  auditRequestContext?: AuditRequestContext
): Promise<VoteOutcome> {
  // Bước 1: Load và kiểm tra request
  const overrideRequest = await findOverrideRequestById(overrideRequestId);
  if (!overrideRequest) {
    throw new VoteRejectedError('REQUEST_NOT_FOUND');
  }
  if (overrideRequest.status !== 'PENDING') {
    throw new VoteRejectedError('REQUEST_NOT_PENDING');
  }

  // Bước 2: Commissioner phải có trong snapshot tại thời điểm request được tạo
  const isInSnapshot = overrideRequest.commissionerSnapshot.some(
    c => c.userId === commissionerId
  );
  if (!isInSnapshot) {
    logger.warn('Commissioner không trong snapshot, từ chối vote.', {
      overrideRequestId, authenticatedUserId: commissionerId
    });
    throw new VoteRejectedError('NOT_IN_SNAPSHOT');
  }

  // Bước 3: Phát hiện thay đổi commissioner set (bỏ check ALREADY_VOTED ở đây vì sẽ check atomic ở bước 5)
  // Nếu tuple [userId, role] của admin/regulatory hiện tại khác snapshot → expire để tạo lại
  const isCommissionerSetChanged = await detectCommissionerSetChange(overrideRequest);
  if (isCommissionerSetChanged) {
    const expiredRequest = await runMongoTransaction(async (session) => {
      const expired = session
        ? await expireOverrideRequest(overrideRequestId, new Date(), session)
        : await expireOverrideRequest(overrideRequestId, new Date());
      if (!expired) return null;
      await recordAdminAuditLog({
        actionId: `override-expired:${overrideRequestId}`,
        actorType: 'SYSTEM',
        adminId: null,
        adminRole: null,
        actionType: 'OVERRIDE_EXPIRED',
        targetId: overrideRequestId,
        targetType: 'OVERRIDE_REQUEST',
        reason: 'Commissioner set changed',
        context: {
          overrideRequestId,
          projectId: expired.projectId,
          organizationId: expired.organizationId,
          commissionerSnapshotSize: expired.commissionerSnapshot.length,
          outcome: 'EXPIRED_COMMISSIONER_SET_CHANGED'
        },
        session
      });
      return expired;
    });
    if (!expiredRequest) throw new VoteRejectedError('REQUEST_NOT_PENDING');
    logger.warn('Commissioner set thay đổi. Override request expired.', {
      overrideRequestId,
      authenticatedUserId: commissionerId
    });
    // [D5] Ghi audit trail vào multisig_override_logs
    // Fetch lại request từ DB vì expiredAt đã được ghi bởi expireOverrideRequest
    const updatedRequest = expiredRequest;
    if (!updatedRequest) {
      // Race condition: request không fetch được sau expire (replica lag hoặc bị xóa)
      // — không block vote flow, chỉ log error và skip audit log
      logger.error('Không fetch được override request sau khi expire. Skip multisig_override_logs EXPIRED.', {
        overrideRequestId
      });
    } else {
      void Promise.resolve(logOverrideExpired(updatedRequest, commissionerId)).catch((err: Error) => {
        logger.error('Ghi multisig_override_logs EXPIRED thất bại.', {
          overrideRequestId, errorMessage: err.message
        });
      });
    }
    // Notify tất cả ủy viên cũ trong snapshot biết request đã hết hiệu lực
    await notifyCommissionersOverrideExpired(overrideRequest);
    return { outcome: 'EXPIRED_COMMISSIONER_SET_CHANGED' };
  }

  // Bước 4: Thêm vote với atomic check ngăn duplicate vote từ cùng một commissioner
  const newVote: CommissionerVote = {
    commissionerId,
    commissionerRole,
    vote,
    reason,
    votedAt: new Date()
  };
  const transactionResult = await runMongoTransaction(async (session) => {
    const addResult = await addVoteToOverrideRequest(overrideRequestId, newVote, session);
    if (addResult === 'ALREADY_VOTED') throw new VoteRejectedError('ALREADY_VOTED');
    if (addResult === 'NOT_PENDING') throw new VoteRejectedError('REQUEST_NOT_PENDING');

    const updated = await findOverrideRequestById(overrideRequestId, session);
    if (!updated) {
      logger.error('Không fetch được override request ngay sau khi ghi vote.', { overrideRequestId });
      throw new VoteRejectedError('REQUEST_NOT_FOUND');
    }

    const resolution = await resolveVoteOutcome(updated, session);

    // Vote, final resolution và audit phải commit cùng nhau; không để outcome mồ côi.
    await recordAdminAuditLog({
      actionId: `override-vote:${overrideRequestId}:${commissionerId}`,
      actorType: 'ADMIN',
      adminId: commissionerId,
      adminRole: commissionerRole,
      actionType: vote === 'APPROVE' ? 'OVERRIDE_VOTE_APPROVE' : 'OVERRIDE_VOTE_REJECT',
      targetId: overrideRequestId,
      targetType: 'OVERRIDE_REQUEST',
      reason,
      requestContext: auditRequestContext,
      context: {
        overrideRequestId,
        projectId: updated.projectId,
        organizationId: updated.organizationId,
        disbursementRequestId: updated.disbursementRequestId,
        commissionerSnapshotSize: updated.commissionerSnapshot.length,
        vote,
        voteCountAfter: updated.votes.length,
        outcome: resolution.voteOutcome.outcome
      },
      session
    });
    return { updatedRequest: updated, ...resolution };
  });

  logger.info('Commissioner đã vote.', {
    overrideRequestId,
    authenticatedUserId: commissionerId,
    voteOutcome: vote
  });

  // Notification, socket và legacy multisig log là side effect hậu commit của final resolution.
  if (transactionResult.resolvedRequest) {
    await publishResolvedOverrideOutcome(
      transactionResult.resolvedRequest,
      transactionResult.voteOutcome,
      transactionResult.disbursementAutoApproved
    );
  }

  return transactionResult.voteOutcome;
}

type VoteTransactionResult = {
  voteOutcome: VoteOutcome;
  resolvedRequest: OracleOverrideRequestRecord | null;
  disbursementAutoApproved: boolean;
};

const COMMISSIONER_CACHE_KEY = 'commissioners:active';
const COMMISSIONER_CACHE_TTL_S = 5; // [S4-fix] 5 giây thay vì 30s — giảm race window cho revoked commissioner

/**
 * Lấy danh sách commissioner đang active, ưu tiên từ Redis cache (TTL 30s).
 *
 * [B2-fix #8] findActiveCommissioners() chạy per-vote trước đây — với nhiều request PENDING
 * đồng thời, mỗi vote = 1 DB query. Cache TTL 30s giảm 300 queries/giờ xuống còn 120.
 * Khi admin role thay đổi: TTL ngắn đủ để phát hiện trong vòng 30s.
 */
async function getCachedActiveCommissioners(): Promise<AuthUser[]> {
  const redis = getRedisClientIfReady();
  if (redis) {
    try {
      const cached = await redis.get(COMMISSIONER_CACHE_KEY);
      if (cached) return JSON.parse(cached) as AuthUser[];
      const fresh = await findActiveCommissioners();
      await redis.setEx(COMMISSIONER_CACHE_KEY, COMMISSIONER_CACHE_TTL_S, JSON.stringify(fresh));
      return fresh;
    } catch {
      // Redis lỗi → fallback sang DB, không block vote flow
    }
  }
  return findActiveCommissioners();
}

/**
 * So sánh commissionerSnapshot với danh sách admin/regulatory hiện tại.
 * Trả về true nếu bộ tuple [userId, role] đã thay đổi.
 *
 * [B2-fix #1] Đổi từ so sánh userId đơn thuần sang tuple [userId::role].
 * Lý do: nếu chỉ so sánh userId, admin bị demote sang 'donor' vẫn có userId trùng snapshot
 * → detectCommissionerSetChange trả false → họ vẫn vote được dù đã mất authority.
 */
async function detectCommissionerSetChange(
  overrideRequest: OracleOverrideRequestRecord
): Promise<boolean> {
  const currentCommissioners = await getCachedActiveCommissioners();
  const currentKeys = new Set(currentCommissioners.map(u => `${u.id}::${u.role}`));
  const snapshotKeys = new Set(
    overrideRequest.commissionerSnapshot.map(c => `${c.userId}::${c.role}`)
  );

  if (currentKeys.size !== snapshotKeys.size) return true;
  for (const key of snapshotKeys) {
    if (!currentKeys.has(key)) return true;
  }
  return false;
}

/** Xác định và commit final resolution trong cùng transaction với vote và audit. */
async function resolveVoteOutcome(
  request: OracleOverrideRequestRecord,
  session?: ClientSession
): Promise<VoteTransactionResult> {
  const totalVoters = request.commissionerSnapshot.length;
  const votes = request.votes;

  // Bất kỳ REJECT → kết thúc ngay, không cần chờ đủ N người
  const hasReject = votes.some(v => v.vote === 'REJECT');
  if (hasReject) {
    const resolved = session
      ? await resolveOverrideRequest(request.overrideRequestId, 'REJECTED', new Date(), session)
      : await resolveOverrideRequest(request.overrideRequestId, 'REJECTED', new Date());
    if (!resolved) throw new VoteRejectedError('REQUEST_NOT_PENDING');
    return {
      voteOutcome: { outcome: 'RESOLVED_REJECTED' },
      resolvedRequest: resolved,
      disbursementAutoApproved: false
    };
  }

  // Kiểm tra tất cả APPROVE — guard totalVoters > 0 tránh auto-approve khi snapshot rỗng
  const approveCount = votes.filter(v => v.vote === 'APPROVE').length;
  if (totalVoters > 0 && approveCount >= totalVoters) {
    const resolved = session
      ? await resolveOverrideRequest(request.overrideRequestId, 'APPROVED', new Date(), session)
      : await resolveOverrideRequest(request.overrideRequestId, 'APPROVED', new Date());
    if (!resolved) throw new VoteRejectedError('REQUEST_NOT_PENDING');

    const disbursementAutoApproved = await tryAutoApproveDisbursement(
      resolved.disbursementRequestId,
      resolved.overrideRequestId,
      session
    );
    return {
      voteOutcome: { outcome: 'RESOLVED_APPROVED', disbursementAutoApproved },
      resolvedRequest: resolved,
      disbursementAutoApproved
    };
  }

  // Chưa đủ → ghi nhận vote, trả về số người còn chờ
  const pendingVoters = totalVoters - votes.length;
  return {
    voteOutcome: { outcome: 'VOTE_RECORDED', pendingVoters, totalVoters },
    resolvedRequest: null,
    disbursementAutoApproved: false
  };
}

/** Phát các side effect của final resolution sau khi transaction đã commit thành công. */
async function publishResolvedOverrideOutcome(
  resolved: OracleOverrideRequestRecord,
  outcome: VoteOutcome,
  disbursementAutoApproved: boolean
): Promise<void> {
  if (outcome.outcome === 'RESOLVED_REJECTED') {
    const rejectingVote = resolved.votes.find(vote => vote.vote === 'REJECT');
    if (rejectingVote) {
      void Promise.resolve(logOverrideRejected(resolved, rejectingVote)).catch((error: Error) => {
        logger.error('Ghi multisig_override_logs REJECTED thất bại.', {
          overrideRequestId: resolved.overrideRequestId, errorMessage: error.message
        });
      });
    }
    await notifyOrganizationOverrideResult(resolved, false);
    oracleEvents.emit('override.executed', {
      overrideRequestId: resolved.overrideRequestId,
      projectId: resolved.projectId,
      organizationId: resolved.organizationId,
      evidenceCid: resolved.evidenceCid,
      disbursementRequestId: resolved.disbursementRequestId,
      totalVoters: resolved.commissionerSnapshot.length,
      executedAt: new Date(),
      status: 'REJECTED'
    } satisfies OverrideExecutedEventPayload);
    logger.info('Override request bị REJECTED.', {
      overrideRequestId: resolved.overrideRequestId,
      projectId: resolved.projectId
    });
    return;
  }

  if (outcome.outcome !== 'RESOLVED_APPROVED') return;
  const finalVote = resolved.votes[resolved.votes.length - 1];
  if (finalVote) {
    void Promise.resolve(logOverrideApproved(resolved, finalVote, disbursementAutoApproved)).catch((error: Error) => {
      logger.error('Ghi multisig_override_logs APPROVED thất bại.', {
        overrideRequestId: resolved.overrideRequestId, errorMessage: error.message
      });
    });
  }
  oracleEvents.emit('override.executed', {
    overrideRequestId: resolved.overrideRequestId,
    projectId: resolved.projectId,
    organizationId: resolved.organizationId,
    evidenceCid: resolved.evidenceCid,
    disbursementRequestId: resolved.disbursementRequestId,
    totalVoters: resolved.commissionerSnapshot.length,
    executedAt: new Date(),
    status: 'APPROVED'
  } satisfies OverrideExecutedEventPayload);
  await notifyOrganizationOverrideResult(resolved, true);
  logger.info('Override request APPROVED — tất cả commissioner đã vote.', {
    overrideRequestId: resolved.overrideRequestId,
    projectId: resolved.projectId,
    disbursementRequestId: resolved.disbursementRequestId ?? undefined
  });
}

/**
 * Tự động approve disbursement request tương ứng khi override được N/N APPROVE.
 * Chỉ approve nếu disbursement vẫn ở trạng thái PENDING (idempotent với condition update).
 * Trả về true nếu disbursement được approve thành công.
 */
async function tryAutoApproveDisbursement(
  disbursementRequestId: string | null,
  overrideRequestId: string,
  session?: ClientSession
): Promise<boolean> {
  if (!disbursementRequestId) return false;

  const disbursement = await findDisbursementByRequestId(disbursementRequestId, session);
  if (!disbursement) {
    logger.warn('Disbursement không tìm thấy khi auto-approve.', {
      overrideRequestId, disbursementRequestId
    });
    return false;
  }

  const updated = session
    ? await updateDisbursementByRequestIdWithCondition(
      disbursementRequestId,
      { status: 'PENDING' },
      { status: 'APPROVED' },
      session
    )
    : await updateDisbursementByRequestIdWithCondition(
      disbursementRequestId,
      { status: 'PENDING' },
      { status: 'APPROVED' }
    );

  if (!updated) {
    // [B2-fix #3] Phân biệt log level theo trạng thái:
    // EXECUTING/COMPLETED → WARN (race condition bất thường, cần attention)
    // FAILED/REJECTED/APPROVED → INFO (đã xử lý bởi luồng khác, bình thường)
    const dangerousStates = ['EXECUTING', 'COMPLETED'];
    const logFn = dangerousStates.includes(disbursement.status ?? '') ? logger.warn : logger.info;
    logFn('Disbursement không ở trạng thái PENDING khi auto-approve.', {
      overrideRequestId,
      disbursementRequestId,
      currentStatus: disbursement.status
    });
    return false;
  }

  logger.info('Disbursement auto-approved sau khi override được chấp thuận.', {
    overrideRequestId, disbursementRequestId
  });
  return true;
}

/**
 * Thông báo đến tất cả ủy viên trong snapshot khi override request bị expire do commissioner set thay đổi.
 * Mục đích: ủy viên cũ biết request đã hết hiệu lực và không cần action thêm.
 * [A8-fix] Log aggregate summary để ops có visibility vào notification system health.
 */
async function notifyCommissionersOverrideExpired(
  request: OracleOverrideRequestRecord
): Promise<void> {
  const notifyPromises = request.commissionerSnapshot.map(({ userId }) =>
    createUserNotification({
      userId,
      notificationType: 'SYSTEM',
      title: 'Yêu cầu ghi đè GPS đã hết hiệu lực',
      content: `Yêu cầu ghi đè GPS cho dự án ${request.projectId} đã hết hiệu lực do danh sách ủy viên thay đổi. Một yêu cầu mới sẽ được tạo khi tổ chức re-submit minh chứng.`,
      metadata: {
        overrideRequestId: request.overrideRequestId,
        projectId: request.projectId
      },
      deduplicationKey: `override-expired-${request.overrideRequestId}-${userId}`
    }).catch((err: Error) => {
      logger.error('Gửi notification expire override thất bại cho commissioner.', {
        overrideRequestId: request.overrideRequestId,
        authenticatedUserId: userId,
        errorMessage: err.message
      });
    })
  );

  const results = await Promise.allSettled(notifyPromises);
  const successCount = results.filter(r => r.status === 'fulfilled').length;
  const failureCount = results.filter(r => r.status === 'rejected').length;
  
  // [A8-fix] Aggregate summary log cho ops visibility
  if (failureCount > 0) {
    logger.warn('Một số notification expire override gửi thất bại.', {
      overrideRequestId: request.overrideRequestId,
      successCount,
      failureCount,
      totalCommissioners: request.commissionerSnapshot.length
    });
  }
}

/**
 * Thông báo cho tổ chức kết quả override request.
 * Dùng SYSTEM notification type vì chưa có type riêng cho oracle override.
 */
async function notifyOrganizationOverrideResult(
  request: OracleOverrideRequestRecord,
  isApproved: boolean
): Promise<void> {
  try {
    const title = isApproved
      ? 'Yêu cầu ghi đè GPS đã được chấp thuận'
      : 'Yêu cầu ghi đè GPS bị từ chối';
    const content = isApproved
      ? `Yêu cầu ghi đè GPS cho dự án ${request.projectId} đã được toàn bộ ủy viên phê duyệt.${
          request.disbursementRequestId ? ' Yêu cầu giải ngân đã được tự động duyệt.' : ''
        }`
      : `Yêu cầu ghi đè GPS cho dự án ${request.projectId} bị từ chối. Liên hệ quản trị viên để biết thêm chi tiết.`;

    await createUserNotification({
      userId: request.organizationId,
      notificationType: 'SYSTEM',
      title,
      content,
      metadata: {
        overrideRequestId: request.overrideRequestId,
        projectId: request.projectId,
        disbursementRequestId: request.disbursementRequestId
      },
      deduplicationKey: `override-result-${request.overrideRequestId}`
    });
  } catch (notifyError) {
    // Notification thất bại không nên block kết quả vote — log và tiếp tục
    logger.error('Gửi notification override result thất bại.', {
      errorMessage: (notifyError as Error)?.message,
      overrideRequestId: request.overrideRequestId
    });
  }
}
