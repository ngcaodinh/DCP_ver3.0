import type { OracleOverrideRequestRecord, CommissionerVote } from '../models/oracleOverrideRequestModel';
import { createMultisigOverrideLog } from '../models/multisigOverrideLogModel';
import { getLogger } from '../config/logger';

const logger = getLogger();

/**
 * Ghi log khi override request được APPROVED bởi vote cuối cùng.
 * Ghi OFF-CHAIN record với action=OVERRIDE_VOTE_APPROVE và resolution=APPROVED.
 * Không throw nếu ghi log thất bại — chỉ log error.
 */
export async function logOverrideApproved(
  request: OracleOverrideRequestRecord,
  approvingVote: CommissionerVote,
  disbursementAutoApproved: boolean
): Promise<void> {
  try {
    await createMultisigOverrideLog({
      multisigOverrideLogId: `MOLOG-${request.overrideRequestId}-APPROVE`,
      overrideRequestId: request.overrideRequestId,
      projectId: request.projectId,
      operator: approvingVote.commissionerId,
      operatorRole: approvingVote.commissionerRole,
      action: 'OVERRIDE_VOTE_APPROVE',
      resolution: 'APPROVED',
      reason: approvingVote.reason,
      txHash: null,
      blockNumber: null,
      eventTimestamp: request.resolvedAt ?? new Date(),
      metadata: { disbursementAutoApproved },
    });
    logger.info('Đã ghi multisig_override_log APPROVED', {
      overrideRequestId: request.overrideRequestId,
      projectId: request.projectId,
      operator: approvingVote.commissionerId,
    });
  } catch (error) {
    logger.error('Lỗi khi ghi multisig_override_log cho override APPROVED', {
      error: error instanceof Error ? error.message : String(error),
      overrideRequestId: request.overrideRequestId,
    });
  }
}

/**
 * Ghi log khi override request bị REJECTED bởi vote REJECT.
 * Ghi OFF-CHAIN record với action=OVERRIDE_VOTE_REJECT và resolution=REJECTED.
 * Không throw nếu ghi log thất bại — chỉ log error.
 */
export async function logOverrideRejected(
  request: OracleOverrideRequestRecord,
  rejectingVote: CommissionerVote
): Promise<void> {
  try {
    await createMultisigOverrideLog({
      multisigOverrideLogId: `MOLOG-${request.overrideRequestId}-REJECT`,
      overrideRequestId: request.overrideRequestId,
      projectId: request.projectId,
      operator: rejectingVote.commissionerId,
      operatorRole: rejectingVote.commissionerRole,
      action: 'OVERRIDE_VOTE_REJECT',
      resolution: 'REJECTED',
      reason: rejectingVote.reason,
      txHash: null,
      blockNumber: null,
      eventTimestamp: request.resolvedAt ?? new Date(),
      metadata: {},
    });
    logger.info('Đã ghi multisig_override_log REJECTED', {
      overrideRequestId: request.overrideRequestId,
      projectId: request.projectId,
      operator: rejectingVote.commissionerId,
    });
  } catch (error) {
    logger.error('Lỗi khi ghi multisig_override_log cho override REJECTED', {
      error: error instanceof Error ? error.message : String(error),
      overrideRequestId: request.overrideRequestId,
    });
  }
}

/**
 * Ghi log khi override request bị EXPIRED do commissioner set thay đổi.
 * Ghi OFF-CHAIN record với action=OVERRIDE_EXPIRED và resolution=EXPIRED.
 * Sử dụng expiredByCommissionerId làm operator (commissioner đã trigger expiry).
 * Không throw nếu ghi log thất bại — chỉ log error.
 */
export async function logOverrideExpired(
  request: OracleOverrideRequestRecord,
  expiredByCommissionerId: string
): Promise<void> {
  try {
    await createMultisigOverrideLog({
      multisigOverrideLogId: `MOLOG-${request.overrideRequestId}-EXPIRED`,
      overrideRequestId: request.overrideRequestId,
      projectId: request.projectId,
      operator: expiredByCommissionerId,
      operatorRole: '',
      action: 'OVERRIDE_EXPIRED',
      resolution: 'EXPIRED',
      reason: 'Commissioner set changed',
      txHash: null,
      blockNumber: null,
      eventTimestamp: request.expiredAt ?? new Date(),
      metadata: {},
    });
    logger.info('Đã ghi multisig_override_log EXPIRED', {
      overrideRequestId: request.overrideRequestId,
      projectId: request.projectId,
      operator: expiredByCommissionerId,
    });
  } catch (error) {
    logger.error('Lỗi khi ghi multisig_override_log cho override EXPIRED', {
      error: error instanceof Error ? error.message : String(error),
      overrideRequestId: request.overrideRequestId,
    });
  }
}
