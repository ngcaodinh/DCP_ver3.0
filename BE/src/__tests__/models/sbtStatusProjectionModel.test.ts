import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  findOrCreateSbtStatusProjectionEvent,
  findAllSbtStatusProjectionCheckpoints,
  findPendingSbtStatusProjectionEvents,
  findSbtStatusProjectionCheckpoint,
  markSbtStatusProjectionEventApplied,
  rewindSbtStatusProjectionCheckpoint,
  scheduleSbtStatusProjectionEventRetry,
  saveSbtStatusProjectionCheckpoint
} from '../../models/sbtStatusProjectionModel';

let mongoServer: MongoMemoryServer;
const scope = {
  chainId: '490000',
  contractAddress: '0x0000000000000000000000000000000000000001'
};

describe('sbtStatusProjectionModel', () => {
  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    await Promise.all([
      mongoose.model('SbtStatusProjectionEvent').syncIndexes(),
      mongoose.model('SbtStatusProjectionCheckpoint').syncIndexes()
    ]);
  });

  beforeEach(async () => {
    await mongoose.connection.collection('sbt_status_projection_checkpoints').deleteMany({});
    await mongoose.connection.collection('sbt_status_projection_events').deleteMany({});
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  it('persists a block/log checkpoint and keeps replay identity unique by chain, transaction, and log index', async () => {
    await saveSbtStatusProjectionCheckpoint(scope, 200, Number.MAX_SAFE_INTEGER);
    const eventPayload = {
      ...scope,
      transactionHash: '0xevent',
      logIndex: 3,
      blockNumber: 200,
      blockHash: '0xblock',
      tokenId: 12,
      newStatus: 'REVOKED' as const,
      reason: 'Evidence invalidated.'
    };
    const [firstEvent, replayedEvent] = await Promise.all([
      findOrCreateSbtStatusProjectionEvent(eventPayload),
      findOrCreateSbtStatusProjectionEvent(eventPayload)
    ]);
    await markSbtStatusProjectionEventApplied(firstEvent);
    await saveSbtStatusProjectionCheckpoint(scope, 199, Number.MAX_SAFE_INTEGER);

    await expect(findSbtStatusProjectionCheckpoint(scope)).resolves.toMatchObject({
      lastProcessedBlock: 200,
      lastProcessedLogIndex: Number.MAX_SAFE_INTEGER
    });
    expect(replayedEvent.projectionStatus).toBe('PENDING');
    await expect(mongoose.connection.collection('sbt_status_projection_events').countDocuments({
      chainId: scope.chainId,
      transactionHash: '0xevent',
      logIndex: 3
    })).resolves.toBe(1);
    await expect(findOrCreateSbtStatusProjectionEvent(eventPayload)).resolves.toMatchObject({
      projectionStatus: 'APPLIED'
    });
  });

  it('converges concurrent first checkpoint writes instead of leaking duplicate-key errors', async () => {
    await expect(Promise.all([
      saveSbtStatusProjectionCheckpoint(scope, 200, Number.MAX_SAFE_INTEGER),
      saveSbtStatusProjectionCheckpoint(scope, 201, Number.MAX_SAFE_INTEGER)
    ])).resolves.toHaveLength(2);

    await expect(mongoose.connection.collection('sbt_status_projection_checkpoints').countDocuments(scope))
      .resolves.toBe(1);
    await expect(findSbtStatusProjectionCheckpoint(scope)).resolves.toMatchObject({
      lastProcessedBlock: expect.any(Number)
    });
  });

  it('supports a deliberate checkpoint rewind for one-time historical backfill', async () => {
    await saveSbtStatusProjectionCheckpoint(scope, 200, Number.MAX_SAFE_INTEGER);

    await expect(rewindSbtStatusProjectionCheckpoint(scope, 100, -1)).resolves.toMatchObject({
      lastProcessedBlock: 100,
      lastProcessedLogIndex: -1
    });
    await expect(findAllSbtStatusProjectionCheckpoints()).resolves.toHaveLength(1);
  });

  it('loads only due pending events for the scope in retry schedule order with a bounded batch', async () => {
    const [laterEvent, earlierEvent] = await Promise.all([
      findOrCreateSbtStatusProjectionEvent({
        ...scope,
        transactionHash: '0xlater',
        logIndex: 1,
        blockNumber: 202,
        blockHash: '0xblock-202',
        tokenId: 12,
        newStatus: 'REVOKED',
        reason: ''
      }),
      findOrCreateSbtStatusProjectionEvent({
        ...scope,
        transactionHash: '0xearlier',
        logIndex: 2,
        blockNumber: 200,
        blockHash: '0xblock-200',
        tokenId: 13,
        newStatus: 'FROZEN',
        reason: ''
      }),
      findOrCreateSbtStatusProjectionEvent({
        ...scope,
        transactionHash: '0xother-contract',
        contractAddress: '0x0000000000000000000000000000000000000002',
        logIndex: 0,
        blockNumber: 199,
        blockHash: '0xother-block',
        tokenId: 14,
        newStatus: 'ACTIVE',
        reason: ''
      })
    ]);
    const retryScheduledAt = new Date('2030-01-01T00:00:00.000Z');
    await Promise.all([
      scheduleSbtStatusProjectionEventRetry(laterEvent, retryScheduledAt),
      scheduleSbtStatusProjectionEventRetry(earlierEvent, retryScheduledAt)
    ]);

    await expect(findPendingSbtStatusProjectionEvents(scope, 1, new Date('2030-01-01T00:00:15.000Z'))).resolves.toMatchObject([
      { transactionHash: '0xearlier', logIndex: 2 }
    ]);
  });

  it('does not let 200 deferred legacy events starve a later event that is ready to retry', async () => {
    const retryScheduledAt = new Date();
    const legacyEvents = await Promise.all(
      Array.from({ length: 200 }, (_, index) => findOrCreateSbtStatusProjectionEvent({
        ...scope,
        transactionHash: `0xlegacy-${index}`,
        logIndex: 0,
        blockNumber: 200 + index,
        blockHash: `0xlegacy-block-${index}`,
        tokenId: 1_000 + index,
        newStatus: 'FROZEN',
        reason: 'Legacy token.'
      }))
    );
    await mongoose.connection.collection('sbt_status_projection_events').updateMany(
      { transactionHash: { $in: legacyEvents.map(event => event.transactionHash) } },
      { $unset: { retryAttempt: '', nextRetryAt: '', lastAttemptedAt: '' } }
    );
    const legacyEventsWithoutRetryMetadata = await findPendingSbtStatusProjectionEvents(scope, 200, new Date());
    await Promise.all(
      legacyEventsWithoutRetryMetadata.map(event => scheduleSbtStatusProjectionEventRetry(event, retryScheduledAt))
    );
    await findOrCreateSbtStatusProjectionEvent({
      ...scope,
      transactionHash: '0xready-after-legacy-batch',
      logIndex: 0,
      blockNumber: 500,
      blockHash: '0xready-block',
      tokenId: 12,
      newStatus: 'REVOKED',
      reason: 'Evidence invalidated.'
    });

    await expect(findPendingSbtStatusProjectionEvents(scope, 200, new Date())).resolves.toMatchObject([
      { transactionHash: '0xready-after-legacy-batch', retryAttempt: 0 }
    ]);
    await expect(mongoose.connection.collection('sbt_status_projection_events').findOne({
      transactionHash: '0xlegacy-0',
      logIndex: 0
    })).resolves.toMatchObject({
      retryAttempt: 1,
      lastAttemptedAt: retryScheduledAt,
      nextRetryAt: expect.any(Date)
    });
  });

  it('caps exponential retry delay for a permanently unresolved event', async () => {
    const retryScheduledAt = new Date('2030-01-01T00:00:00.000Z');
    const eventPayload = {
      ...scope,
      transactionHash: '0xbounded-backoff',
      logIndex: 0,
      blockNumber: 600,
      blockHash: '0xbounded-block',
      tokenId: 99,
      newStatus: 'FROZEN' as const,
      reason: 'Legacy token.'
    };

    for (let index = 0; index < 10; index += 1) {
      const event = await findOrCreateSbtStatusProjectionEvent(eventPayload);
      await scheduleSbtStatusProjectionEventRetry(event, retryScheduledAt);
    }

    await expect(mongoose.connection.collection('sbt_status_projection_events').findOne({
      transactionHash: '0xbounded-backoff',
      logIndex: 0
    })).resolves.toMatchObject({
      retryAttempt: 10,
      nextRetryAt: new Date('2030-01-01T01:00:00.000Z')
    });
  });
});
