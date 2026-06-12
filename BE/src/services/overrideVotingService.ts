import { getLogger } from '../config/logger';
import {
  findOverrideRequestById,
  addVoteToOverrideRequest,
  resolveOverrideRequest,
  expireOverrideRequest,
  type CommissionerVote,
  type OracleOverrideRequestRecord
} from '../models/oracleOverrideRequestModel';
import { findUsersByRole } from '../models/authModel';
import {
  findDisbursementByRequestId,
  updateDisbursementByRequestIdWithCondition
} from '../models/disbursementModel';
import { createUserNotification } from './notificationService';
import { oracleEvents, type OverrideExecutedEventPayload } from '../events/oracleEvents';

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
 * 3. Kiểm tra đã vote chưa (409 nếu rồi)
 * 4. Phát hiện thay đổi commissioner set — expire nếu khác snapshot
 * 5. Thêm vote vào DB (atomic $push)
 * 6. Kiểm tra điều kiện kết thúc:
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
  reason: string
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

  // Bước 3: Chống vote lại
  const hasAlreadyVoted = overrideRequest.votes.some(
    v => v.commissionerId === commissionerId
  );
  if (hasAlreadyVoted) {
    throw new VoteRejectedError('ALREADY_VOTED');
  }

  // Bước 4: Phát hiện thay đổi commissioner set
  // Nếu tập userId của admin/regulatory hiện tại khác snapshot → expire để tạo lại
  const isCommissionerSetChanged = await detectCommissionerSetChange(overrideRequest);
  if (isCommissionerSetChanged) {
    await expireOverrideRequest(overrideRequestId, new Date());
    logger.warn('Commissioner set thay đổi. Override request expired.', {
      overrideRequestId,
      authenticatedUserId: commissionerId
    });
    // Notify tất cả ủy viên cũ trong snapshot biết request đã hết hiệu lực
    await notifyCommissionersOverrideExpired(overrideRequest);
    return { outcome: 'EXPIRED_COMMISSIONER_SET_CHANGED' };
  }

  // Bước 5: Thêm vote
  const newVote: CommissionerVote = {
    commissionerId,
    commissionerRole,
    vote,
    reason,
    votedAt: new Date()
  };
  const updatedRequest = await addVoteToOverrideRequest(overrideRequestId, newVote);
  if (!updatedRequest) {
    // Race condition: request không còn PENDING khi chúng ta vào bước 5 (concurrent vote REJECT vừa resolve)
    throw new VoteRejectedError('REQUEST_NOT_PENDING');
  }

  logger.info('Commissioner đã vote.', {
    overrideRequestId,
    authenticatedUserId: commissionerId,
    voteOutcome: vote
  });

  // Bước 6: Kiểm tra điều kiện kết thúc
  return await evaluateVoteOutcome(updatedRequest);
}

/**
 * So sánh commissionerSnapshot với danh sách admin/regulatory hiện tại.
 * Trả về true nếu tập userId đã thay đổi (thêm hoặc xóa bất kỳ ai).
 */
async function detectCommissionerSetChange(
  overrideRequest: OracleOverrideRequestRecord
): Promise<boolean> {
  const currentCommissioners = await findUsersByRole(['admin', 'regulatory']);
  const currentIds = new Set(currentCommissioners.map(u => u.id));
  const snapshotIds = new Set(overrideRequest.commissionerSnapshot.map(c => c.userId));

  if (currentIds.size !== snapshotIds.size) return true;
  for (const id of snapshotIds) {
    if (!currentIds.has(id)) return true;
  }
  return false;
}

/**
 * Đánh giá kết quả sau khi vote được ghi — quyết định request có kết thúc chưa.
 * Gọi sau khi updatedRequest đã có vote mới nhất.
 */
