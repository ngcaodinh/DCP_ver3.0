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
    }
  },
  {
    timestamps: true,
    collection: 'beneficiary_feedback'
  }
);

// Compound index cho truy vấn theo project và thời gian
beneficiaryFeedbackSchema.index({ projectId: 1, submittedAt: -1 });
// Index cho việc tìm kiếm feedback đã flagged
beneficiaryFeedbackSchema.index({ isFlagged: 1, riskScore: -1 });

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
    { feedbackId, isFlagged: currentValue },
    { $set: { isFlagged: nextValue } },
    { returnDocument: 'after', ...(session ? { session } : {}) }
  ).select('-beneficiaryNameHash -submissionIpHash').exec();
  return updated ? updated.toObject() as BeneficiaryFeedbackModerationView : null;
}
