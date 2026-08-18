import mongoose, { Schema, type ClientSession } from 'mongoose';

/**
 * Interface cho bản ghi feedback của beneficiary.
 * Lưu trữ thông tin phản hồi từ beneficiary sau khi đã hash tên để bảo vệ PII.
 */
export interface BeneficiaryFeedback {
  /** ID duy nhất cho bản ghi feedback */
  feedbackId: string;
  /** ID của dự án liên quan */
  projectId: string;
  /** Tên beneficiary đã được hash bằng SHA-256 (không lưu PII thô) */
  beneficiaryNameHash: string;
  /** Điểm đánh giá từ 1-5 */
  rating: number;
  /** Nhận xét của beneficiary */
  comment: string;
  /** Thời điểm feedback được submit (từ CSV) */
  submittedAt: Date;
  /** Vị trí địa lý tùy chọn */
  location?: string;
  /** Điểm risk score từ spam detection (0-10) */
  riskScore: number;
  /** Đã bị flag là spam tiềm năng hay chưa */
  isFlagged: boolean;
  /** ID của NGO đã upload feedback này */
  uploadedByOrganizationId: string;
  /** Hash nội dung batch để phát hiện duplicate uploads (idempotency) */
  batchContentHash: string;
  /** Nguồn tạo feedback để phân biệt batch NGO và form công khai. */
  source: 'batch' | 'public';
  /** Băm IP có salt, chỉ dùng cho phân tích lạm dụng nội bộ. */
  submissionIpHash?: string;
  /** Thời điểm admin xoá mềm feedback; bản ghi sống không có field này. */
  deletedAt?: Date;
  /** Admin đã thực hiện xoá mềm feedback. */
  deletedByAdminId?: string;
  /** Lý do admin nhập khi xoá mềm feedback. */
  deleteReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Dữ liệu moderation được phép đi qua service, loại bỏ các hash nhận diện nội bộ. */
export type BeneficiaryFeedbackModerationView = Omit<
  BeneficiaryFeedback,
  'beneficiaryNameHash' | 'submissionIpHash'
>;

const beneficiaryFeedbackSchema = new Schema<BeneficiaryFeedback>(
  {
    feedbackId: {
      type: String,
      required: true,
      unique: true,
      index: true
    },
    projectId: {
      type: String,
      required: true,
      index: true
    },
    beneficiaryNameHash: {
      type: String,
      required: true,
      index: true
    },
    rating: {
      type: Number,
      required: true,
      min: 1,
      max: 5
    },
    comment: {
      type: String,
      required: true
    },
    submittedAt: {
      type: Date,
      required: true,
      index: true
    },
    location: {
      type: String,
      required: false
    },
    riskScore: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
      max: 10
    },
    isFlagged: {
      type: Boolean,
      required: true,
      default: false,
      index: true
    },
    uploadedByOrganizationId: {
      type: String,
      required: true,
      index: true
    },
    batchContentHash: {
      type: String,
      required: false,
      index: true
    },
    source: {
      type: String,
      enum: ['batch', 'public'],
      default: 'batch',
      index: true
    },
    submissionIpHash: {
      type: String,
      required: false
    },
    deletedAt: {
      type: Date,
      required: false
    },
    deletedByAdminId: {
      type: String,
      required: false
    },
    deleteReason: {
      type: String,
      required: false
    }
  },
  {
    timestamps: true,
    collection: 'beneficiary_feedback'
  }
);

// Compound index cho truy vấn theo project và thời gian
beneficiaryFeedbackSchema.index({ projectId: 1, submittedAt: -1 });
// Compound index cho danh sách feedback theo tenant, tránh quét collection khi phân trang.
beneficiaryFeedbackSchema.index({ uploadedByOrganizationId: 1, deletedAt: 1, submittedAt: -1, feedbackId: -1 });
// Compound index phủ aggregate thống kê theo tenant, trạng thái moderation và rating.
beneficiaryFeedbackSchema.index({ uploadedByOrganizationId: 1, deletedAt: 1, isFlagged: 1, rating: 1 });
// Index cho việc tìm kiếm feedback đã flagged
beneficiaryFeedbackSchema.index({ isFlagged: 1, riskScore: -1, submittedAt: -1 });
// Chỉ chứa bản ghi đã xoá mềm để worker purge quét theo cutoff hiệu quả.
beneficiaryFeedbackSchema.index({ deletedAt: 1 }, { sparse: true, background: true });

