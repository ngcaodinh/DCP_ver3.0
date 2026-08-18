/**
 * Dead Letter Queue model cho SBT mint requests thất bại.
 *
 * Mục đích: khi worker mint fail hết 7 attempt (1 attempt đầu + 6 retry theo backoff 5m→15m→60m→1h→4h→24h),
 * thay vì xóa job, hệ thống ghi log vào collection này để:
 * 1. Admin có thể xem danh sách job thất bại
 * 2. Admin trigger re-run job thông qua API (POST /api/sbt/retry-job/:mintRequestId)
 * 3. Audit trail cho compliance — biết được request nào fail, khi nào, lý do gì
 *
 * Quan trọng: KHÔNG BAO GIỜ cho phép mint tay. Re-run job vẫn phải qua worker code
 * để đảm bảo an toàn (Q4 decision — không cho admin mint tay).
 *
 * [N-B2] Duplicate key handling: khi tạo entry mà đã tồn tại, trả về bản ghi hiện có
 * thay vì null để caller có thể xử lý graceful (idempotent operation).
 */
import mongoose, { Schema, type ClientSession } from 'mongoose';

/**
 * Bản ghi DLQ (Dead Letter Queue) cho SBT mint request thất bại.
 *
 * Mục đích: khi worker mint fail hết 7 attempt (1 attempt đầu + 6 retry theo backoff 5m→15m→60m→1h→4h→24h),
 * thay vì xóa job, hệ thống ghi log vào collection này để:
 * 1. Admin có thể xem danh sách job thất bại
 * 2. Admin trigger re-run job thông qua API (POST /api/sbt/retry-job/:mintRequestId)
 * 3. Audit trail cho compliance — biết được request nào fail, khi nào, lý do gì
 *
 * Quan trọng: KHÔNG BAO GIỜ cho phép mint tay. Re-run job vẫn phải qua worker code
 * để đảm bảo an toàn (Q4 decision — không cho admin mint tay).
 */
export type SbtMintDlqRecord = {
  dlqId: string;                  // UUID bản ghi DLQ
  mintRequestId: string;          // Liên kết 1-1 với impact_sbt_metadata.mintRequestId
  sbtId: string;                  // Liên kết tới impact_sbt_metadata.sbtId
  projectId: string;
  organizationId: string;
  beneficiaryAddress: string;
  attemptNumber: number;          // Tổng số attempt đã thử khi vào DLQ (thường = 7)
  lastErrorMessage: string;       // Lỗi cuối cùng trước khi vào DLQ
  firstAttemptedAt: Date;         // Thời điểm attempt đầu tiên
  dlqAt: Date;                    // Thời điểm chuyển sang DLQ
  recoveredAt: Date | null;       // Thời điểm admin re-run job (set khi re-run thành công)
  recoveredBy: string | null;     // Admin userId đã re-run
  recoveryAttemptNumber: number;  // Số cycle admin đã bắt đầu từ DLQ, gồm cả cycle thất bại
  lastRecoveryError?: string | null; // Lỗi rerun gần nhất, không bị mất khi cycle thất bại
  lastRecoveryAt?: Date | null;       // Thời điểm admin bắt đầu hoặc cycle thất bại
  status: 'OPEN' | 'RECOVERED' | 'ABANDONED';
  createdAt: Date;
  updatedAt: Date;
};

/** Cursor opaque cho DLQ: sắp xếp tăng dần theo dlqAt rồi dùng dlqId làm tie-breaker ổn định. */
export type SbtMintDlqCursor = {
  dlqAt: string;
  dlqId: string;
};

const sbtMintDlqSchema = new Schema<SbtMintDlqRecord>(
  {
    dlqId: { type: String, required: true, unique: true },
    mintRequestId: { type: String, required: true, unique: true, index: true },
    sbtId: { type: String, required: true, index: true },
    projectId: { type: String, required: true, index: true },
    organizationId: { type: String, required: true, index: true },
    beneficiaryAddress: { type: String, required: true },
    attemptNumber: { type: Number, required: true, min: 1 },
    lastErrorMessage: { type: String, required: true },
    firstAttemptedAt: { type: Date, required: true },
    dlqAt: { type: Date, required: true, index: true },
    recoveredAt: { type: Date, default: null },
    recoveredBy: { type: String, default: null },
    recoveryAttemptNumber: { type: Number, required: true, default: 0 },
    lastRecoveryError: { type: String, default: null },
    lastRecoveryAt: { type: Date, default: null },
    status: {
      type: String,
      required: true,
      enum: ['OPEN', 'RECOVERED', 'ABANDONED'],
      default: 'OPEN',
      index: true
    }
  },
  { timestamps: true }
);

