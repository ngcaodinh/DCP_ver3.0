import { randomUUID } from 'crypto';
import mongoose, { Schema } from 'mongoose';
import { ethers } from 'ethers';

/**
 * Trạng thái vòng đời của một mint request.
 * PENDING   : record mới tạo, chưa submit tx
 * SUBMITTED : tx đã gửi lên blockchain, đang chờ confirm
 * CONFIRMED : tx đã được mine on-chain, token đã mint thành công
 * FAILED    : tx revert hoặc RPC lỗi — sẽ retry theo backoff
 * DLQ       : đã hết retry (6 lần) — chờ admin re-run job
 * BLOCKED   : mint bị chặn (chưa có donor address) — chờ implement C4
 */
export type ImpactSbtMintStatus = 'PENDING' | 'SUBMITTED' | 'CONFIRMED' | 'FAILED' | 'DLQ' | 'BLOCKED';

/**
 * Bản ghi metadata cho mỗi SBT.
 * Mục đích: lưu trữ thông tin off-chain kèm theo tokenId on-chain để indexer/frontend query nhanh
 * mà không phải đọc IPFS mỗi lần.
 *
 * Mỗi lần Oracle verify thành công → tạo 1 record ở trạng thái PENDING → worker mint() on-chain
 * → update SUBMITTED/CONFIRMED. Khi fail hết 6 retry → chuyển DLQ nhưng vẫn giữ record (không xóa).
 */
export type ImpactSbtMetadataRecord = {
  sbtId: string;                          // UUID record
  mintRequestId: string;                  // UUID request — dùng làm khóa idempotency cho job queue
  verificationId: string;                 // Liên kết tới oracle_verification_results
  projectId: string;
  organizationId: string;
  beneficiaryAddress: string;             // Địa chỉ ví nhận SBT (lowercase để chuẩn hóa)
  projectIdNumeric: number;               // on-chain projectId (uint256)
  milestone: number;                      // Bước tiến dự án tại thời điểm mint
  beneficiaryCount: number;               // Số người thụ hưởng
  gpsCoordinates: string;                 // Tọa độ GPS (chuỗi "lat,lng" hoặc rỗng nếu thiếu EXIF)
  imageCid: string;                       // IPFS CID ảnh minh chứng
  tokenUri: string;                       // URI metadata IPFS đầy đủ (ipfs://...)
  status: ImpactSbtMintStatus;
  attemptNumber: number;                  // Số lần đã thử (1..6, hoặc 0 nếu chưa chạy)
  lastErrorMessage: string | null;        // Lỗi của attempt gần nhất
  onChainTokenId: number | null;          // tokenId thật trên contract (set khi CONFIRMED)
  transactionHash: string | null;         // Tx hash gửi mint (set khi SUBMITTED)
  blockNumber: number | null;             // Block number confirm
  confirmedAt: Date | null;               // Thời điểm CONFIRMED
  submittedAt: Date | null;               // Thời điểm submit tx
  dlqAt: Date | null;                     // Thời điểm chuyển DLQ
  reRunCount: number;                     // Số lần admin đã trigger re-run job
  lastReRunBy: string | null;             // UserId admin gần nhất re-run
  lastReRunAt: Date | null;               // Thời điểm re-run gần nhất
  createdAt: Date;
  updatedAt: Date;
};

const impactSbtMetadataSchema = new Schema<ImpactSbtMetadataRecord>(
  {
    sbtId: { type: String, required: true, unique: true },
    mintRequestId: { type: String, required: true, unique: true, index: true },
    verificationId: { type: String, required: true, index: true },
    projectId: { type: String, required: true, index: true },
    organizationId: { type: String, required: true, index: true },
    beneficiaryAddress: { type: String, required: true, index: true },
    projectIdNumeric: { type: Number, required: true },
    milestone: { type: Number, required: true, default: 0 },
    beneficiaryCount: { type: Number, required: true, default: 0 },
    gpsCoordinates: { type: String, required: true, default: '' },
    imageCid: { type: String, required: true },
    tokenUri: { type: String, required: true },
    status: {
      type: String,
      required: true,
      enum: ['PENDING', 'SUBMITTED', 'CONFIRMED', 'FAILED', 'DLQ', 'BLOCKED'],
      default: 'PENDING',
      index: true
    },
    attemptNumber: { type: Number, required: true, default: 0, min: 0 },
    lastErrorMessage: { type: String, default: null },
    onChainTokenId: { type: Number, default: null },
    transactionHash: { type: String, default: null },
    blockNumber: { type: Number, default: null },
    confirmedAt: { type: Date, default: null },
    submittedAt: { type: Date, default: null },
    dlqAt: { type: Date, default: null },
    reRunCount: { type: Number, required: true, default: 0 },
    lastReRunBy: { type: String, default: null },
    lastReRunAt: { type: Date, default: null }
  },
  { timestamps: true }
);