/**
 * Compound unique index cho idempotency check.
 * Đảm bảo không có 2 batch trùng lặp (cùng org + cùng content hash) được insert.
 * unique: true với sparse: false sẽ reject duplicate inserts ngay tại DB layer.
 */
beneficiaryFeedbackSchema.index(
  { uploadedByOrganizationId: 1, batchContentHash: 1 },
  { unique: true, background: true }
);

export const BeneficiaryFeedbackModel =
  mongoose.models.BeneficiaryFeedback ||
  mongoose.model<BeneficiaryFeedback>('BeneficiaryFeedback', beneficiaryFeedbackSchema);

/** Tìm feedback theo ID public để moderation service không truy cập model trực tiếp. */
export async function findBeneficiaryFeedbackById(
  feedbackId: string,
  session?: ClientSession
): Promise<BeneficiaryFeedbackModerationView | null> {
  const query = BeneficiaryFeedbackModel.findOne({ feedbackId, deletedAt: null })
    .select('-beneficiaryNameHash -submissionIpHash');
  if (session) query.session(session);
  return query.lean<BeneficiaryFeedbackModerationView>().exec();
}

/** Tìm feedback theo ID mà không loại bản ghi đã xoá để phân biệt 404 và conflict. */
export async function findBeneficiaryFeedbackByIdIncludingDeleted(
  feedbackId: string,
  session?: ClientSession
): Promise<BeneficiaryFeedbackModerationView | null> {
  const query = BeneficiaryFeedbackModel.findOne({ feedbackId })
    .select('-beneficiaryNameHash -submissionIpHash');
  if (session) query.session(session);
  return query.lean<BeneficiaryFeedbackModerationView>().exec();
}

/** Atomically đổi cờ moderation, chỉ một request thắng khi chạy đồng thời. */
export async function transitionBeneficiaryFeedbackFlag(
  feedbackId: string,
  currentValue: boolean,
  nextValue: boolean,
  session?: ClientSession
): Promise<BeneficiaryFeedbackModerationView | null> {
  const updated = await BeneficiaryFeedbackModel.findOneAndUpdate(
    { feedbackId, isFlagged: currentValue, deletedAt: null },
    { $set: { isFlagged: nextValue } },
    { returnDocument: 'after', ...(session ? { session } : {}) }
  ).select('-beneficiaryNameHash -submissionIpHash').exec();
  return updated ? updated.toObject() as BeneficiaryFeedbackModerationView : null;
}

/** Projection allowlist cho các màn hình admin feedback, tuyệt đối không phát hành PII nội bộ. */
const FLAGGED_FEEDBACK_PROJECTION = {
  _id: 0,
  feedbackId: 1,
  projectId: 1,
  rating: 1,
  comment: 1,
  submittedAt: 1,
  location: 1,
  riskScore: 1,
  isFlagged: 1,
  source: 1,
  createdAt: 1,
  updatedAt: 1,
  deletedAt: 1,
  deletedByAdminId: 1,
  deleteReason: 1
} as const;

export type BeneficiaryFeedbackFlaggedView = Pick<
  BeneficiaryFeedback,
  | 'feedbackId'
  | 'projectId'
  | 'rating'
  | 'comment'
  | 'submittedAt'
  | 'location'
  | 'riskScore'
  | 'isFlagged'
  | 'source'
  | 'createdAt'
  | 'updatedAt'
  | 'deletedAt'
  | 'deletedByAdminId'
  | 'deleteReason'
>;

export interface FlaggedFeedbackQuery {
  deletionState: 'active' | 'deleted';
  projectId?: string;
  minRiskScore?: number;
  source?: 'batch' | 'public';
  skip: number;
  limit: number;
}

/** Dựng predicate và sort tập trung ở model để query luôn khớp với index retention. */
function buildFlaggedFeedbackQuery(query: FlaggedFeedbackQuery): {
  filter: Record<string, unknown>;
  sort: Record<string, 1 | -1>;
} {
  const filter: Record<string, unknown> = query.deletionState === 'active'
    ? { isFlagged: true, deletedAt: null }
    : { deletedAt: { $gt: new Date(0) } };
  if (query.projectId) filter.projectId = query.projectId;
  if (query.minRiskScore !== undefined) filter.riskScore = { $gte: query.minRiskScore };
  if (query.source) filter.source = query.source;

  return {
    filter,
    sort: query.deletionState === 'active'
      ? { riskScore: -1, submittedAt: -1 }
      : { deletedAt: 1 }
  };
}

