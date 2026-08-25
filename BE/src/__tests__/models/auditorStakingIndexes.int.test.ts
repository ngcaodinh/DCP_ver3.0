import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createAuditorPayout } from '../../models/auditorPayoutModel';
import { createAuditorStakeIntent } from '../../models/auditorStakeIntentModel';
import {
  createAuditorDebtSettlement,
  findAuditorDebtSettlementById,
  moveUncertainAuditorDebtSettlementsToManualReview
} from '../../models/auditorDebtSettlementModel';
import {
  acquireAuditorOpenCase,
  acquireAuditorUnstakeLock,
  initializeAuditorStakeGuard
} from '../../models/auditorStakeGuardModel';

let mongoServer: MongoMemoryServer;

/** Tạo payout tối thiểu hợp lệ để kiểm tra index MongoDB thay vì mock Mongoose. */
function createPayoutInput(payoutId: string, sourceRefId: string, onchainTxHash: string | null) {
  const now = new Date();
  return {
    payoutId,
    auditorUserId: `auditor-${payoutId}`,
    payoutType: 'STAKE_WITHDRAWAL' as const,
    sourceRefId,
    amountVnd: 100_000,
    feeVnd: 5_000,
    netAmountVnd: 95_000,
    bankSnapshot: {
      bankName: 'Vietcombank',
      bankCode: 'VCB',
      bankAccountNumber: `0000${payoutId}`,
      accountHolderName: 'NGUYEN VAN A'
    },
    status: 'PENDING' as const,
    payosTransferId: null,
    transferIdempotencyKey: `payout:${payoutId}`,
    onchainTxHash,
    burnTxHash: null,
    attemptNumber: 0,
    errorMessage: null,
    createdAt: now,
    updatedAt: now
  };
}

/** Tạo intent tối thiểu hợp lệ để chứng minh null không chiếm unique slot transaction hash. */
function createStakeIntentInput(intentId: string, txHash: string | null) {
  const now = new Date();
  return {
    id: intentId,
    userId: `auditor-${intentId}`,
    walletAddress: `0x${intentId.padStart(40, '0').slice(-40)}`,
    minimumStakeThreshold: '3000000',
    status: 'PENDING_TX' as const,
    txHash,
    failureReason: null,
    correlationId: `correlation-${intentId}`,
    createdAt: now,
    updatedAt: now
  };
}

describe('AuditorStaking MongoDB indexes', () => {
  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    await Promise.all([
      mongoose.model('AuditorPayout').syncIndexes(),
      mongoose.model('AuditorStakeIntent').syncIndexes(),
      mongoose.model('AuditorDebtSettlement').syncIndexes(),
      mongoose.model('AuditorStakeGuard').syncIndexes()
    ]);
  }, 60_000);

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  it('allows multiple pending payouts without an on-chain hash but rejects a duplicated confirmed hash', async () => {
    await createAuditorPayout(createPayoutInput('payout-1', 'source-1', null));
    await createAuditorPayout(createPayoutInput('payout-2', 'source-2', null));
    await createAuditorPayout(createPayoutInput('payout-3', 'source-3', '0xconfirmed'));

    await expect(createAuditorPayout(createPayoutInput('payout-4', 'source-4', '0xconfirmed')))
      .rejects.toMatchObject({ code: 11_000 });
  });

  it('allows multiple pending stake intents without a transaction hash but rejects a duplicated submitted hash', async () => {
    await createAuditorStakeIntent(createStakeIntentInput('intent-1', null));
    await createAuditorStakeIntent(createStakeIntentInput('intent-2', null));
    await createAuditorStakeIntent(createStakeIntentInput('intent-3', '0xstake'));

    await expect(createAuditorStakeIntent(createStakeIntentInput('intent-4', '0xstake')))
      .rejects.toMatchObject({ code: 11_000 });
  });

  it('moves only stale uncertain submission states to manual review', async () => {
    const oldUpdatedAt = new Date(Date.now() - 11 * 60_000);
    const freshUpdatedAt = new Date();
    await Promise.all([
      createAuditorDebtSettlement({
        settlementId: 'pending-settlement', auditorUserId: 'auditor-pending', payoutId: null,
        withdrawalAmountVnd: 100, debtAmountVnd: 100, withdrawalTxHash: null, fundRewardPoolTxHash: null,
        status: 'PENDING_WITHDRAWAL', errorMessage: null, createdAt: oldUpdatedAt, updatedAt: oldUpdatedAt
      }),
      createAuditorDebtSettlement({
        settlementId: 'stale-submitting-settlement', auditorUserId: 'auditor-stale', payoutId: null,
        withdrawalAmountVnd: 100, debtAmountVnd: 100, withdrawalTxHash: null, fundRewardPoolTxHash: null,
        status: 'WITHDRAWAL_SUBMITTING', errorMessage: null, createdAt: oldUpdatedAt, updatedAt: oldUpdatedAt
      }),
      createAuditorDebtSettlement({
        settlementId: 'fresh-submitting-settlement', auditorUserId: 'auditor-fresh', payoutId: null,
        withdrawalAmountVnd: 100, debtAmountVnd: 100, withdrawalTxHash: null, fundRewardPoolTxHash: null,
        status: 'FUNDING_SUBMITTING', errorMessage: null, createdAt: freshUpdatedAt, updatedAt: freshUpdatedAt
      })
    ]);
    await mongoose.connection.collection('auditordebtsettlements').updateMany(
      { settlementId: { $in: ['pending-settlement', 'stale-submitting-settlement'] } },
      { $set: { updatedAt: oldUpdatedAt } }
    );

    await moveUncertainAuditorDebtSettlementsToManualReview(new Date(Date.now() - 10 * 60_000));

    await expect(findAuditorDebtSettlementById('pending-settlement')).resolves.toMatchObject({ status: 'PENDING_WITHDRAWAL' });
    await expect(findAuditorDebtSettlementById('stale-submitting-settlement')).resolves.toMatchObject({ status: 'MANUAL_REVIEW' });
    await expect(findAuditorDebtSettlementById('fresh-submitting-settlement')).resolves.toMatchObject({ status: 'FUNDING_SUBMITTING' });
  });

  it('allows exactly one winner when opening a case races an unstake request for the same wallet', async () => {
    await initializeAuditorStakeGuard('race-auditor');

    const [unstakeLock, openCaseLock] = await Promise.all([
      acquireAuditorUnstakeLock('race-auditor', 'unstake-lock'),
      acquireAuditorOpenCase('race-auditor', 'case-1')
    ]);

    expect([unstakeLock, openCaseLock].filter(Boolean)).toHaveLength(1);
  });
});
