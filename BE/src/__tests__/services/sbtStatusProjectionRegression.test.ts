import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

const mocks = vi.hoisted(() => ({
  invalidateGalleryTotal: vi.fn(),
  invalidateToken: vi.fn()
}));

vi.mock('../../services/sbtMetadataCacheService', () => ({
  invalidateSbtGalleryTotalCache: mocks.invalidateGalleryTotal,
  invalidateSbtTokenCache: mocks.invalidateToken
}));

vi.mock('../../config/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}));

import {
  countImpactSbtGallery,
  findImpactSbtGallery,
  markImpactSbtAsConfirmed
} from '../../models/impactSbtMetadataModel';
import { projectSbtTokenStatusUpdate } from '../../services/sbtStatusProjectionService';

let mongoServer: MongoMemoryServer;

/** Tạo metadata vẫn ACTIVE trong Mongo để mô phỏng write API đã xác nhận receipt nhưng sync bị lỗi. */
function buildUnsyncedRecord(): Record<string, unknown> {
  return {
    sbtId: 'SBT-12',
    mintRequestId: 'MINT-12',
    verificationId: 'VER-12',
    projectId: 'project-1',
    organizationId: 'org-1',
    beneficiaryAddress: '0x0000000000000000000000000000000000000012',
    projectIdNumeric: 1,
    milestone: 2,
    beneficiaryCount: 10,
    gpsCoordinates: '',
    imageCid: 'QmImage',
    tokenUri: 'ipfs://QmMetadata',
    status: 'CONFIRMED',
    attemptNumber: 1,
    lastErrorMessage: null,
    onChainTokenId: 12,
    transactionHash: '0xmint',
    blockNumber: 100,
    confirmedAt: new Date('2026-08-01T10:00:00.000Z'),
    onChainTokenStatus: 'ACTIVE',
    submittedAt: null,
    dlqAt: null,
    reRunCount: 0,
    lastReRunBy: null,
    lastReRunAt: null,
    createdAt: new Date('2026-08-01T09:00:00.000Z'),
    updatedAt: new Date('2026-08-01T10:00:00.000Z')
  };
}

describe('SBT status projection regression', () => {
  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.invalidateGalleryTotal.mockResolvedValue(undefined);
    mocks.invalidateToken.mockResolvedValue(undefined);
    await Promise.all([
      mongoose.connection.collection('impact_sbt_metadata').deleteMany({}),
      mongoose.connection.collection('sbt_status_projection_events').deleteMany({})
    ]);
    await mongoose.connection.collection('impact_sbt_metadata').insertOne(buildUnsyncedRecord());
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  it('repairs a failed Mongo sync from a direct canonical revoke and excludes it from both gallery queries', async () => {
    await expect(projectSbtTokenStatusUpdate({
      chainId: '490000',
      contractAddress: '0x0000000000000000000000000000000000000001',
      transactionHash: '0xdirect-revoke',
      logIndex: 0,
      blockNumber: 200,
      blockHash: '0xblock',
      tokenId: 12,
      newStatus: 'REVOKED',
      reason: 'Evidence invalidated.'
    })).resolves.toBe(true);

    await expect(findImpactSbtGallery()).resolves.toEqual([]);
    await expect(countImpactSbtGallery()).resolves.toBe(0);
    expect(mocks.invalidateGalleryTotal).toHaveBeenCalledWith('project-1');
  });

  it('replays a pending revoke after the mint record becomes confirmed instead of losing the canonical event', async () => {
    const submittedRecord = buildUnsyncedRecord();
    submittedRecord.status = 'SUBMITTED';
    submittedRecord.onChainTokenId = null;
    submittedRecord.blockNumber = null;
    submittedRecord.confirmedAt = null;
    await mongoose.connection.collection('impact_sbt_metadata').deleteMany({});
    await mongoose.connection.collection('impact_sbt_metadata').insertOne(submittedRecord);

    const revokeEvent = {
      chainId: '490000',
      contractAddress: '0x0000000000000000000000000000000000000001',
      transactionHash: '0xrevoke-before-mongo-confirm',
      logIndex: 0,
      blockNumber: 200,
      blockHash: '0xblock',
      tokenId: 12,
      newStatus: 'REVOKED' as const,
      reason: 'Evidence invalidated.'
    };

    await expect(projectSbtTokenStatusUpdate(revokeEvent)).resolves.toBe(false);
    await expect(mongoose.connection.collection('sbt_status_projection_events').findOne({
      transactionHash: revokeEvent.transactionHash,
      logIndex: revokeEvent.logIndex
    })).resolves.toMatchObject({ projectionStatus: 'PENDING' });

    await markImpactSbtAsConfirmed('MINT-12', {
      onChainTokenId: 12,
      blockNumber: 100,
      confirmedAt: new Date('2026-08-01T10:00:00.000Z')
    });

    await expect(projectSbtTokenStatusUpdate(revokeEvent)).resolves.toBe(true);
    await expect(findImpactSbtGallery()).resolves.toEqual([]);
    await expect(countImpactSbtGallery()).resolves.toBe(0);
  });

  it('keeps an unmanaged token event pending without preventing a later valid revoke from hiding its gallery token', async () => {
    await expect(projectSbtTokenStatusUpdate({
      chainId: '490000',
      contractAddress: '0x0000000000000000000000000000000000000001',
      transactionHash: '0xunmanaged-token-status',
      logIndex: 0,
      blockNumber: 200,
      blockHash: '0xblock',
      tokenId: 999,
      newStatus: 'FROZEN',
      reason: 'Legacy token.'
    })).resolves.toBe(false);

    await expect(projectSbtTokenStatusUpdate({
      chainId: '490000',
      contractAddress: '0x0000000000000000000000000000000000000001',
      transactionHash: '0xmanaged-token-revoke',
      logIndex: 1,
      blockNumber: 201,
      blockHash: '0xblock',
      tokenId: 12,
      newStatus: 'REVOKED',
      reason: 'Evidence invalidated.'
    })).resolves.toBe(true);

    await expect(mongoose.connection.collection('sbt_status_projection_events').findOne({
      transactionHash: '0xunmanaged-token-status',
      logIndex: 0
    })).resolves.toMatchObject({ projectionStatus: 'PENDING' });
    await expect(findImpactSbtGallery()).resolves.toEqual([]);
    await expect(countImpactSbtGallery()).resolves.toBe(0);
  });
});
