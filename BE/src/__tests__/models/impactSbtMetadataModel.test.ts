import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  countImpactSbtGallery,
  claimImpactSbtForSubmission,
  findEarliestConfirmedImpactSbtBackfillAnchor,
  findEarliestConfirmedImpactSbtBlock,
  findImpactSbtGallery,
  updateImpactSbtOnChainStatus,
  markImpactSbtAsFailed,
  releaseExpiredSbtSubmissionWithoutNonce,
  markImpactSbtAsDlq
} from '../../models/impactSbtMetadataModel';

let mongoServer: MongoMemoryServer;

/** Tạo fixture SBT tối thiểu với trạng thái on-chain cần kiểm tra trong gallery. */
function buildRecord(
  index: number,
  onChainTokenStatus: string | null,
  projectId = 'project-gallery'
): Record<string, unknown> {
  return {
    sbtId: `SBT-${index}`,
    mintRequestId: `MINT-${index}`,
    verificationId: `VER-${index}`,
    projectId,
    organizationId: 'org-1',
    beneficiaryAddress: `0x${String(index).padStart(40, '0')}`,
    projectIdNumeric: 5,
    milestone: index,
    beneficiaryCount: 10,
    gpsCoordinates: '10.8,106.6',
    imageCid: `QmImage${index}`,
    tokenUri: `ipfs://QmMetadata${index}`,
    status: 'CONFIRMED',
    attemptNumber: 1,
    lastErrorMessage: null,
    onChainTokenId: index,
    transactionHash: `0xtx${index}`,
    blockNumber: 100 + index,
    confirmedAt: new Date(`2026-08-0${index + 1}T10:00:00.000Z`),
    onChainTokenStatus,
    tokenStatusReason: null,
    tokenStatusUpdatedAt: null,
    tokenStatusUpdatedBy: null,
    submittedAt: null,
    dlqAt: null,
    reRunCount: 0,
    lastReRunBy: null,
    lastReRunAt: null,
    createdAt: new Date('2026-08-01T09:00:00.000Z'),
    updatedAt: new Date('2026-08-01T10:00:00.000Z')
  };
}