// Index phục vụ cron job 15 phút: tìm PENDING + SUBMITTED lâu chưa confirm
impactSbtMetadataSchema.index({ status: 1, updatedAt: 1 });
// Index phục vụ admin UI DLQ: sort theo thời điểm DLQ
impactSbtMetadataSchema.index({ status: 1, dlqAt: -1 });
// Index phục vụ query theo project cho impact-gallery
impactSbtMetadataSchema.index({ projectId: 1, status: 1, createdAt: -1 });
// Tối ưu truy vấn findImpactSbtMetadataByBeneficiary — sắp xếp theo confirmedAt desc
impactSbtMetadataSchema.index({ beneficiaryAddress: 1, status: 1, confirmedAt: -1 });

const ImpactSbtMetadataMongoModel = mongoose.model<ImpactSbtMetadataRecord>(
  'ImpactSbtMetadata',
  impactSbtMetadataSchema,
  'impact_sbt_metadata'
);

/**
 * Tạo mới bản ghi metadata khi Oracle verified APPROVED.
 * Mục đích: idempotency — nếu mintRequestId đã tồn tại, throw error để caller xử lý.
 * Throw giúp phát hiện duplicate event từ oracle.verified.
 */
export async function createImpactSbtMetadata(
  data: Omit<ImpactSbtMetadataRecord, 'createdAt' | 'updatedAt'>
): Promise<ImpactSbtMetadataRecord> {
  const doc = await ImpactSbtMetadataMongoModel.create(data);
  return doc.toObject();
}

/**
 * Tạo bản ghi metadata với trạng thái BLOCKED (mint bị chặn do không có donor address).
 * Mục đích: ghi nhận sự kiện blocked để audit và alert admin.
 * Sau khi implement C4 (lookup donor wallet), record này có thể được re-run.
 */
export async function createBlockedImpactSbtMetadata(
  verificationId: string,
  projectId: string,
  organizationId: string
): Promise<ImpactSbtMetadataRecord> {
  const mintRequestId = `SBT-MINT-${randomUUID()}`;
  const sbtId = `SBT-${randomUUID()}`;

  const doc = await ImpactSbtMetadataMongoModel.create({
    sbtId,
    mintRequestId,
    verificationId,
    projectId,
    organizationId,
    beneficiaryAddress: ethers.ZeroAddress,
    projectIdNumeric: 0,
    milestone: 0,
    beneficiaryCount: 0,
    gpsCoordinates: '',
    imageCid: '',
    tokenUri: '',
    status: 'BLOCKED',
    attemptNumber: 0,
    lastErrorMessage: 'NO_DONOR_ADDRESS: chưa có donor address từ oracle.verified event',
    onChainTokenId: null,
    transactionHash: null,
    blockNumber: null,
    confirmedAt: null,
    submittedAt: null,
    dlqAt: null,
    reRunCount: 0,
    lastReRunBy: null,
    lastReRunAt: null
  });
  return doc.toObject();
}

/**
 * Tìm bản ghi theo mintRequestId — dùng cho idempotency check trước khi enqueue job.
 * Mục đích: tránh trùng job khi oracle.verified event bị emit 2 lần.
 */
export async function findImpactSbtMetadataByMintRequestId(
  mintRequestId: string
): Promise<ImpactSbtMetadataRecord | null> {
  return ImpactSbtMetadataMongoModel.findOne({ mintRequestId }).lean().exec();
}

/**
 * Tìm bản ghi theo sbtId — dùng cho admin retry endpoint.
 * Mục đích: admin truy vấn trạng thái chi tiết trước khi re-run.
 */
export async function findImpactSbtMetadataBySbtId(
  sbtId: string
): Promise<ImpactSbtMetadataRecord | null> {
  return ImpactSbtMetadataMongoModel.findOne({ sbtId }).lean().exec();
}