/** Lấy một trang feedback đã flag hoặc đã xoá theo projection allowlist. */
export async function listFlaggedBeneficiaryFeedback(
  query: FlaggedFeedbackQuery
): Promise<BeneficiaryFeedbackFlaggedView[]> {
  const { filter, sort } = buildFlaggedFeedbackQuery(query);
  return BeneficiaryFeedbackModel.find(filter)
    .select(FLAGGED_FEEDBACK_PROJECTION)
    .sort(sort)
    .skip(query.skip)
    .limit(query.limit)
    .lean<BeneficiaryFeedbackFlaggedView[]>()
    .exec();
}

/** Đếm feedback theo cùng predicate với truy vấn phân trang admin. */
export async function countFlaggedBeneficiaryFeedback(
  query: FlaggedFeedbackQuery
): Promise<number> {
  const { filter } = buildFlaggedFeedbackQuery(query);
  return BeneficiaryFeedbackModel.countDocuments(filter).exec();
}

/** Đếm beneficiary distinct theo project từ feedback active, dùng làm fallback authoritative cho mint metadata. */
export async function countBeneficiariesByProjectId(projectId: string): Promise<number> {
  const distinctBeneficiaryHashes = await BeneficiaryFeedbackModel.distinct(
    'beneficiaryNameHash',
    { projectId, deletedAt: null }
  ).exec();
  return distinctBeneficiaryHashes.length;
}

/** Lấy các field tối thiểu để worker purge không đọc comment hoặc dữ liệu nhận diện. */
export async function findSoftDeletedFeedbackForPurge(
  cutoff: Date,
  limit: number
): Promise<Array<Pick<BeneficiaryFeedback, 'feedbackId' | 'projectId' | 'deletedAt'>>> {
  return BeneficiaryFeedbackModel.find({ deletedAt: { $lte: cutoff } })
    .select({ _id: 0, feedbackId: 1, projectId: 1, deletedAt: 1 })
    .sort({ deletedAt: 1, feedbackId: 1 })
    .limit(limit)
    .lean<Array<Pick<BeneficiaryFeedback, 'feedbackId' | 'projectId' | 'deletedAt'>>>()
    .exec();
}

/** Đọc feedback đang sống để xoá mềm theo expected state, tránh ghi đè cạnh tranh. */
export async function softDeleteBeneficiaryFeedbackById(
  feedbackId: string,
  deletedAt: Date,
  deletedByAdminId: string,
  deleteReason: string,
  session?: ClientSession
): Promise<BeneficiaryFeedbackModerationView | null> {
  const updated = await BeneficiaryFeedbackModel.findOneAndUpdate(
    { feedbackId, isFlagged: true, deletedAt: null },
    { $set: { deletedAt, deletedByAdminId, deleteReason } },
    { returnDocument: 'after', ...(session ? { session } : {}) }
  ).select('-beneficiaryNameHash -submissionIpHash').exec();
  return updated ? updated.toObject() as BeneficiaryFeedbackModerationView : null;
}

/** Khôi phục feedback đã xoá mềm và chỉ gỡ các field của trạng thái xoá. */
export async function restoreBeneficiaryFeedbackById(
  feedbackId: string,
  session?: ClientSession
): Promise<BeneficiaryFeedbackModerationView | null> {
  const updated = await BeneficiaryFeedbackModel.findOneAndUpdate(
    { feedbackId, isFlagged: true, deletedAt: { $ne: null } },
    { $unset: { deletedAt: 1, deletedByAdminId: 1, deleteReason: 1 } },
    { returnDocument: 'after', ...(session ? { session } : {}) }
  ).select('-beneficiaryNameHash -submissionIpHash').exec();
  return updated ? updated.toObject() as BeneficiaryFeedbackModerationView : null;
}

/** Xoá cứng theo lô nhưng luôn kiểm tra lại cutoff để bảo vệ cuộc đua với restore. */
export async function hardDeleteBeneficiaryFeedbackByIds(
  feedbackIds: string[],
  cutoff: Date
): Promise<number> {
  if (!feedbackIds.length) return 0;
  const result = await BeneficiaryFeedbackModel.deleteMany({
    feedbackId: { $in: feedbackIds },
    deletedAt: { $lte: cutoff }
  }).exec();
  return result.deletedCount;
}
