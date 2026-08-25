import { addAuditLog, findUserById, findUserByWalletAddress, updateUser, type AuthUser } from '../models/authModel';
import {
  findLatestAuditorStakeIntentByUserId,
  updateAuditorStakeIntent
} from '../models/auditorStakeIntentModel';
import { getReadOnlyAuditorStakingContract } from '../config/auditorStakingContract';
import { invalidateAuthSessionsForUser, revokeUserAccess } from './authAdminService';

export type AuditorSuspendedReasonCode =
  | 'STAKE_BELOW_THRESHOLD'
  | 'SLASHED'
  | 'SYBIL_DETECTED'
  | 'WALLET_CHANGED'
  | 'CHALLENGE_REJECTED'
  | 'PENALTY_LIMIT_EXCEEDED';

/** Kích hoạt vai trò auditor chỉ sau khi reconcile đã xác nhận cọc đủ ngưỡng on-chain. */
async function activateAuditorRole(user: AuthUser): Promise<void> {
  const isEligibleForActivation = user.accountStatus === 'PENDING_STAKE_VERIFICATION'
    || (user.accountStatus === 'SUSPENDED' && (
      user.suspendedReasonCode === 'STAKE_BELOW_THRESHOLD'
      || user.suspendedReasonCode === 'CHALLENGE_REJECTED'
    ));
  if (!isEligibleForActivation) return;

  const authVersion = await invalidateAuthSessionsForUser(user.id);
  const activatedUser: AuthUser = {
    ...user,
    role: 'auditor',
    accountStatus: 'ACTIVE',
    suspendedReasonCode: null,
    authVersion
  };
  await updateUser(activatedUser);

  const latestIntent = await findLatestAuditorStakeIntentByUserId(user.id);
  if (latestIntent && latestIntent.status !== 'ACTIVATED') {
    await updateAuditorStakeIntent({
      ...latestIntent,
      status: 'ACTIVATED',
      failureReason: null,
      updatedAt: new Date()
    });
  }

  await addAuditLog({
    id: crypto.randomUUID(),
    userId: user.id,
    email: user.email,
    eventType: 'AUDITOR_ROLE_ACTIVATED',
    ipAddress: 'SYSTEM',
    userAgent: 'SYSTEM:auditor-stake-reconcile',
    detail: 'Đã kích hoạt quyền Kiểm toán viên sau khi cọc đạt ngưỡng on-chain.',
    createdAt: new Date()
  });
}

/** Thu quyền Kiểm toán viên idempotent nhưng vẫn giữ role để audit trail không mất lịch sử. */
export async function suspendAuditorRole(
  userId: string,
  reasonCode: AuditorSuspendedReasonCode
): Promise<void> {
  const user = await findUserById(userId);
  if (!user || (user.accountStatus === 'SUSPENDED' && user.suspendedReasonCode === reasonCode)) return;

  await updateUser({
    ...user,
    accountStatus: 'SUSPENDED',
    suspendedReasonCode: reasonCode
  });
  await revokeUserAccess(userId, reasonCode, 'SYSTEM:auditor-stake-worker');
  await addAuditLog({
    id: crypto.randomUUID(),
    userId: user.id,
    email: user.email,
    eventType: 'AUDITOR_ROLE_SUSPENDED',
    ipAddress: 'SYSTEM',
    userAgent: 'SYSTEM:auditor-stake-worker',
    detail: `Đã thu quyền Kiểm toán viên: ${reasonCode}.`,
    createdAt: new Date()
  });
}

/**
 * Reconcile quyền auditor từ số cọc thực tế on-chain; đây là đường duy nhất tự kích hoạt quyền.
 * WALLET_CHANGED là mã dự phòng cho tương lai vì hiện chưa có luồng đổi ví trong repository.
 */
export async function reconcileAuditorStakeForWallet(walletAddress: string): Promise<void> {
  const user = await findUserByWalletAddress(walletAddress);
  if (!user) return;

  const contract = getReadOnlyAuditorStakingContract();
  const [stakedBalance, minimumStakeThreshold] = await Promise.all([
    contract.stakedBalance(walletAddress) as Promise<bigint>,
    contract.minimumStakeThreshold() as Promise<bigint>
  ]);

  if (stakedBalance >= minimumStakeThreshold) {
    await activateAuditorRole(user);
    return;
  }

  if (user.role === 'auditor' && user.accountStatus !== 'SUSPENDED') {
    await suspendAuditorRole(user.id, 'STAKE_BELOW_THRESHOLD');
  }
}