describe('impactSbtMetadataModel gallery visibility', () => {
  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
  });

  beforeEach(async () => {
    await mongoose.connection.collection('impact_sbt_metadata').deleteMany({});
    await mongoose.connection.collection('impact_sbt_metadata').insertMany([
      buildRecord(1, null),
      buildRecord(2, 'ACTIVE'),
      buildRecord(3, 'FROZEN'),
      buildRecord(4, 'REVOKED'),
      buildRecord(5, null, 'project-second'),
      buildRecord(6, 'BURNED')
    ]);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  it('excludes revoked records consistently from find and count while allowing admin opt-in', async () => {
    const visibleRecords = await findImpactSbtGallery(20, 0, 'project-gallery');
    const visibleTotal = await countImpactSbtGallery('project-gallery');

    expect(visibleRecords).toHaveLength(3);
    expect(visibleRecords.map(record => record.onChainTokenStatus)).toEqual([
      'FROZEN',
      'ACTIVE',
      null
    ]);
    expect(visibleTotal).toBe(3);

    const allRecords = await findImpactSbtGallery(20, 0, 'project-gallery', { includeHidden: true });
    const allTotal = await countImpactSbtGallery('project-gallery', { includeHidden: true });
    expect(allRecords).toHaveLength(5);
    expect(allTotal).toBe(5);
  });

  it('applies the same hidden-status filter to global gallery find and count', async () => {
    const visibleRecords = await findImpactSbtGallery();
    const visibleTotal = await countImpactSbtGallery();

    expect(visibleRecords).toHaveLength(4);
    expect(visibleRecords[0].projectId).toBe('project-second');
    expect(visibleRecords.map(record => record.onChainTokenStatus)).not.toContain('REVOKED');
    expect(visibleRecords.map(record => record.onChainTokenStatus)).not.toContain('BURNED');
    expect(visibleTotal).toBe(4);
  });

  it('filters global gallery by projectId without returning another project', async () => {
    const records = await findImpactSbtGallery(20, 0, 'project-second');
    const total = await countImpactSbtGallery('project-second');

    expect(records).toHaveLength(1);
    expect(records[0].projectId).toBe('project-second');
    expect(total).toBe(1);
  });

  it('does not broaden an explicitly empty project filter into the global gallery', async () => {
    const records = await findImpactSbtGallery(20, 0, '');
    const total = await countImpactSbtGallery('');

    expect(records).toHaveLength(0);
    expect(total).toBe(0);
  });

  it('removes a revoked token from both gallery find and count after a durable event projection', async () => {
    const projectedRecord = await updateImpactSbtOnChainStatus(1, {
      onChainTokenStatus: 'REVOKED',
      reason: 'Evidence invalidated.',
      updatedBy: 'ON_CHAIN_STATUS_PROJECTOR',
      updatedAt: new Date('2026-08-10T10:00:00.000Z'),
      eventLocation: {
        blockNumber: 999,
        logIndex: 2,
        transactionHash: '0xstatus-event'
      }
    });

    const visibleRecords = await findImpactSbtGallery(20, 0, 'project-gallery');
    const visibleTotal = await countImpactSbtGallery('project-gallery');

    expect(projectedRecord).toMatchObject({
      onChainTokenStatus: 'REVOKED',
      tokenStatusBlockNumber: 999,
      tokenStatusLogIndex: 2
    });
    expect(visibleRecords.map(record => record.onChainTokenId)).not.toContain(1);
    expect(visibleTotal).toBe(2);
  });

  it('finds the earliest confirmed block and ignores confirmed records without a block', async () => {
    await mongoose.connection.collection('impact_sbt_metadata').insertOne({
      ...buildRecord(7, null),
      status: 'CONFIRMED',
      blockNumber: null,
      onChainTokenId: 7,
      sbtId: 'SBT-null-block',
      mintRequestId: 'MINT-null-block',
      verificationId: 'VER-null-block'
    });

    await expect(findEarliestConfirmedImpactSbtBlock()).resolves.toBe(101);
  });

  it('returns the earliest confirmed block and timestamp for legacy checkpoint detection', async () => {
    await expect(findEarliestConfirmedImpactSbtBackfillAnchor()).resolves.toMatchObject({
      blockNumber: 101,
      confirmedAt: new Date('2026-08-02T10:00:00.000Z')
    });
  });

  it('atomic submission claim chỉ cho một worker giữ lease trong race thật với Mongo', async () => {
    await mongoose.connection.collection('impact_sbt_metadata').updateOne(
      { mintRequestId: 'MINT-1' },
      { $set: { status: 'PENDING' } }
    );
    const leaseExpiry = new Date('2030-08-17T12:02:00.000Z');
    const claimResults = await Promise.all([
      claimImpactSbtForSubmission('MINT-1', {
        attemptNumber: 1,
        leaseOwner: 'worker-a',
        leaseExpiresAt: leaseExpiry
      }),
      claimImpactSbtForSubmission('MINT-1', {
        attemptNumber: 1,
        leaseOwner: 'worker-b',
        leaseExpiresAt: leaseExpiry
      })
    ]);

    expect(claimResults.filter(Boolean)).toHaveLength(1);
    const claimedRecord = await mongoose.connection.collection('impact_sbt_metadata').findOne({ mintRequestId: 'MINT-1' });
    expect(claimedRecord?.status).toBe('SUBMITTING');
    expect(['worker-a', 'worker-b']).toContain(claimedRecord?.submissionLeaseOwner);
  });

  it('chỉ một worker được release lease SUBMITTING hết hạn trước nonce', async () => {
    await mongoose.connection.collection('impact_sbt_metadata').updateOne(
      { mintRequestId: 'MINT-1' },
      {
        $set: {
          status: 'SUBMITTING',
          transactionHash: null,
          transactionNonce: null,
          submissionLeaseOwner: 'worker-a',
          submissionLeaseExpiresAt: new Date('2020-08-17T12:02:00.000Z')
        }
      }
    );

    const releaseResults = await Promise.all([
      releaseExpiredSbtSubmissionWithoutNonce('MINT-1', 'expired-a'),
      releaseExpiredSbtSubmissionWithoutNonce('MINT-1', 'expired-b')
    ]);

    expect(releaseResults.filter(Boolean)).toHaveLength(1);
    const releasedRecord = await mongoose.connection.collection('impact_sbt_metadata').findOne({ mintRequestId: 'MINT-1' });
    expect(releasedRecord).toMatchObject({ status: 'PENDING', lastErrorMessage: expect.stringMatching(/^expired-/) });
  });

  it('chặn duplicate failure và DLQ transition trong race thật với Mongo', async () => {
    await mongoose.connection.collection('impact_sbt_metadata').updateOne(
      { mintRequestId: 'MINT-1' },
      { $set: { status: 'SUBMITTED', transactionHash: '0xsubmitted', attemptNumber: 7 } }
    );

    const failureResults = await Promise.all([
      markImpactSbtAsFailed('MINT-1', { attemptNumber: 7, errorMessage: 'reverted-a' }),
      markImpactSbtAsFailed('MINT-1', { attemptNumber: 7, errorMessage: 'reverted-b' })
    ]);
    expect(failureResults.filter(Boolean)).toHaveLength(1);

    const dlqResults = await Promise.all([
      markImpactSbtAsDlq('MINT-1', { attemptNumber: 7, errorMessage: 'reverted', dlqAt: new Date() }),
      markImpactSbtAsDlq('MINT-1', { attemptNumber: 7, errorMessage: 'reverted', dlqAt: new Date() })
    ]);
    expect(dlqResults.filter(Boolean)).toHaveLength(1);
    await expect(mongoose.connection.collection('impact_sbt_metadata').findOne({ mintRequestId: 'MINT-1' }))
      .resolves.toMatchObject({ status: 'DLQ' });
  });
});