// Index phục vụ admin UI list: sort OPEN theo thời điểm DLQ tăng dần (cũ nhất trước)
sbtMintDlqSchema.index({ status: 1, dlqAt: 1 });
// Compound index phục vụ cursor pagination, tránh Mongo phải walk offset sâu.
sbtMintDlqSchema.index({ status: 1, dlqAt: 1, dlqId: 1 });
// Index phục vụ query theo project cho audit
sbtMintDlqSchema.index({ projectId: 1, status: 1 });

const SbtMintDlqMongoModel = mongoose.model<SbtMintDlqRecord>(
  'SbtMintDlq',
  sbtMintDlqSchema,
  'sbt_mint_dlq'
);

/**
 * Tạo bản ghi DLQ mới khi worker hết retry.
 * Mục đích: ghi nhận request thất bại, kèm context để admin debug.
 * Idempotent qua unique index trên mintRequestId — nếu đã tồn tại thì trả về bản ghi hiện có.
 */
export async function createSbtMintDlqEntry(
  data: Omit<SbtMintDlqRecord, 'createdAt' | 'updatedAt' | 'recoveredAt' | 'recoveredBy' | 'recoveryAttemptNumber' | 'status'>
): Promise<SbtMintDlqRecord | null> {
  try {
    const doc = await SbtMintDlqMongoModel.create({
      ...data,
      status: 'OPEN',
      recoveredAt: null,
      recoveredBy: null,
      recoveryAttemptNumber: 0,
      lastRecoveryError: null,
      lastRecoveryAt: null
    });
    return doc.toObject();
  } catch (error) {
    // Duplicate key → đã có DLQ entry từ trước, trả về bản ghi hiện có thay vì null
    if ((error as { code?: number })?.code === 11000) {
      const existing = await SbtMintDlqMongoModel.findOneAndUpdate(
        { mintRequestId: data.mintRequestId },
        {
          $set: {
            lastErrorMessage: data.lastErrorMessage,
            attemptNumber: data.attemptNumber,
            dlqAt: data.dlqAt,
            status: 'OPEN'
          },
          $setOnInsert: {
            lastRecoveryError: null,
            lastRecoveryAt: null
          }
        },
        { returnDocument: 'after' }
      ).lean().exec();
      return existing as SbtMintDlqRecord | null;
    }
    throw error;
  }
}

/**
 * Tìm DLQ entry theo mintRequestId.
 * Mục đích: kiểm tra đã từng fail trước đó chưa trước khi tạo mới.
 */
export async function findSbtMintDlqByMintRequestId(
  mintRequestId: string
): Promise<SbtMintDlqRecord | null> {
  return SbtMintDlqMongoModel.findOne({ mintRequestId }).lean().exec();
}

/**
 * Lấy danh sách DLQ theo trạng thái (mặc định OPEN) cho admin UI.
 * Mục đích: trang admin SBT Mint Retry (C7) hiển thị các job fail.
 */
export async function findSbtMintDlqByStatus(
  status: SbtMintDlqRecord['status'],
  limit = 20,
  skip = 0
): Promise<SbtMintDlqRecord[]> {
  return SbtMintDlqMongoModel.find({ status })
    .select({ _id: 0, __v: 0 })
    .sort({ dlqAt: 1 })
    .skip(skip)
    .limit(limit)
    .lean()
    .exec();
}

/** Encode cursor DLQ thành base64url để client không phụ thuộc schema Mongo nội bộ. */
export function encodeSbtMintDlqCursor(cursor: SbtMintDlqCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

/** Decode và kiểm tra cursor DLQ trước khi đưa vào query range. */
export function decodeSbtMintDlqCursor(value: string): SbtMintDlqCursor | null {
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<SbtMintDlqCursor>;
    if (
      typeof decoded.dlqAt !== 'string'
      || Number.isNaN(new Date(decoded.dlqAt).getTime())
      || typeof decoded.dlqId !== 'string'
      || decoded.dlqId.length === 0
      || decoded.dlqId.length > 128
    ) {
      return null;
    }
    return { dlqAt: new Date(decoded.dlqAt).toISOString(), dlqId: decoded.dlqId };
  } catch {
    return null;
  }
}

