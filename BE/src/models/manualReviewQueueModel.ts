import { randomUUID } from 'crypto';
import mongoose, { Schema, type ClientSession } from 'mongoose';
import type { DisbursementRequestMode } from './disbursementModel';

export type ManualReviewQueueStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export type ManualReviewAssignmentMethod =
  | 'PROJECT_AFFINITY'
  | 'ROUND_ROBIN'
  | 'LEAST_LOADED'
  | 'UNASSIGNED';

export type ManualReviewQueueRecord = {
  queueId: string;
  disbursementRequestId: string;
  payosTransferId: string | null;
  projectId: string;
  organizationId: string;
  reason: string;
  retryCount: number;
  reviewCycle: number;
  assignedAdminId: string | null;
  assignmentMethod: ManualReviewAssignmentMethod;
  /** Snapshot phục vụ routing/UI; disbursement mới là nguồn sự thật tài chính. */
  requestMode?: DisbursementRequestMode;
  status: ManualReviewQueueStatus;
  assignedAt: Date | null;
  resolvedAt: Date | null;
  resolvedByAdminId: string | null;
  resolutionReason: string | null;
  slaDeadline: Date;
  escalatedAt: Date | null;
  actionLockId: string | null;
  actionLockExpiresAt: Date | null;
  escalationClaimId?: string | null;
  escalationClaimExpiresAt?: Date | null;
  retentionExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type ManualReviewQueueOpenInput = {
  disbursementRequestId: string;
  payosTransferId: string | null;
  projectId: string;
  organizationId: string;
  reason: string;
  retryCount: number;
  reviewCycle: number;
  assignedAdminId: string | null;
  assignmentMethod: ManualReviewAssignmentMethod;
  requestMode: DisbursementRequestMode;
  assignedAt: Date | null;
  slaDeadline: Date;
};

export type ManualReviewQueueUpsertResult = {
  queue: ManualReviewQueueRecord;
  created: boolean;
};

export type ManualReviewQueuePaginationInput = {
  page: number;
  limit: number;
  requestMode?: DisbursementRequestMode;
  overdueOnly?: boolean;
};

export type ManualReviewQueueCounts = {
  all: number;
  emergency: number;
  normal: number;
  overdue: number;
};

const RETENTION_YEARS = 5;

const manualReviewQueueSchema = new Schema<ManualReviewQueueRecord>(
  {
    queueId: { type: String, required: true, unique: true },
    disbursementRequestId: { type: String, required: true, index: true },
    payosTransferId: { type: String, default: null },
    projectId: { type: String, required: true, index: true },
    organizationId: { type: String, required: true, index: true },
    reason: { type: String, required: true, trim: true, maxlength: 1000 },
    retryCount: { type: Number, required: true, min: 0 },
    reviewCycle: { type: Number, required: true, min: 1 },
    assignedAdminId: { type: String, default: null, index: true },
    assignmentMethod: {
      type: String,
      required: true,
      enum: ['PROJECT_AFFINITY', 'ROUND_ROBIN', 'LEAST_LOADED', 'UNASSIGNED']
    },
    // Đây là snapshot phục vụ filter/UI; disbursement vẫn là nguồn sự thật tài chính.
    requestMode: { type: String, enum: ['NORMAL', 'EMERGENCY'], default: undefined },
    status: {
      type: String,
      required: true,
      enum: ['PENDING', 'APPROVED', 'REJECTED'],
      default: 'PENDING',
      index: true
    },
    assignedAt: { type: Date, default: null },
    resolvedAt: { type: Date, default: null },
    resolvedByAdminId: { type: String, default: null },
    resolutionReason: { type: String, default: null, maxlength: 1000 },
    slaDeadline: { type: Date, required: true, index: true },
    escalatedAt: { type: Date, default: null },
    actionLockId: { type: String, default: null },
    actionLockExpiresAt: { type: Date, default: null },
    escalationClaimId: { type: String, default: null },
    escalationClaimExpiresAt: { type: Date, default: null },
    retentionExpiresAt: { type: Date, default: null }
  },
  { collection: 'manual_review_queue', timestamps: true }
);

manualReviewQueueSchema.index({ disbursementRequestId: 1, reviewCycle: 1 }, { unique: true });
manualReviewQueueSchema.index({ assignedAdminId: 1, status: 1, createdAt: 1 });
manualReviewQueueSchema.index({ projectId: 1, status: 1 });
manualReviewQueueSchema.index({ status: 1, slaDeadline: 1 });
manualReviewQueueSchema.index({ status: 1, requestMode: 1, createdAt: -1 });
manualReviewQueueSchema.index({ retentionExpiresAt: 1 }, { expireAfterSeconds: 0 });

export const ManualReviewQueueMongoModel = mongoose.model<ManualReviewQueueRecord>(
  'ManualReviewQueue',
  manualReviewQueueSchema
);

/** Tạo queueId ổn định cho từng chu kỳ review thủ công. */
export function createManualReviewQueueId(disbursementRequestId: string, reviewCycle: number): string {
  return `MRQ-${disbursementRequestId}-${reviewCycle}-${randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}

/** Tính thời điểm hết hạn lưu trữ sau khi queue item đã được resolve. */
function buildRetentionExpiresAt(resolvedAt: Date): Date {
  const retentionExpiresAt = new Date(resolvedAt);
  retentionExpiresAt.setFullYear(retentionExpiresAt.getFullYear() + RETENTION_YEARS);
  return retentionExpiresAt;
}

/** Nhận diện lỗi unique index MongoDB khi hai ingress cùng mở một review cycle. */
function isDuplicateManualReviewQueueKeyError(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === 'object'
    && 'code' in error
    && (error as { code?: unknown }).code === 11000
  );
}

/** Tìm queue item mới nhất của một disbursement để xác định review cycle kế tiếp. */
export async function findLatestManualReviewQueueByRequestId(
  disbursementRequestId: string
): Promise<ManualReviewQueueRecord | null> {
  return ManualReviewQueueMongoModel.findOne({ disbursementRequestId })
    .sort({ reviewCycle: -1 })
    .lean<ManualReviewQueueRecord>()
    .exec();
}

/** Tìm queue item pending theo requestId để action API vẫn dùng contract requestId hiện hữu. */
export async function findPendingManualReviewQueueByRequestId(
  disbursementRequestId: string
): Promise<ManualReviewQueueRecord | null> {
  return ManualReviewQueueMongoModel.findOne({
    disbursementRequestId,
    status: 'PENDING'
  }).lean<ManualReviewQueueRecord>().exec();
}

/** Upsert queue item pending theo review cycle, giúp webhook/worker replay không tạo duplicate. */
export async function upsertManualReviewQueue(
  input: ManualReviewQueueOpenInput
): Promise<ManualReviewQueueUpsertResult> {
  const existingQueue = await ManualReviewQueueMongoModel.findOne({
    disbursementRequestId: input.disbursementRequestId,
    reviewCycle: input.reviewCycle
  }).lean<ManualReviewQueueRecord>().exec();

  if (existingQueue && existingQueue.status !== 'PENDING') {
    return { queue: existingQueue, created: false };
  }

  if (existingQueue) {
    const queue = await ManualReviewQueueMongoModel.findOneAndUpdate(
      {
        disbursementRequestId: input.disbursementRequestId,
        reviewCycle: input.reviewCycle,
        status: 'PENDING'
      },
      {
        $set: {
          payosTransferId: input.payosTransferId,
          reason: input.reason,
          retryCount: input.retryCount
        }
      },
      { returnDocument: 'after' }
    ).lean<ManualReviewQueueRecord>().exec();

    return { queue: queue ?? existingQueue, created: false };
  }

  try {
    const createdQueue = await ManualReviewQueueMongoModel.create({
      queueId: createManualReviewQueueId(input.disbursementRequestId, input.reviewCycle),
      disbursementRequestId: input.disbursementRequestId,
      payosTransferId: input.payosTransferId,
      projectId: input.projectId,
      organizationId: input.organizationId,
      reason: input.reason,
      retryCount: input.retryCount,
      reviewCycle: input.reviewCycle,
      assignedAdminId: input.assignedAdminId,
      assignmentMethod: input.assignmentMethod,
      requestMode: input.requestMode,
      status: 'PENDING',
      assignedAt: input.assignedAt,
      resolvedAt: null,
      resolvedByAdminId: null,
      resolutionReason: null,
      slaDeadline: input.slaDeadline,
      escalatedAt: null,
      actionLockId: null,
      actionLockExpiresAt: null,
      escalationClaimId: null,
      escalationClaimExpiresAt: null,
      retentionExpiresAt: null
    });

    return { queue: createdQueue.toObject() as ManualReviewQueueRecord, created: true };
  } catch (error) {
    if (isDuplicateManualReviewQueueKeyError(error)) {
      const racedQueue = await ManualReviewQueueMongoModel.findOneAndUpdate(
        {
          disbursementRequestId: input.disbursementRequestId,
          reviewCycle: input.reviewCycle,
          status: 'PENDING'
        },
        {
          $set: {
            payosTransferId: input.payosTransferId,
            reason: input.reason,
            retryCount: input.retryCount
          }
        },
        { returnDocument: 'after' }
      ).lean<ManualReviewQueueRecord>().exec()
        ?? await ManualReviewQueueMongoModel.findOne({
          disbursementRequestId: input.disbursementRequestId,
          reviewCycle: input.reviewCycle
        }).lean<ManualReviewQueueRecord>().exec();
      if (racedQueue) {
        return { queue: racedQueue, created: false };
      }
    }
    throw error;
  }
}

/** Lấy danh sách queue pending có phân trang để API không trả payload không giới hạn. */
export async function findPendingManualReviewQueuesPaginated(
  input: ManualReviewQueuePaginationInput
): Promise<{ items: ManualReviewQueueRecord[]; total: number }> {
  const skip = (input.page - 1) * input.limit;
  const filter: Record<string, unknown> = { status: 'PENDING' };
  if (input.requestMode) {
    filter.requestMode = input.requestMode;
  }
  if (input.overdueOnly) {
    filter.slaDeadline = { $lte: new Date() };
  }

  const [items, total] = await Promise.all([
    ManualReviewQueueMongoModel.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(input.limit)
      .lean<ManualReviewQueueRecord[]>()
      .exec(),
    ManualReviewQueueMongoModel.countDocuments(filter).exec()
  ]);

  return { items, total };
}

/** Đếm queue PENDING theo các tab dashboard bằng một aggregate `$facet` duy nhất. */
export async function countPendingManualReviewQueuesByTab(): Promise<ManualReviewQueueCounts> {
  const now = new Date();
  const [result] = await ManualReviewQueueMongoModel.aggregate<{
    all: Array<{ count: number }>;
    emergency: Array<{ count: number }>;
    normal: Array<{ count: number }>;
    overdue: Array<{ count: number }>;
  }>([
    { $match: { status: 'PENDING' } },
    {
      $facet: {
        all: [{ $count: 'count' }],
        emergency: [{ $match: { requestMode: 'EMERGENCY' } }, { $count: 'count' }],
        normal: [{ $match: { requestMode: 'NORMAL' } }, { $count: 'count' }],
        overdue: [{ $match: { slaDeadline: { $lte: now } } }, { $count: 'count' }]
      }
    }
  ]).exec();

  return {
    all: result?.all[0]?.count ?? 0,
    emergency: result?.emergency[0]?.count ?? 0,
    normal: result?.normal[0]?.count ?? 0,
    overdue: result?.overdue[0]?.count ?? 0
  };
}

/** Đếm queue PENDING thiếu snapshot requestMode để cảnh báo migration chưa hoàn tất. */
export async function countPendingManualReviewQueuesMissingRequestMode(): Promise<number> {
  return ManualReviewQueueMongoModel.countDocuments({
    status: 'PENDING',
    requestMode: { $exists: false }
  }).exec();
}

/** Lấy các queue pending mới nhất để Socket polling bridge khôi phục missed event sau restart. */
export async function findPendingManualReviewQueues(
  limitCount: number = 200
): Promise<ManualReviewQueueRecord[]> {
  return ManualReviewQueueMongoModel.find({ status: 'PENDING' })
    .sort({ createdAt: -1 })
    .limit(Math.max(1, Math.min(500, Math.floor(limitCount))))
    .lean<ManualReviewQueueRecord[]>()
    .exec();
}

/** Lấy queue pending cùng project để ưu tiên project affinity khi phân công admin. */
export async function findPendingManualReviewQueuesByProject(
  projectId: string,
  assignedAdminIds?: string[]
): Promise<ManualReviewQueueRecord[]> {
  const assignedAdminFilter = assignedAdminIds && assignedAdminIds.length > 0
    ? { $in: assignedAdminIds }
    : { $ne: null };

  return ManualReviewQueueMongoModel.find({
    projectId,
    status: 'PENDING',
    assignedAdminId: assignedAdminFilter
  })
    .sort({ updatedAt: -1 })
    .limit(1)
    .lean<ManualReviewQueueRecord[]>()
    .exec();
}

/** Đếm workload pending theo danh sách admin để fallback cân bằng tải khi Redis không sẵn sàng. */
export async function countPendingManualReviewByAdminIds(
  adminIds: string[]
): Promise<Map<string, number>> {
  if (adminIds.length === 0) {
    return new Map();
  }

  const workloads = await ManualReviewQueueMongoModel.aggregate<{ _id: string; count: number }>([
    { $match: { status: 'PENDING', assignedAdminId: { $in: adminIds } } },
    { $group: { _id: '$assignedAdminId', count: { $sum: 1 } } }
  ]).exec();

  return new Map(workloads.map(item => [item._id, item.count]));
}

/** Lấy lease nguyên tử cho manual action để chỉ một admin resolve được queue item. */
export async function acquireManualReviewActionLease(input: {
  disbursementRequestId: string;
  lockId: string;
  leaseExpiresAt: Date;
  now: Date;
}): Promise<ManualReviewQueueRecord | null> {
  return ManualReviewQueueMongoModel.findOneAndUpdate(
    {
      disbursementRequestId: input.disbursementRequestId,
      status: 'PENDING',
      $or: [
        { actionLockId: null },
        { actionLockExpiresAt: null },
        { actionLockExpiresAt: { $lte: input.now } }
      ]
    },
    {
      $set: {
        actionLockId: input.lockId,
        actionLockExpiresAt: input.leaseExpiresAt,
        updatedAt: input.now
      }
    },
    { returnDocument: 'after' }
  ).lean<ManualReviewQueueRecord>().exec();
}

/** Gỡ lease khi action không thể hoàn tất để admin có thể thử lại sau lỗi hạ tầng. */
export async function releaseManualReviewActionLease(queueId: string, lockId: string): Promise<void> {
  await ManualReviewQueueMongoModel.updateOne(
    { queueId, actionLockId: lockId },
    {
      $set: {
        actionLockId: null,
        actionLockExpiresAt: null,
        updatedAt: new Date()
      }
    }
  ).exec();
}

/** Resolve queue item một lần và đặt retention date chỉ sau khi item đã kết thúc. */
export async function resolveManualReviewQueue(input: {
  queueId: string;
  lockId: string;
  status: Exclude<ManualReviewQueueStatus, 'PENDING'>;
  adminUserId: string;
  reason: string | null;
  resolvedAt: Date;
  session?: ClientSession;
}): Promise<ManualReviewQueueRecord | null> {
  return ManualReviewQueueMongoModel.findOneAndUpdate(
    {
      queueId: input.queueId,
      actionLockId: input.lockId,
      status: 'PENDING'
    },
    {
      $set: {
        status: input.status,
        resolvedAt: input.resolvedAt,
        resolvedByAdminId: input.adminUserId,
        resolutionReason: input.reason,
        actionLockId: null,
        actionLockExpiresAt: null,
        retentionExpiresAt: buildRetentionExpiresAt(input.resolvedAt),
        updatedAt: input.resolvedAt
      }
    },
    { returnDocument: 'after', ...(input.session ? { session: input.session } : {}) }
  ).lean<ManualReviewQueueRecord>().exec();
}

/** Tìm các queue đã quá SLA và chưa được escalate để worker xử lý idempotent. */
export async function findManualReviewEscalationCandidates(input: {
  now: Date;
  limit: number;
}): Promise<ManualReviewQueueRecord[]> {
  return ManualReviewQueueMongoModel.find({
    status: 'PENDING',
    slaDeadline: { $lte: input.now },
    escalatedAt: null
  })
    .sort({ slaDeadline: 1 })
    .limit(Math.max(1, Math.min(200, Math.floor(input.limit))))
    .lean<ManualReviewQueueRecord[]>()
    .exec();
}

/** Claim nguyên tử các queue quá SLA để nhiều worker không cùng gửi một escalation. */
export async function claimManualReviewEscalationCandidates(input: {
  now: Date;
  limit: number;
  claimId: string;
  claimExpiresAt: Date;
}): Promise<ManualReviewQueueRecord[]> {
  const candidates = await ManualReviewQueueMongoModel.find({
    status: 'PENDING',
    slaDeadline: { $lte: input.now },
    escalatedAt: null,
    $or: [
      { escalationClaimId: null },
      { escalationClaimExpiresAt: null },
      { escalationClaimExpiresAt: { $lte: input.now } }
    ]
  })
    .sort({ slaDeadline: 1 })
    .limit(Math.max(1, Math.min(200, Math.floor(input.limit))))
    .select({ queueId: 1 })
    .lean<{ queueId: string }[]>()
    .exec();

  const claimedItems = await Promise.all(candidates.map(candidate => (
    ManualReviewQueueMongoModel.findOneAndUpdate(
      {
        queueId: candidate.queueId,
        status: 'PENDING',
        escalatedAt: null,
        $or: [
          { escalationClaimId: null },
          { escalationClaimExpiresAt: null },
          { escalationClaimExpiresAt: { $lte: input.now } }
        ]
      },
      {
        $set: {
          escalationClaimId: input.claimId,
          escalationClaimExpiresAt: input.claimExpiresAt,
          updatedAt: input.now
        }
      },
      { returnDocument: 'after' }
    ).lean<ManualReviewQueueRecord>().exec()
  )));

  return claimedItems.filter((item): item is ManualReviewQueueRecord => item !== null);
}

/** Đánh dấu đã escalate trước khi gửi notification để restart/poll lặp không spam. */
export async function markManualReviewQueueEscalated(
  queueId: string,
  escalatedAt: Date,
  claimId?: string
): Promise<ManualReviewQueueRecord | null> {
  const filter: Record<string, unknown> = {
    queueId,
    status: 'PENDING',
    escalatedAt: null
  };
  if (claimId) {
    filter.escalationClaimId = claimId;
  }

  return ManualReviewQueueMongoModel.findOneAndUpdate(
    filter,
    {
      $set: {
        escalatedAt,
        updatedAt: escalatedAt,
        escalationClaimId: null,
        escalationClaimExpiresAt: null
      }
    },
    { returnDocument: 'after' }
  ).lean<ManualReviewQueueRecord>().exec();
}

/** Giải phóng claim khi notification lỗi để vòng escalation sau có thể retry. */
export async function releaseManualReviewEscalationClaim(
  queueId: string,
  claimId: string
): Promise<void> {
  await ManualReviewQueueMongoModel.updateOne(
    { queueId, status: 'PENDING', escalationClaimId: claimId },
    {
      $set: {
        escalationClaimId: null,
        escalationClaimExpiresAt: null,
        updatedAt: new Date()
      }
    }
  ).exec();
}
