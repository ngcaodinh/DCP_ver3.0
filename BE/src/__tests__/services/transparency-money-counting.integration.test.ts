import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  getCompletedDisbursementSummaryByProjectId,
  findCompletedDisbursementAmountsByProjectId
} from '../../models/disbursementModel';
import { UnifiedTransactionModel } from '../../models/unifiedTransactionModel';
import { aggregateSummaryByProjectId } from '../../repositories/unifiedTransactionRepository';

let mongoServer: MongoMemoryServer;

/** Tạo fixture unified transaction đủ trường để chạy aggregation trên Mongo thật. */
function buildUnifiedTransaction(overrides: Record<string, unknown>): Record<string, unknown> {
  const now = new Date('2026-08-10T00:00:00.000Z');
  return {
    utxId: `utx-${String(overrides.correlationId || 'fixture')}`,
    correlationId: `correlation-${String(overrides.correlationId || 'fixture')}`,
    projectId: 'project-money-counting',
    walletAddress: '0x742d35cc6634c0532925a3b844bc9e7595f5c21a',
    eventType: 'DONATION',
    amountVnd: 0,
    eventTimestamp: now,
    source: 'BLOCKCHAIN',
    chainStatus: 'CONFIRMED',
    chainTxHash: null,
    chainBlockNumber: null,
    payosStatus: null,
    payosOrderCode: null,
    payosTransactionId: null,
    payosRecordId: null,
    blockchainRecordId: null,
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

/** Tạo fixture disbursement tối thiểu cho các query summary COMPLETED. */
function buildDisbursement(
  index: number,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  const createdAt = new Date('2026-01-01T00:00:00.000Z');
  createdAt.setUTCDate(createdAt.getUTCDate() + index);
  return {
    requestId: `request-${index}`,
    projectId: 'project-money-counting',
    status: 'COMPLETED',
    amount: index,
    createdAt,
    ...overrides
  };
}

describe('transparency money-counting Mongo integration', () => {
  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    await UnifiedTransactionModel.init();
    await mongoose.model('Disbursement').init();
  });

  beforeEach(async () => {
    await Promise.all([
      UnifiedTransactionModel.collection.deleteMany({}),
      mongoose.connection.collection('disbursements').deleteMany({})
    ]);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  it('loại REORGED/FAILED, chỉ tính DONATION và deduplicate donor không phân biệt hoa thường', async () => {
    await UnifiedTransactionModel.collection.insertMany([
      buildUnifiedTransaction({
        correlationId: 'confirmed-lower',
        amountVnd: 1000,
        walletAddress: '0x742d35cc6634c0532925a3b844bc9e7595f5c21a'
      }),
      buildUnifiedTransaction({
        correlationId: 'confirmed-upper',
        amountVnd: 2000,
        walletAddress: '0x742D35Cc6634C0532925a3b844Bc9e7595f5C21a'
      }),
      buildUnifiedTransaction({
        correlationId: 'reorged',
        amountVnd: 500,
        chainStatus: 'REORGED',
        walletAddress: '0x1111111111111111111111111111111111111111'
      }),
      buildUnifiedTransaction({
        correlationId: 'failed',
        amountVnd: 700,
        chainStatus: 'FAILED',
        walletAddress: '0x2222222222222222222222222222222222222222'
      }),
      buildUnifiedTransaction({
        correlationId: 'disbursement-is-not-raised',
        eventType: 'DISBURSEMENT',
        amountVnd: 999999
      }),
      buildUnifiedTransaction({
        correlationId: 'other-project',
        projectId: 'project-other',
        amountVnd: 8000
      })
    ]);

    const result = await aggregateSummaryByProjectId('project-money-counting');

    expect(result).toEqual({
      totalRaisedVnd: 3000,
      totalTransactions: 2,
      uniqueDonorCount: 1,
      excludedReorgedVnd: 500,
      excludedReorgedCount: 1
    });
  });

  it('tính toàn bộ COMPLETED nhưng chỉ trả tối đa 100 amount gần nhất', async () => {
    const completedRecords = Array.from({ length: 150 }, (_, index) => buildDisbursement(index + 1));
    await mongoose.connection.collection('disbursements').insertMany([
      ...completedRecords,
      buildDisbursement(999, { projectId: 'project-money-counting', status: 'PENDING' }),
      buildDisbursement(1000, { projectId: 'project-other' })
    ]);

    const summary = await getCompletedDisbursementSummaryByProjectId('project-money-counting');
    const amounts = await findCompletedDisbursementAmountsByProjectId('project-money-counting', 999);

    expect(summary).toEqual({
      totalCompletedAmount: 11325,
      completedCount: 150
    });
    expect(amounts).toHaveLength(100);
    expect(amounts[0]).toBe(150);
    expect(amounts[99]).toBe(51);
  });
});