/** Lấy một batch DLQ theo cursor range và trả cursor kế tiếp nếu còn dữ liệu. */
export async function findSbtMintDlqByStatusCursor(
  status: SbtMintDlqRecord['status'],
  limit = 20,
  cursor?: string
): Promise<{ entries: SbtMintDlqRecord[]; nextCursor: string | null }> {
  const normalizedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const filter: Record<string, unknown> = { status };
  const decodedCursor = cursor ? decodeSbtMintDlqCursor(cursor) : null;
  if (cursor && !decodedCursor) {
    throw new Error('DLQ cursor không hợp lệ.');
  }
  if (decodedCursor) {
    const cursorDate = new Date(decodedCursor.dlqAt);
    filter.$or = [
      { dlqAt: { $gt: cursorDate } },
      { dlqAt: cursorDate, dlqId: { $gt: decodedCursor.dlqId } }
    ];
  }

  const rows = await SbtMintDlqMongoModel.find(filter)
    .select({ _id: 0, __v: 0 })
    .sort({ dlqAt: 1, dlqId: 1 })
    .limit(normalizedLimit + 1)
    .lean()
    .exec();
  const hasNextPage = rows.length > normalizedLimit;
  const entries = rows.slice(0, normalizedLimit) as SbtMintDlqRecord[];
  const lastEntry = entries[entries.length - 1];
  return {
    entries,
    nextCursor: hasNextPage && lastEntry
      ? encodeSbtMintDlqCursor({ dlqAt: lastEntry.dlqAt.toISOString(), dlqId: lastEntry.dlqId })
      : null
  };
}

/**
 * Đánh dấu DLQ entry là RECOVERED sau khi re-run thành công.
 * Mục đích: audit trail — biết admin nào đã recover job fail nào, khi nào.
 */
export async function markSbtMintDlqAsRecovered(
  mintRequestId: string,
  payload: { recoveredBy: string; recoveredAt: Date }
): Promise<SbtMintDlqRecord | null> {
  return SbtMintDlqMongoModel.findOneAndUpdate(
    { mintRequestId, status: 'OPEN' },
    {
      $set: {
        status: 'RECOVERED',
        recoveredAt: payload.recoveredAt,
        recoveredBy: payload.recoveredBy,
        lastRecoveryError: null
      }
    },
    { returnDocument: 'after' }
  ).lean().exec();
}

/** Ghi nhận admin đã bắt đầu một recovery cycle, tăng counter ngay cả khi cycle sau đó thất bại. */
export async function markSbtMintDlqRerunStarted(
  mintRequestId: string,
  payload: { startedAt: Date },
  session?: ClientSession
): Promise<SbtMintDlqRecord | null> {
  return SbtMintDlqMongoModel.findOneAndUpdate(
    { mintRequestId, status: 'OPEN' },
    {
      $set: { lastRecoveryAt: payload.startedAt, lastRecoveryError: null },
      $inc: { recoveryAttemptNumber: 1 }
    },
    { returnDocument: 'after', ...(session ? { session } : {}) }
  ).lean().exec();
}

/** Lưu lỗi của recovery cycle nhưng giữ DLQ OPEN để UI/operator thấy cần tiếp tục xử lý. */
export async function markSbtMintDlqRerunFailed(
  mintRequestId: string,
  payload: { failedAt: Date; errorMessage: string }
): Promise<SbtMintDlqRecord | null> {
  return SbtMintDlqMongoModel.findOneAndUpdate(
    { mintRequestId, status: 'OPEN' },
    { $set: { lastRecoveryAt: payload.failedAt, lastRecoveryError: payload.errorMessage } },
    { returnDocument: 'after' }
  ).lean().exec();
}

/**
 * Đánh dấu DLQ entry là ABANDONED khi admin quyết định không recover.
 * Mục đích: phân biệt job đang chờ xử lý vs job đã bỏ — phục vụ thống kê.
 */
export async function markSbtMintDlqAsAbandoned(
  mintRequestId: string,
  payload: { recoveredBy: string; recoveredAt: Date }
): Promise<SbtMintDlqRecord | null> {
  return SbtMintDlqMongoModel.findOneAndUpdate(
    { mintRequestId, status: 'OPEN' },
    {
      $set: {
        status: 'ABANDONED',
        recoveredAt: payload.recoveredAt,
        recoveredBy: payload.recoveredBy
      }
    },
    { returnDocument: 'after' }
  ).lean().exec();
}

/**
 * Đếm số DLQ entry theo trạng thái — cho badge UI và metrics.
 * Mục đích: dashboard hiển thị "X mint requests cần xử lý".
 */
export async function countSbtMintDlqByStatus(
  status: SbtMintDlqRecord['status']
): Promise<number> {
  return SbtMintDlqMongoModel.countDocuments({ status }).exec();
}