/**
 * Tìm bản ghi theo verificationId — dùng để check duplicate trong worker trước khi mint.
 * Mục đích: tránh double-mint khi cùng verification được process bởi nhiều job.
 */
export async function findImpactSbtMetadataByVerificationId(
  verificationId: string
): Promise<ImpactSbtMetadataRecord | null> {
  return ImpactSbtMetadataMongoModel.findOne({ verificationId }).lean().exec();
}

/**
 * Tìm bản ghi theo on-chain tokenId (sau khi CONFIRMED).
 * Mục đích: phục vụ API metadata detail ở task C4.
 */
export async function findImpactSbtMetadataByTokenId(
  onChainTokenId: number
): Promise<ImpactSbtMetadataRecord | null> {
  return ImpactSbtMetadataMongoModel.findOne({ onChainTokenId }).lean().exec();
}

/**
 * Lấy danh sách SBT theo project (phân trang) — cho API list.
 * Mục đích: trang Impact NFT Gallery fetch theo projectId.
 */
export async function findImpactSbtMetadataByProjectId(
  projectId: string,
  limit = 20,
  skip = 0
): Promise<ImpactSbtMetadataRecord[]> {
  return ImpactSbtMetadataMongoModel.find({ projectId, status: 'CONFIRMED' })
    .sort({ confirmedAt: -1 })
    .skip(skip)
    .limit(limit)
    .lean()
    .exec();
}

/**
 * Lấy tất cả SBT của một beneficiary (phân trang).
 * Mục đích: trang profile donor xem NFT đã nhận.
 */
export async function findImpactSbtMetadataByBeneficiary(
  beneficiaryAddress: string,
  limit = 20,
  skip = 0
): Promise<ImpactSbtMetadataRecord[]> {
  return ImpactSbtMetadataMongoModel.find({ beneficiaryAddress, status: 'CONFIRMED' })
    .sort({ confirmedAt: -1 })
    .skip(skip)
    .limit(limit)
    .lean()
    .exec();
}

/**
 * Đếm số SBT CONFIRMED của một project.
 * Mục đích: hiển thị badge "X certificates" trên project page.
 */
export async function countImpactSbtByProjectId(projectId: string): Promise<number> {
  return ImpactSbtMetadataMongoModel.countDocuments({ projectId, status: 'CONFIRMED' }).exec();
}

/**
 * Lấy danh sách SBT theo trạng thái (PENDING/SUBMITTED/FAILED/DLQ) cho admin/debug.
 * Mục đích: admin UI xem pending mint hoặc stuck transactions.
 */
export async function findImpactSbtMetadataByStatus(
  status: ImpactSbtMintStatus,
  limit = 20,
  skip = 0
): Promise<ImpactSbtMetadataRecord[]> {
  return ImpactSbtMetadataMongoModel.find({ status })
    .sort({ updatedAt: -1 })
    .skip(skip)
    .limit(limit)
    .lean()
    .exec();
}

/**
 * Cập nhật metadata khi worker submit tx thành công.
 * Mục đích: chuyển PENDING → SUBMITTED, lưu txHash + attempt number.
 * Chỉ update khi status hiện tại phù hợp (tránh race với re-run job).
 */
export async function markImpactSbtAsSubmitted(
  mintRequestId: string,
  payload: {
    transactionHash: string;
    attemptNumber: number;
    submittedAt: Date;
  }
): Promise<ImpactSbtMetadataRecord | null> {
  return ImpactSbtMetadataMongoModel.findOneAndUpdate(
    { mintRequestId, status: { $in: ['PENDING', 'FAILED'] } },
    {
      $set: {
        status: 'SUBMITTED',
        transactionHash: payload.transactionHash,
        attemptNumber: payload.attemptNumber,
        submittedAt: payload.submittedAt,
        lastErrorMessage: null
      }
    },
    { returnDocument: 'after' }
  ).lean().exec();
}

/**
 * Cập nhật metadata khi tx được confirm on-chain.
 * Mục đích: lưu onChainTokenId + blockNumber. Chuyển SUBMITTED → CONFIRMED.
 * Đây là trạng thái cuối cùng — không thể revert.
 */
