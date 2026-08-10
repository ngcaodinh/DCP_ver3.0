import { describe, expect, it } from 'vitest';
import { isDlqEntryEscalated } from '@/app/constants/sbtDlq';
import type { SbtMintDlqEntry } from '@/app/types/sbtRetry';

/** Tạo entry tối thiểu cho kiểm thử helper escalation thuần. */
function createEntry(overrides: Partial<SbtMintDlqEntry> = {}): SbtMintDlqEntry {
  return {
    dlqId: 'DLQ-1',
    mintRequestId: 'MINT-1',
    sbtId: 'SBT-1',
    projectId: 'PROJECT-1',
    projectName: null,
    organizationId: 'ORG-1',
    beneficiaryAddress: '0x1',
    attemptNumber: 6,
    lastErrorMessage: 'error',
    firstAttemptedAt: '2026-08-09T00:00:00.000Z',
    dlqAt: '2026-08-09T00:00:00.000Z',
    recoveredAt: null,
    recoveredBy: null,
    recoveryAttemptNumber: 0,
    status: 'OPEN',
    createdAt: '2026-08-09T00:00:00.000Z',
    updatedAt: '2026-08-09T00:00:00.000Z',
    ...overrides
  };
}

describe('isDlqEntryEscalated', () => {
  const now = new Date('2026-08-10T00:00:00.000Z');

  it('entry mới và ít lần retry không escalated', () => {
    expect(isDlqEntryEscalated(createEntry(), now)).toBe(false);
  });

  it('entry mới nhưng nhiều lần retry escalated', () => {
    expect(isDlqEntryEscalated(createEntry({ recoveryAttemptNumber: 3 }), now)).toBe(true);
  });

  it('entry cũ nhưng ít lần retry escalated theo tuổi DLQ', () => {
    expect(isDlqEntryEscalated(createEntry({ dlqAt: '2026-08-06T00:00:00.000Z' }), now)).toBe(true);
  });

  it('entry cũ và nhiều lần retry vẫn escalated', () => {
    expect(isDlqEntryEscalated(createEntry({ dlqAt: '2026-08-06T00:00:00.000Z', recoveryAttemptNumber: 3 }), now)).toBe(true);
  });
});
