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
  /** Lý do flag (từ spam detection hoặc admin) */
  flagReason?: string;
  /** Thời điểm được flag */
  flaggedAt?: Date;
  /** User ID của admin đã flag (cho admin actions) */
  flaggedBy?: string;
  /** Lịch sử các hành động flag/unflag */
  flagHistory?: FlagHistoryEntry[];
  /** ID của NGO đã upload feedback này */
  uploadedByOrganizationId: string;
  /** Hash nội dung batch để phát hiện duplicate uploads (idempotency) */
  batchContentHash: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Bản ghi lịch sử hành động flag/unflag.
 */
export interface FlagHistoryEntry {
  /** Hành động thực hiện */
  action: 'flagged' | 'unflagged';
  /** Lý do hành động */
  reason: string;
  /** User ID của admin thực hiện */
  performedBy: string;
  /** Thời điểm thực hiện */
  performedAt: Date;
  /** Trạng thái flagged trước khi thực hiện hành động */
  previousFlaggedState: boolean;
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
    flagReason: {
      type: String,
      required: false
    },
    flaggedAt: {
      type: Date,
      required: false
    },
    flaggedBy: {
      type: String,
      required: false
    },
    flagHistory: [{
      action: {
        type: String,
        enum: ['flagged', 'unflagged'],
        required: true
      },
      reason: {
        type: String,
        required: true
      },
      performedBy: {
        type: String,
        required: true
      },
      performedAt: {
        type: Date,
        required: true,
        default: Date.now
      },
      previousFlaggedState: {
        type: Boolean,
        required: true
      }
    }],
    uploadedByOrganizationId: {
      type: String,
      required: true,
      index: true
    },
    batchContentHash: {
      type: String,
      required: false,
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
// Compound index hỗ trợ sort theo flaggedAt + createdAt trong admin listing.
// Tránh in-memory sort khi admin sort theo thời điểm flag gần nhất.
beneficiaryFeedbackSchema.index({ isFlagged: 1, flaggedAt: -1, createdAt: -1 });

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
