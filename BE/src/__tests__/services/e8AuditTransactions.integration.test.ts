import mongoose, { type ClientSession } from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AdminActionOutboxModel } from '../../models/adminActionOutboxModel';
import { AdminAuditLogModel, type AdminAuditAction, type AdminAuditTargetType } from '../../models/adminAuditLogModel';
import { BeneficiaryFeedbackModel } from '../../models/beneficiaryFeedbackModel';
import { ManualReviewQueueMongoModel } from '../../models/manualReviewQueueModel';
import '../../models/disbursementModel';
import { type DisbursementRecord } from '../../models/disbursementModel';
import '../../models/impactSbtMetadataModel';
import { type ImpactSbtMetadataRecord } from '../../models/impactSbtMetadataModel';
import '../../models/oracleOverrideRequestModel';
import { type OracleOverrideRequestRecord } from '../../models/oracleOverrideRequestModel';
import { runMongoTransaction } from '../../utils/mongoTransaction';

const disbursementModel = mongoose.model<DisbursementRecord>('Disbursement');
const impactSbtModel = mongoose.model<ImpactSbtMetadataRecord>('ImpactSbtMetadata');
const overrideModel = mongoose.model<OracleOverrideRequestRecord>('OracleOverrideRequest');

let mongoReplicaSet: MongoMemoryReplSet;

/** Ghi audit fixture có actionId trùng để kích hoạt duplicate-key trong transaction. */
async function insertAuditFixture(
  actionId: string,
  actionType: AdminAuditAction,
  targetId: string,
  targetType: AdminAuditTargetType,
  session?: ClientSession
): Promise<void> {
  const document = new AdminAuditLogModel({
    actionId,
    actorType: 'ADMIN',
    adminId: 'admin-fixture',
    adminRole: 'admin',
    actionType,
    targetId,
    targetType,
    reason: 'Fixture audit record',
    context: {},
    auditId: actionId,
    adminUserId: 'admin-fixture',
    action: actionType,
    targetRequestId: targetId,
    metadata: {},
    createdAt: new Date()
  });
  await document.save(session ? { session } : undefined);
}

/** Xóa toàn bộ collection E8 giữa các test để mỗi transaction journey độc lập. */
async function clearE8Collections(): Promise<void> {
  await Promise.all([
    AdminActionOutboxModel.deleteMany({}),
    AdminAuditLogModel.deleteMany({}),
    BeneficiaryFeedbackModel.deleteMany({}),
    ManualReviewQueueMongoModel.deleteMany({}),
    disbursementModel.deleteMany({}),
    impactSbtModel.deleteMany({}),
    overrideModel.deleteMany({})
  ]);
}

