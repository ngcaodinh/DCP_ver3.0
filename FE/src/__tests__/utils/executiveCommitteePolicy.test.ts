import { describe, expect, it } from 'vitest';
import { EXECUTIVE_COMMITTEE_POLICY, requiresRiskAcknowledgement, type ExecutiveDeviationLevel } from '@/app/utils/executiveCommitteePolicy';

describe('executive committee policy helpers', () => {
  it('requires GPS acknowledgement only for deviated or critical evidence', () => {
    const expectations: Array<[ExecutiveDeviationLevel, boolean]> = [
      ['INSIDE', false],
      ['WITHIN_ACCURACY', false],
      ['DEVIATED', true],
      ['CRITICAL', true],
      ['NO_GEOFENCE', false]
    ];

    for (const [deviationLevel, expected] of expectations) {
      expect(requiresRiskAcknowledgement(deviationLevel)).toBe(expected);
    }
  });

  it('keeps the quorum policy explicit for the UI', () => {
    expect(EXECUTIVE_COMMITTEE_POLICY).toEqual({
      requiredChairVotes: 1,
      requiredMemberVotes: 2,
      expectedMemberSeats: 4
    });
  });
});
