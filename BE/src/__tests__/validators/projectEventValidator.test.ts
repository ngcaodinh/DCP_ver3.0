import { describe, expect, it } from 'vitest';
import { projectEventLogInputSchema } from '../../validators/projectEventValidator';

const timestamp = new Date('2026-08-16T00:00:00.000Z');

describe('projectEventValidator', () => {
  it('yêu cầu đủ top-level fields và payload của DONATION_CONFIRMED', () => {
    expect(projectEventLogInputSchema.safeParse({
      eventType: 'DONATION_CONFIRMED',
      projectId: 'project-1',
      walletAddress: '0x1234567890123456789012345678901234567890',
      amount: 100,
      correlationId: 'donation:0xtx',
      timestamp,
      payload: { transactionHash: '0xtx', blockNumber: 10, isAnonymous: false }
    }).success).toBe(true);

    expect(projectEventLogInputSchema.safeParse({
      eventType: 'DONATION_CONFIRMED',
      projectId: 'project-1',
      timestamp,
      payload: {}
    }).success).toBe(false);
  });

  it('yêu cầu milestone và beneficiaryCount cho SBT_MINTED', () => {
    const result = projectEventLogInputSchema.safeParse({
      eventType: 'SBT_MINTED',
      projectId: 'project-1',
      walletAddress: '0x1234567890123456789012345678901234567890',
      timestamp,
      payload: {
        tokenId: 42,
        milestone: 1,
        beneficiaryCount: 3,
        sbtId: 'sbt-1',
        transactionHash: '0xtx'
      }
    });
    expect(result.success).toBe(true);
    expect(projectEventLogInputSchema.safeParse({
      eventType: 'SBT_MINTED',
      projectId: 'project-1',
      walletAddress: '0x1234567890123456789012345678901234567890',
      timestamp,
      payload: { tokenId: 42, sbtId: 'sbt-1', transactionHash: '0xtx' }
    }).success).toBe(false);
  });

  it('chấp nhận riskScore Sybil theo thang 0-100 và vẫn giữ null hợp lệ', () => {
    expect(projectEventLogInputSchema.safeParse({
      eventType: 'SYBIL_FLAGGED',
      projectId: null,
      walletAddress: '0x1234567890123456789012345678901234567890',
      timestamp,
      payload: { riskScore: 47, flagReason: 'manual review' }
    }).success).toBe(true);

    expect(projectEventLogInputSchema.safeParse({
      eventType: 'SYBIL_FLAGGED',
      projectId: null,
      walletAddress: '0x1234567890123456789012345678901234567890',
      timestamp,
      payload: { riskScore: null, flagReason: 'manual review' }
    }).success).toBe(true);

    expect(projectEventLogInputSchema.safeParse({
      eventType: 'SYBIL_FLAGGED',
      projectId: null,
      walletAddress: '0x1234567890123456789012345678901234567890',
      timestamp,
      payload: { riskScore: 100.01, flagReason: 'manual review' }
    }).success).toBe(false);
  });
});