describe('E8 audit transaction Mongo integration', () => {
  beforeAll(async () => {
    mongoReplicaSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(mongoReplicaSet.getUri());
    await Promise.all([
      AdminActionOutboxModel.init(),
      AdminAuditLogModel.init(),
      BeneficiaryFeedbackModel.init(),
      ManualReviewQueueMongoModel.init(),
      disbursementModel.init(),
      impactSbtModel.init(),
      overrideModel.init()
    ]);
  });

  beforeEach(async () => {
    await clearE8Collections();
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoReplicaSet.stop();
  });

  it('rolls back feedback flag when audit insert fails', async () => {
    await BeneficiaryFeedbackModel.create({
      feedbackId: 'feedback-tx-1',
      projectId: 'project-1',
      beneficiaryNameHash: 'hash',
      rating: 5,
      comment: 'Feedback fixture',
      submittedAt: new Date(),
      riskScore: 9,
      isFlagged: false,
      uploadedByOrganizationId: 'org-1',
      batchContentHash: 'batch-tx-1'
    });
    await insertAuditFixture('feedback-duplicate', 'FEEDBACK_FLAG', 'feedback-tx-1', 'BENEFICIARY_FEEDBACK');

    await expect(runMongoTransaction(async session => {
      await BeneficiaryFeedbackModel.findOneAndUpdate(
        { feedbackId: 'feedback-tx-1', isFlagged: false },
        { $set: { isFlagged: true } },
        { returnDocument: 'after', session }
      ).exec();
      await insertAuditFixture('feedback-duplicate', 'FEEDBACK_FLAG', 'feedback-tx-1', 'BENEFICIARY_FEEDBACK', session);
    })).rejects.toThrow(/duplicate/i);

    const feedback = await BeneficiaryFeedbackModel.findOne({ feedbackId: 'feedback-tx-1' }).lean().exec();
    expect(feedback?.isFlagged).toBe(false);
    expect(await AdminAuditLogModel.countDocuments({ targetId: 'feedback-tx-1' })).toBe(1);
  });

  it('rolls back override vote when per-vote audit insert fails', async () => {
    await overrideModel.create({
      overrideRequestId: 'override-tx-1',
      verificationId: 'verification-tx-1',
      projectId: 'project-1',
      organizationId: 'org-1',
      evidenceCid: 'bafyfixture',
      disbursementRequestId: null,
      reason: 'NO_GEOFENCE',
      gpsFromImage: null,
      gpsFromProject: { lat: 10, lng: 106 },
      distanceMeters: null,
      commissionerSnapshot: [{ userId: 'admin-1', role: 'admin' }],
      votes: [],
      status: 'PENDING',
      resolvedAt: null,
      expiredAt: null
    });
    await insertAuditFixture('override-duplicate', 'OVERRIDE_VOTE_APPROVE', 'override-tx-1', 'OVERRIDE_REQUEST');

    await expect(runMongoTransaction(async session => {
      await overrideModel.findOneAndUpdate(
        { overrideRequestId: 'override-tx-1', status: 'PENDING' },
        { $push: { votes: { commissionerId: 'admin-1', commissionerRole: 'admin', vote: 'APPROVE', reason: 'Valid vote reason', votedAt: new Date() } } },
        { returnDocument: 'after', session }
      ).exec();
      await insertAuditFixture('override-duplicate', 'OVERRIDE_VOTE_APPROVE', 'override-tx-1', 'OVERRIDE_REQUEST', session);
    })).rejects.toThrow(/duplicate/i);

    const overrideRequest = await overrideModel.findOne({ overrideRequestId: 'override-tx-1' }).lean().exec();
    expect(overrideRequest?.votes).toHaveLength(0);
    expect(overrideRequest?.status).toBe('PENDING');
  });

  it('rolls back manual state, queue resolution and outbox together when audit fails', async () => {
    await disbursementModel.create({
      requestId: 'disbursement-tx-1',
      onChainRequestId: 1,
      projectId: 'project-1',
      onChainProjectId: 1,
      organizationId: 'org-1',
      requestMode: 'NORMAL',
      emergencyReason: null,
      requiredApprovals: 2,
      raisedRatioBpsAtCreation: 10000,
      beneficiaryWalletAddress: '0x742d35cc6634c0532925a3b844bc9e7595f5c21a',
      beneficiaryBankAccount: { bankName: 'Bank', bankAccountNumber: '123', accountHolderName: 'Holder' },
      amount: 100,
      usagePurpose: 'Purpose',
      evidenceCid: 'bafyfixture',
      status: 'APPROVED',
      approvals: [],
      rejection: null,
      timeoutDeadline: null,
      payosTransferId: null,
      payosTransferStatus: 'MANUAL_REVIEW',
      payosTransferAttemptCount: 0,
      payosTransferLastError: 'provider failed',
      transferIdempotencyKey: null,
      transactionHash: null,
      finalizeTransactionHash: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      expiredAt: null,
      completedAt: null
    });
    await ManualReviewQueueMongoModel.create({
      queueId: 'queue-tx-1',
      disbursementRequestId: 'disbursement-tx-1',
      payosTransferId: null,
      projectId: 'project-1',
      organizationId: 'org-1',
      reason: 'Provider failed',
      retryCount: 1,
      reviewCycle: 1,
      assignedAdminId: 'admin-1',
      assignmentMethod: 'UNASSIGNED',
      requestMode: 'NORMAL',
      status: 'PENDING',
      assignedAt: null,
      resolvedAt: null,
      resolvedByAdminId: null,
      resolutionReason: null,
      slaDeadline: new Date(Date.now() + 60_000),
      escalatedAt: null,
      actionLockId: 'lock-tx-1',
      actionLockExpiresAt: new Date(Date.now() + 60_000),
      retentionExpiresAt: null
    });
    await insertAuditFixture('manual-duplicate', 'MANUAL_APPROVE', 'disbursement-tx-1', 'DISBURSEMENT_REQUEST');

    await expect(runMongoTransaction(async session => {
      await disbursementModel.updateOne(
        { requestId: 'disbursement-tx-1', payosTransferStatus: 'MANUAL_REVIEW' },
        { $set: { payosTransferStatus: 'PROCESSING', transferIdempotencyKey: 'manual-idempotency-tx-1' } },
        { session }
      ).exec();
      await ManualReviewQueueMongoModel.updateOne(
        { queueId: 'queue-tx-1', status: 'PENDING', actionLockId: 'lock-tx-1' },
        { $set: { status: 'APPROVED', actionLockId: null, actionLockExpiresAt: null } },
        { session }
      ).exec();
      await AdminActionOutboxModel.create([{
        eventId: 'manual-outbox-tx-1',
        eventType: 'MANUAL_APPROVE_TRANSFER',
        payload: { requestId: 'disbursement-tx-1', idempotencyKey: 'manual-idempotency-tx-1' },
        status: 'PENDING',
        attempts: 0,
        availableAt: new Date(),
        lockedAt: null,
        dispatchedAt: null,
        createdAt: new Date(),
        updatedAt: new Date()
      }], { session });
      await insertAuditFixture('manual-duplicate', 'MANUAL_APPROVE', 'disbursement-tx-1', 'DISBURSEMENT_REQUEST', session);
    })).rejects.toThrow(/duplicate/i);

    const disbursement = await disbursementModel.findOne({ requestId: 'disbursement-tx-1' }).lean().exec();
    const queue = await ManualReviewQueueMongoModel.findOne({ queueId: 'queue-tx-1' }).lean().exec();
    expect(disbursement?.payosTransferStatus).toBe('MANUAL_REVIEW');
    expect(queue?.status).toBe('PENDING');
    expect(await AdminActionOutboxModel.countDocuments({ eventId: 'manual-outbox-tx-1' })).toBe(0);
  });

  it('rolls back SBT reset and rerun outbox together when audit fails', async () => {
    await impactSbtModel.create({
      sbtId: 'sbt-tx-1',
      mintRequestId: 'mint-tx-1',
      verificationId: 'verification-sbt-tx-1',
      projectId: 'project-1',
      organizationId: 'org-1',
      beneficiaryAddress: '0x742d35cc6634c0532925a3b844bc9e7595f5c21a',
      projectIdNumeric: 1,
      milestone: 1,
      beneficiaryCount: 1,
      gpsCoordinates: '10,106',
      imageCid: 'bafyfixture',
      tokenUri: 'ipfs://bafyfixture',
      status: 'DLQ',
      attemptNumber: 6,
      lastErrorMessage: 'mint failed',
      onChainTokenId: null,
      transactionHash: null,
      blockNumber: null,
      confirmedAt: null,
      submittedAt: null,
      dlqAt: new Date(),
      reRunCount: 0,
      lastReRunBy: null,
      lastReRunAt: null
    });
    await insertAuditFixture('sbt-duplicate', 'SBT_MINT_RERUN_REQUESTED', 'mint-tx-1', 'SBT_MINT_REQUEST');

    await expect(runMongoTransaction(async session => {
      await impactSbtModel.updateOne(
        { mintRequestId: 'mint-tx-1', status: 'DLQ' },
        { $set: { status: 'PENDING', attemptNumber: 0, reRunCount: 1, lastReRunBy: 'admin-1' } },
        { session }
      ).exec();
      await AdminActionOutboxModel.create([{
        eventId: 'sbt-outbox-tx-1',
        eventType: 'SBT_MINT_RERUN',
        payload: { mintRequestId: 'mint-tx-1', sbtId: 'sbt-tx-1', attemptNumber: 1, adminId: 'admin-1', adminRole: 'admin' },
        status: 'PENDING',
        attempts: 0,
        availableAt: new Date(),
        lockedAt: null,
        dispatchedAt: null,
        createdAt: new Date(),
        updatedAt: new Date()
      }], { session });
      await insertAuditFixture('sbt-duplicate', 'SBT_MINT_RERUN_REQUESTED', 'mint-tx-1', 'SBT_MINT_REQUEST', session);
    })).rejects.toThrow(/duplicate/i);

    const record = await impactSbtModel.findOne({ mintRequestId: 'mint-tx-1' }).lean().exec();
    expect(record?.status).toBe('DLQ');
    expect(record?.reRunCount).toBe(0);
    expect(await AdminActionOutboxModel.countDocuments({ eventId: 'sbt-outbox-tx-1' })).toBe(0);
  });
});