export async function markImpactSbtAsConfirmed(
  mintRequestId: string,
  payload: {
    onChainTokenId: number;
    blockNumber: number;
    confirmedAt: Date;
  }
): Promise<ImpactSbtMetadataRecord | null> {
  return ImpactSbtMetadataMongoModel.findOneAndUpdate(
    { mintRequestId, status: 'SUBMITTED' },
    {
      $set: {
        status: 'CONFIRMED',
        onChainTokenId: payload.onChainTokenId,
        blockNumber: payload.blockNumber,
        confirmedAt: payload.confirmedAt,
        lastErrorMessage: null
      }
    },
    { returnDocument: 'after' }
  ).lean().exec();
}

/**
 * Cập nhật metadata khi worker gặp lỗi transient (sẽ retry).
 * Mục đích: lưu attemptNumber + lastErrorMessage. Status = FAILED để cron/recovery biết.
 * Khác với DLQ — FAILED vẫn có job retry đang chờ trong queue.
 */
export async function markImpactSbtAsFailed(
  mintRequestId: string,
  payload: {
    attemptNumber: number;
    errorMessage: string;
  }
): Promise<ImpactSbtMetadataRecord | null> {
  return ImpactSbtMetadataMongoModel.findOneAndUpdate(
    { mintRequestId, status: { $in: ['PENDING', 'SUBMITTED', 'FAILED'] } },
    {
      $set: {
        status: 'FAILED',
        attemptNumber: payload.attemptNumber,
        lastErrorMessage: payload.errorMessage
      }
    },
    { returnDocument: 'after' }
  ).lean().exec();
}

/**
 * Chuyển metadata sang DLQ sau khi hết 6 retry.
 * Mục đích: đánh dấu cần admin xử lý. Không xóa record — giữ để audit.
 * Đây là trạng thái cuối cùng nếu không có re-run.
 */
export async function markImpactSbtAsDlq(
  mintRequestId: string,
  payload: { dlqAt: Date; errorMessage: string; attemptNumber: number }
): Promise<ImpactSbtMetadataRecord | null> {
  return ImpactSbtMetadataMongoModel.findOneAndUpdate(
    { mintRequestId, status: { $ne: 'CONFIRMED' } },
    {
      $set: {
        status: 'DLQ',
        dlqAt: payload.dlqAt,
        lastErrorMessage: payload.errorMessage,
        attemptNumber: payload.attemptNumber
      }
    },
    { returnDocument: 'after' }
  ).lean().exec();
}

/**
 * Reset metadata khi admin trigger re-run job.
 * Mục đích: chuyển DLQ/FAILED → PENDING, reset attemptNumber = 0.
 * Ghi nhận reRunCount + adminUserId để audit trail.
 */
export async function resetImpactSbtForReRun(
  mintRequestId: string,
  payload: { reRunBy: string; reRunAt: Date }
): Promise<ImpactSbtMetadataRecord | null> {
  return ImpactSbtMetadataMongoModel.findOneAndUpdate(
    { mintRequestId, status: { $in: ['DLQ', 'FAILED'] } },
    {
      $set: {
        status: 'PENDING',
        attemptNumber: 0,
        lastErrorMessage: null,
        dlqAt: null,
        transactionHash: null,
        submittedAt: null,
        lastReRunBy: payload.reRunBy,
        lastReRunAt: payload.reRunAt
      },
      $inc: { reRunCount: 1 }
    },
    { returnDocument: 'after' }
  ).lean().exec();
}

/**
 * Lấy danh sách record cần recovery bởi cron 15 phút.
 * Mục đích: tìm các job SUBMITTED quá lâu chưa confirm (tx stuck) hoặc
 * PENDING/FAILED lâu chưa có job retry (queue bị stuck). Cron sẽ enqueue lại.
 * Lưu ý: KHÔNG include BLOCKED status vì record này cần C4 implement trước,
 * không nên tự động re-enqueue.
 */
export async function findImpactSbtNeedingRecovery(
  olderThanMinutes: number,
  limit = 50
): Promise<ImpactSbtMetadataRecord[]> {
  const cutoffTime = new Date(Date.now() - olderThanMinutes * 60 * 1000);
  return ImpactSbtMetadataMongoModel.find({
    status: { $in: ['PENDING', 'SUBMITTED', 'FAILED'] },
    updatedAt: { $lt: cutoffTime }
  })
    .sort({ updatedAt: 1 })
    .limit(limit)
    .lean()
    .exec();
}
