import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  countImpactSbtByProjectId,
  findImpactSbtMetadataByProjectId
} from '../../models/impactSbtMetadataModel';

let mongoServer: MongoMemoryServer;

/** Tạo fixture SBT tối thiểu với trạng thái on-chain cần kiểm tra trong gallery. */
function buildRecord(index: number, onChainTokenStatus: string | null): Record<string, unknown> {
  return {
    sbtId: `SBT-${index}`,
    mintRequestId: `MINT-${index}`,
    verificationId: `VER-${index}`,
    projectId: 'project-gallery',
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
      buildRecord(4, 'REVOKED')
    ]);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  it('excludes revoked records consistently from find and count while allowing admin opt-in', async () => {
    const visibleRecords = await findImpactSbtMetadataByProjectId('project-gallery');
    const visibleTotal = await countImpactSbtByProjectId('project-gallery');

    expect(visibleRecords).toHaveLength(3);
    expect(visibleRecords.map(record => record.onChainTokenStatus)).toEqual([
      'FROZEN',
      'ACTIVE',
      null
    ]);
    expect(visibleTotal).toBe(3);

    const allRecords = await findImpactSbtMetadataByProjectId(
      'project-gallery',
      20,
      0,
      { includeHidden: true }
    );
    const allTotal = await countImpactSbtByProjectId('project-gallery', { includeHidden: true });
    expect(allRecords).toHaveLength(4);
    expect(allTotal).toBe(4);
  });
});
