import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockAddAuditLog,
  mockFindLatestIntent,
  mockFindUserByWallet,
  mockInvalidateSessions,
  mockUpdateIntent,
  mockUpdateUser
} = vi.hoisted(() => ({
  mockAddAuditLog: vi.fn(),
  mockFindLatestIntent: vi.fn(),
  mockFindUserByWallet: vi.fn(),
  mockInvalidateSessions: vi.fn(),
  mockUpdateIntent: vi.fn(),
  mockUpdateUser: vi.fn()
}));

vi.mock('../../models/authModel', () => ({
  addAuditLog: mockAddAuditLog,
  findUserById: vi.fn(),
  findUserByWalletAddress: mockFindUserByWallet,
  updateUser: mockUpdateUser
}));
vi.mock('../../models/auditorStakeIntentModel', () => ({
  findLatestAuditorStakeIntentByUserId: mockFindLatestIntent,
  updateAuditorStakeIntent: mockUpdateIntent
}));
vi.mock('../../config/auditorStakingContract', () => ({
  getReadOnlyAuditorStakingContract: () => ({
    stakedBalance: vi.fn().mockResolvedValue(3_000_000n),
    minimumStakeThreshold: vi.fn().mockResolvedValue(3_000_000n)
  })
}));
vi.mock('../../services/authAdminService', () => ({
  invalidateAuthSessionsForUser: mockInvalidateSessions,
  revokeUserAccess: vi.fn()
}));

import { reconcileAuditorStakeForWallet } from '../../services/auditorRoleActivationService';

/** Tạo Auditor bị suspend với tối thiểu dữ liệu cần cho nhánh kích hoạt lại. */
function suspendedAuditor(reason: 'CHALLENGE_REJECTED' | 'PENALTY_LIMIT_EXCEEDED') {
  return {
    id: 'auditor-1',
    email: 'auditor@example.com',
    role: 'auditor',
    accountStatus: 'SUSPENDED',
    suspendedReasonCode: reason,
    authVersion: 3
  };
}

describe('auditor role activation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInvalidateSessions.mockResolvedValue(4);
    mockFindLatestIntent.mockResolvedValue({ id: 'intent-1', status: 'VERIFYING' });
    mockUpdateUser.mockImplementation(async (user: unknown) => user);
  });

  it('reactivates CHALLENGE_REJECTED after stake reaches the threshold again', async () => {
    mockFindUserByWallet.mockResolvedValue(suspendedAuditor('CHALLENGE_REJECTED'));

    await reconcileAuditorStakeForWallet('0x0000000000000000000000000000000000000001');

    expect(mockUpdateUser).toHaveBeenCalledWith(expect.objectContaining({
      role: 'auditor', accountStatus: 'ACTIVE', suspendedReasonCode: null, authVersion: 4
    }));
    expect(mockUpdateIntent).toHaveBeenCalledWith(expect.objectContaining({ status: 'ACTIVATED' }));
  });

  it('never reactivates PENALTY_LIMIT_EXCEEDED automatically', async () => {
    mockFindUserByWallet.mockResolvedValue(suspendedAuditor('PENALTY_LIMIT_EXCEEDED'));

    await reconcileAuditorStakeForWallet('0x0000000000000000000000000000000000000001');

    expect(mockUpdateUser).not.toHaveBeenCalled();
    expect(mockUpdateIntent).not.toHaveBeenCalled();
  });
});
