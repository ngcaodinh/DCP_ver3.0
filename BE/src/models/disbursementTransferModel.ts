import mongoose, { Schema } from 'mongoose';
import { getLogger } from '../config/logger';

/**
 * Trạng thái transfer trong log.
 * PROCESSING: đang xử lý
 * SUCCESS: chuyển khoản thành công
 * FAILED: chuyển khoản thất bại (sẽ retry hoặc chuyển manual review)
 * MANUAL_REVIEW: chuyển sang duyệt tay do retry thất bại
 */
export type DisbursementTransferLogStatus =
  | 'PROCESSING'
  | 'SUCCESS'
  | 'FAILED'
  | 'MANUAL_REVIEW';

/**
 * Bản ghi log chi tiết mỗi lần thử chuyển khoản PayOS.
 * Mỗi disbursement có thể có nhiều bản ghi (retry), mỗi bản ghi ghi nhận 1 attempt.
 */
export type DisbursementTransferLogRecord = {
  transferLogId: string;           // UUID log
  disbursementRequestId: string;    // requestId của disbursement
  attemptNumber: number;            // Số thứ tự attempt (bắt đầu từ 1)
  payosTransferId: string | null;   // Transfer ID từ PayOS
  providerTransactionId: string | null; // Transaction ID từ nhà cung cấp
  amount: number;                   // Số tiền chuyển (VNĐ)
  bankCode: string;                 // Mã ngân hàng
  bankAccountNumber: string;        // Số tài khoản (đã mask)
  accountHolderName: string;        // Tên chủ tài khoản (đã mask)
  status: DisbursementTransferLogStatus;
  errorMessage: string | null;      // Lỗi nếu thất bại
  responseData: Record<string, unknown> | null; // Raw response từ PayOS (đã sanitize)
  startedAt: Date;                  // Thời điểm bắt đầu attempt
  completedAt: Date | null;          // Thời điểm hoàn tất attempt
  durationMs: number | null;        // Thời gian xử lý (ms)
};

const logger = getLogger();

const disbursementTransferLogSchema = new Schema<DisbursementTransferLogRecord>({
  transferLogId: { type: String, required: true, unique: true },
  disbursementRequestId: { type: String, required: true, index: true },
  attemptNumber: { type: Number, required: true, min: 1 },
  payosTransferId: { type: String, default: null },
  providerTransactionId: { type: String, default: null },
  amount: { type: Number, required: true },
  bankCode: { type: String, required: true },
  bankAccountNumber: { type: String, required: true },
  accountHolderName: { type: String, required: true },
  status: {
    type: String,
    required: true,
    enum: ['PROCESSING', 'SUCCESS', 'FAILED', 'MANUAL_REVIEW'],
    index: true
  },
  errorMessage: { type: String, default: null },
  responseData: { type: Schema.Types.Mixed, default: null },
  startedAt: { type: Date, required: true },
  completedAt: { type: Date, default: null },
  durationMs: { type: Number, default: null }
});

// Index cho query nhanh theo disbursement request và trạng thái
disbursementTransferLogSchema.index({ disbursementRequestId: 1, attemptNumber: -1 });
disbursementTransferLogSchema.index({ disbursementRequestId: 1, status: 1 });

const DisbursementTransferLogModel = mongoose.model<DisbursementTransferLogRecord>(
  'DisbursementTransferLog',
  disbursementTransferLogSchema
);

// ============ CRUD FUNCTIONS ============

/** Chuẩn hóa payload cập nhật. Mục đích: tránh ghi trùng updatedAt gây xung đột MongoDB, và loại bỏ các trường không được phép thay đổi. */
function buildTransferLogUpdatePayload(
  payload: Partial<DisbursementTransferLogRecord>
): Partial<DisbursementTransferLogRecord> {
  // Loại bỏ các trường không được phép thay đổi qua update (chỉ set được khi tạo mới)
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { transferLogId, disbursementRequestId, ...rest } = payload;
  return rest;
}

/**
 * Tạo bản ghi log cho một attempt transfer.
 * Mục đích: ghi nhận mỗi lần thử chuyển khoản vào collection riêng để debug.
 */
export async function createTransferLog(
  record: DisbursementTransferLogRecord
): Promise<DisbursementTransferLogRecord> {
  try {
    const created = await DisbursementTransferLogModel.create(record);
    return created.toObject() as DisbursementTransferLogRecord;
  } catch (error) {
    logger.error('Không thể tạo disbursement transfer log.', {
      disbursementRequestId: record.disbursementRequestId,
      attemptNumber: record.attemptNumber,
      errorMessage: (error as Error)?.message
    });
    throw error;
  }
}

/**
 * Cập nhật bản ghi log theo transferLogId.
 * Mục đích: cập nhật trạng thái, lỗi, response sau mỗi attempt.
 */
export async function updateTransferLogById(
  transferLogId: string,
  payload: Partial<DisbursementTransferLogRecord>
): Promise<DisbursementTransferLogRecord | null> {
  const updated = await DisbursementTransferLogModel.findOneAndUpdate(
    { transferLogId },
    { $set: buildTransferLogUpdatePayload(payload) },
    { returnDocument: 'after' }
  ).exec();
  return updated ? (updated.toObject() as DisbursementTransferLogRecord) : null;
}

/**
 * Tìm bản ghi log theo disbursement requestId.
 * Mục đích: lấy lịch sử retry để hiển thị trên UI admin.
 */
export async function findTransferLogsByRequestId(
  disbursementRequestId: string
): Promise<DisbursementTransferLogRecord[]> {
  return DisbursementTransferLogModel.find({ disbursementRequestId })
    .sort({ attemptNumber: 1 })
    .lean<DisbursementTransferLogRecord[]>()
    .exec();
}

/**
 * Tìm bản ghi log cuối cùng (attempt mới nhất) theo disbursement requestId.
 * Mục đích: xác định retry count hiện tại.
 */
export async function findLatestTransferLogByRequestId(
  disbursementRequestId: string
): Promise<DisbursementTransferLogRecord | null> {
  const results = await DisbursementTransferLogModel.find({ disbursementRequestId })
    .sort({ attemptNumber: -1 })
    .limit(1)
    .lean<DisbursementTransferLogRecord[]>()
    .exec();
  return results.length > 0 ? results[0] : null;
}

/**
 * Đếm số lần retry hiện tại của một disbursement.
 * Mục đích: xác định xem đã đạt max retry hay chưa.
 */
export async function countTransferAttemptsByRequestId(
  disbursementRequestId: string
): Promise<number> {
  return DisbursementTransferLogModel.countDocuments({
    disbursementRequestId,
    status: { $in: ['PROCESSING', 'SUCCESS', 'FAILED'] }
  }).exec();
}

/**
 * Tìm các transfer đang ở trạng thái PROCESSING (bị stuck).
 * Mục đích: worker cron tìm các job bị stuck và retry.
 */
export async function findStuckProcessingTransfers(
  olderThanMinutes: number = 30
): Promise<DisbursementTransferLogRecord[]> {
  const cutoffTime = new Date(Date.now() - olderThanMinutes * 60 * 1000);
  return DisbursementTransferLogModel.find({
    status: 'PROCESSING',
    startedAt: { $lt: cutoffTime }
  })
    .sort({ startedAt: 1 })
    .lean<DisbursementTransferLogRecord[]>()
    .exec();
}