async function evaluateVoteOutcome(
  request: OracleOverrideRequestRecord
): Promise<VoteOutcome> {
  const totalVoters = request.commissionerSnapshot.length;
  const votes = request.votes;

  // Bất kỳ REJECT → kết thúc ngay, không cần chờ đủ N người
  const hasReject = votes.some(v => v.vote === 'REJECT');
  if (hasReject) {
    const resolved = await resolveOverrideRequest(request.overrideRequestId, 'REJECTED', new Date());
    if (resolved) {
      await notifyOrganizationOverrideResult(resolved, false);
      // Emit để socket bridge thông báo commissioner request đã bị từ chối
      oracleEvents.emit('override.executed', {
        overrideRequestId: resolved.overrideRequestId,
        projectId: resolved.projectId,
        organizationId: resolved.organizationId,
        evidenceCid: resolved.evidenceCid,
        disbursementRequestId: resolved.disbursementRequestId,
        totalVoters,
        executedAt: new Date(),
        status: 'REJECTED'
      } satisfies OverrideExecutedEventPayload);
    }
    logger.info('Override request bị REJECTED.', {
      overrideRequestId: request.overrideRequestId,
      projectId: request.projectId
    });
    return { outcome: 'RESOLVED_REJECTED' };
  }

  // Kiểm tra tất cả APPROVE — guard totalVoters > 0 tránh auto-approve khi snapshot rỗng
  const approveCount = votes.filter(v => v.vote === 'APPROVE').length;
  if (totalVoters > 0 && approveCount >= totalVoters) {
    const resolved = await resolveOverrideRequest(request.overrideRequestId, 'APPROVED', new Date());
    if (!resolved) {
      // Concurrent race — một request khác đã resolve trước
      return { outcome: 'VOTE_RECORDED', pendingVoters: 0, totalVoters };
    }

    // Auto-approve disbursement nếu có link
    const disbursementAutoApproved = await tryAutoApproveDisbursement(
      resolved.disbursementRequestId,
      resolved.overrideRequestId
    );

    // Emit override.executed (TODO: cần oracle contract để ghi on-chain)
    oracleEvents.emit('override.executed', {
      overrideRequestId: resolved.overrideRequestId,
      projectId: resolved.projectId,
      organizationId: resolved.organizationId,
      evidenceCid: resolved.evidenceCid,
      disbursementRequestId: resolved.disbursementRequestId,
      totalVoters,
      executedAt: new Date(),
      status: 'APPROVED'
    } satisfies OverrideExecutedEventPayload);

    await notifyOrganizationOverrideResult(resolved, true);

    logger.info('Override request APPROVED — tất cả commissioner đã vote.', {
      overrideRequestId: resolved.overrideRequestId,
      projectId: resolved.projectId,
      disbursementRequestId: resolved.disbursementRequestId ?? undefined  // null → undefined cho LogMetadata
    });

    return { outcome: 'RESOLVED_APPROVED', disbursementAutoApproved };
  }

  // Chưa đủ → ghi nhận vote, trả về số người còn chờ
  const pendingVoters = totalVoters - votes.length;
  return { outcome: 'VOTE_RECORDED', pendingVoters, totalVoters };
}

/**
 * Tự động approve disbursement request tương ứng khi override được N/N APPROVE.
 * Chỉ approve nếu disbursement vẫn ở trạng thái PENDING (idempotent với condition update).
 * Trả về true nếu disbursement được approve thành công.
 */
async function tryAutoApproveDisbursement(
  disbursementRequestId: string | null,
  overrideRequestId: string
): Promise<boolean> {
  if (!disbursementRequestId) return false;

  const disbursement = await findDisbursementByRequestId(disbursementRequestId);
  if (!disbursement) {
    logger.warn('Disbursement không tìm thấy khi auto-approve.', {
      overrideRequestId, disbursementRequestId
    });
    return false;
  }

  const updated = await updateDisbursementByRequestIdWithCondition(
    disbursementRequestId,
    { status: 'PENDING' },
    { status: 'APPROVED' }
  );

  if (!updated) {
    // Disbursement không còn PENDING — đã được xử lý bởi luồng khác, không phải lỗi
    logger.info('Disbursement không ở trạng thái PENDING khi auto-approve (đã xử lý trước).', {
      overrideRequestId, disbursementRequestId, currentStatus: disbursement.status
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

  await Promise.allSettled(notifyPromises);
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
