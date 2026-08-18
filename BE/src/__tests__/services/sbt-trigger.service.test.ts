import { createHmac } from 'crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findVerificationById: vi.fn(),
  markVerificationSbtMintEnqueued: vi.fn(),
  consumeOracleTriggerNonce: vi.fn(),
  findDisbursementByRequestId: vi.fn(),
  findDisbursementsByProjectId: vi.fn(),
  findUserWalletAddressById: vi.fn(),
  findDonationsByProjectId: vi.fn(),
  countBeneficiariesByProjectId: vi.fn(),
  countConfirmedImpactSbtByProjectId: vi.fn(),
  createSbtMintRequest: vi.fn()
}));

vi.mock('../../config/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}));
vi.mock('../../models/oracleVerificationResultModel', () => ({
  findVerificationById: mocks.findVerificationById,
  markVerificationSbtMintEnqueued: mocks.markVerificationSbtMintEnqueued
}));
vi.mock('../../models/oracleTriggerNonceModel', () => ({
  consumeOracleTriggerNonce: mocks.consumeOracleTriggerNonce
}));
vi.mock('../../models/disbursementModel', () => ({
  findDisbursementByRequestId: mocks.findDisbursementByRequestId,
  findDisbursementsByProjectId: mocks.findDisbursementsByProjectId
}));
vi.mock('../../models/authModel', () => ({ findUserWalletAddressById: mocks.findUserWalletAddressById }));
vi.mock('../../models/donationModel', () => ({ findDonationsByProjectId: mocks.findDonationsByProjectId }));
vi.mock('../../models/beneficiaryFeedbackModel', () => ({ countBeneficiariesByProjectId: mocks.countBeneficiariesByProjectId }));
vi.mock('../../models/impactSbtMetadataModel', () => ({ countConfirmedImpactSbtByProjectId: mocks.countConfirmedImpactSbtByProjectId }));
vi.mock('../../services/sbtMintService', () => ({ createSbtMintRequest: mocks.createSbtMintRequest }));

import {
  isTransactionStuck,
  resolveSbtMintInputFromVerification,
  triggerSbtMintFromOracle,
  verifyOracleTriggerRequest
} from '../../services/sbt-trigger.service';

const beneficiaryAddress = '0x1234567890123456789012345678901234567890';
const validVerification = {
  verificationId: 'ver-1',
  projectId: 'project-1',
  organizationId: 'org-1',
  evidenceCid: 'QmEvidence',
  status: 'VALID',
  gpsFromImage: { lat: 10.1, lng: 106.2 },
  gpsFromProject: { lat: 10.1, lng: 106.2 },
  distanceMeters: 2,
  radiusMeters: 50,
  geofenceSnapshot: null,
  overrideRequestId: null,
  disbursementRequestId: 'disbursement-1',
  sbtMintDispatchStatus: 'PENDING',
  processedAt: new Date('2026-08-17T00:00:00Z'),
  createdAt: new Date('2026-08-17T00:00:00Z'),
  updatedAt: new Date('2026-08-17T00:00:00Z')
} as const;

function buildSignature(timestamp: number, nonce: string, verificationId: string): string {
  return createHmac('sha256', 'test-secret')
    .update(`${timestamp}.${nonce}.${verificationId}`)
    .digest('hex');
}

describe('sbt-trigger.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ORACLE_TRIGGER_SHARED_SECRET = 'test-secret';
    mocks.findDisbursementByRequestId.mockResolvedValue({
      requestId: 'disbursement-1',
      projectId: 'project-1',
      organizationId: 'org-1',
      beneficiaryWalletAddress: beneficiaryAddress
    });
    mocks.findDisbursementsByProjectId.mockResolvedValue([]);
    mocks.findDonationsByProjectId.mockResolvedValue([]);
    mocks.findUserWalletAddressById.mockResolvedValue(null);
    mocks.countBeneficiariesByProjectId.mockResolvedValue(2);
    mocks.countConfirmedImpactSbtByProjectId.mockResolvedValue(3);
    mocks.consumeOracleTriggerNonce.mockResolvedValue(true);
  });

  it('chỉ resolve mint input từ verification và nguồn authoritative', async () => {
    const input = await resolveSbtMintInputFromVerification(validVerification);

    expect(input).toEqual(expect.objectContaining({
      verificationId: 'ver-1',
      projectId: 'project-1',
      organizationId: 'org-1',
      beneficiaryAddress,
      milestone: 4,
      beneficiaryCount: 2,
      gpsCoordinates: '10.1,106.2',
      tokenUri: 'ipfs://QmEvidence'
    }));
  });

  it('reject verification không VALID hoặc thiếu GPS', async () => {
    await expect(resolveSbtMintInputFromVerification({ ...validVerification, status: 'INVALID' }))
      .rejects.toMatchObject({ errorCode: 'VERIFICATION_NOT_VALID' });
    await expect(resolveSbtMintInputFromVerification({ ...validVerification, gpsFromImage: null }))
      .rejects.toMatchObject({ errorCode: 'VERIFICATION_DATA_INCOMPLETE' });
  });

  it('xác thực HMAC, timestamp và chống replay nonce', async () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = 'nonce-1234567890';
    const signature = buildSignature(timestamp, nonce, 'ver-1');

    await verifyOracleTriggerRequest('ver-1', { signature, timestamp: String(timestamp), nonce });
    expect(mocks.consumeOracleTriggerNonce).toHaveBeenCalledOnce();

    mocks.consumeOracleTriggerNonce.mockResolvedValueOnce(false);
    await expect(verifyOracleTriggerRequest('ver-1', { signature, timestamp: String(timestamp), nonce }))
      .rejects.toMatchObject({ errorCode: 'ORACLE_SIGNATURE_REPLAY' });
  });

  it('không chấp nhận signature sai', async () => {
    const timestamp = Math.floor(Date.now() / 1000);
    await expect(verifyOracleTriggerRequest('ver-1', {
      signature: 'a'.repeat(64),
      timestamp: String(timestamp),
      nonce: 'nonce-1234567890'
    })).rejects.toMatchObject({ errorCode: 'ORACLE_SIGNATURE_INVALID' });
  });

  it('trigger lookup verification trước khi tạo request và idempotently đánh dấu dispatch', async () => {
    mocks.findVerificationById.mockResolvedValue(validVerification);
    mocks.createSbtMintRequest.mockResolvedValue({
      record: { sbtId: 'sbt-1', mintRequestId: 'mint-1', status: 'PENDING' },
      jobId: 'mint-1-attempt1',
      enqueued: true,
      duplicate: false
    });

    const result = await triggerSbtMintFromOracle({ verificationId: 'ver-1' });

    expect(mocks.createSbtMintRequest).toHaveBeenCalledWith(expect.objectContaining({
      beneficiaryAddress,
      milestone: 4,
      projectId: 'project-1'
    }));
    expect(mocks.markVerificationSbtMintEnqueued).toHaveBeenCalledWith('ver-1');
    expect(result.duplicate).toBe(false);
  });

  it('isTransactionStuck chỉ cảnh báo SUBMITTED quá 5 phút', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-17T12:00:00Z'));
    expect(isTransactionStuck({ status: 'SUBMITTED', submittedAt: new Date('2026-08-17T11:54:00Z') } as never)).toBe(true);
    expect(isTransactionStuck({ status: 'PENDING', submittedAt: null } as never)).toBe(false);
    vi.useRealTimers();
  });
});
