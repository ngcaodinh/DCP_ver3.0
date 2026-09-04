import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getDonationRequestRateLimit,
  isSyntheticDonationExecutionEnabled,
  isSyntheticDonationExecutionMisconfigured,
  SYNTHETIC_DONATION_ACK
} from '../../config/donationPerformance';

const originalEnvironment = process.env.NODE_ENV;
const originalExecution = process.env.SYNTHETIC_DONATION_EXECUTION;
const originalAcknowledgement = process.env.SYNTHETIC_DONATION_ACK;

describe('donationPerformance config', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    delete process.env.SYNTHETIC_DONATION_EXECUTION;
    delete process.env.SYNTHETIC_DONATION_ACK;
  });

  afterEach(() => {
    if (originalEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalEnvironment;
    if (originalExecution === undefined) delete process.env.SYNTHETIC_DONATION_EXECUTION;
    else process.env.SYNTHETIC_DONATION_EXECUTION = originalExecution;
    if (originalAcknowledgement === undefined) delete process.env.SYNTHETIC_DONATION_ACK;
    else process.env.SYNTHETIC_DONATION_ACK = originalAcknowledgement;
  });

  it('keeps the normal rate limit by default', () => {
    expect(isSyntheticDonationExecutionEnabled()).toBe(false);
    expect(getDonationRequestRateLimit()).toBe(100);
  });

  it('enables synthetic mode only with the performance environment and acknowledgement', () => {
    process.env.NODE_ENV = 'performance';
    process.env.SYNTHETIC_DONATION_EXECUTION = 'true';
    process.env.SYNTHETIC_DONATION_ACK = SYNTHETIC_DONATION_ACK;

    expect(isSyntheticDonationExecutionEnabled()).toBe(true);
    expect(isSyntheticDonationExecutionMisconfigured()).toBe(false);
    expect(getDonationRequestRateLimit()).toBe(25_000);
  });

  it('does not enable synthetic mode from a normal staging/production environment', () => {
    process.env.NODE_ENV = 'staging';
    process.env.SYNTHETIC_DONATION_EXECUTION = 'true';
    process.env.SYNTHETIC_DONATION_ACK = SYNTHETIC_DONATION_ACK;

    expect(isSyntheticDonationExecutionEnabled()).toBe(false);
    expect(isSyntheticDonationExecutionMisconfigured()).toBe(true);
    expect(getDonationRequestRateLimit()).toBe(100);
  });
});
