import mongoose, { Schema } from 'mongoose';

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
  createdAt: Date;
  updatedAt: Date;
}

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

export const BeneficiaryFeedbackModel =
  mongoose.models.BeneficiaryFeedback ||
  mongoose.model<BeneficiaryFeedback>('BeneficiaryFeedback', beneficiaryFeedbackSchema);
