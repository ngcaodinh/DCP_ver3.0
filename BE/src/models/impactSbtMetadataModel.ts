import { randomUUID } from 'crypto';
import mongoose, { Schema, type ClientSession } from 'mongoose';
import { ethers } from 'ethers';
import {
  SBT_HIDDEN_FROM_GALLERY_STATUSES,
  SBT_TOKEN_STATUS_NAMES,
  type SbtTokenStatusName
} from '../constants/sbtTokenStatus';

/**
 * Trạng thái vòng đời của một mint request.
 * PENDING   : record mới tạo, chưa submit tx
 * SUBMITTED : tx đã gửi lên blockchain, đang chờ confirm
 * CONFIRMED : tx đã được mine on-chain, token đã mint thành công
 * FAILED    : tx revert hoặc RPC lỗi — sẽ retry theo backoff
 * DLQ       : đã hết 7 attempt (1 attempt đầu + 6 retry) — chờ admin re-run job
 * BLOCKED   : mint bị chặn (chưa có donor address) — chờ implement C4
 */
export type ImpactSbtMintStatus = 'PENDING' | 'SUBMITTING' | 'SUBMITTED' | 'CONFIRMED' | 'FAILED' | 'DLQ' | 'BLOCKED';

/**
 * Bản ghi metadata cho mỗi SBT.
 * Mục đích: lưu trữ thông tin off-chain kèm theo tokenId on-chain để indexer/frontend query nhanh
 * mà không phải đọc IPFS mỗi lần.
 *
 * Mỗi lần Oracle verify thành công → tạo 1 record ở trạng thái PENDING → worker mint() on-chain
 * → update SUBMITTED/CONFIRMED. Khi fail hết 7 attempt → chuyển DLQ nhưng vẫn giữ record (không xóa).
 *
 * Lưu ý về 2-ID pattern:
 * - sbtId: UUID bản thân record metadata (dùng để query detail từ admin UI, định danh bản ghi độc lập)
 * - mintRequestId: UUID gắn với job queue (dùng làm idempotency key, liên kết với BullMQ job)
 * Cả 2 đều unique — mintRequestId đảm bảo không trùng job, sbtId đảm bảo không trùng record.
 *
 * Lý do tách 2 ID:
 * - mintRequestId gắn với job nên cần stable để BullMQ job tracking không bị confuse
 * - sbtId là record identifier độc lập, có thể tồn tại dù job chưa/t không chạy
 * - Khi re-run job, mintRequestId giữ nguyên nhưng sbtId vẫn là record đó
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
  attemptNumber: number;                  // Số attempt đã chạy (1..7, hoặc 0 nếu chưa chạy)
  lastErrorMessage: string | null;        // Lỗi của attempt gần nhất
  onChainTokenId: number | null;          // tokenId thật trên contract (set khi CONFIRMED)
  transactionHash: string | null;         // Tx hash gửi mint (set khi SUBMITTED)
  transactionNonce?: number | null;       // Nonce EOA đã reserve cho attempt hiện tại
  submissionLeaseOwner?: string | null;   // Worker lease owner khi đang SUBMITTING
  submissionLeaseExpiresAt?: Date | null; // Lease timeout để reconciler xử lý crash
  blockNumber: number | null;             // Block number confirm
  confirmedAt: Date | null;               // Thời điểm CONFIRMED
  onChainTokenStatus?: SbtTokenStatusName | null;
  tokenStatusReason?: string | null;
  tokenStatusUpdatedAt?: Date | null;
  tokenStatusUpdatedBy?: string | null;
  tokenStatusBlockNumber?: number | null;
  tokenStatusLogIndex?: number | null;
  tokenStatusTransactionHash?: string | null;
  submittedAt: Date | null;               // Thời điểm submit tx
  dlqAt: Date | null;                     // Thời điểm chuyển DLQ
  reRunCount: number;                     // Số lần admin đã trigger re-run job
  lastReRunBy: string | null;             // UserId admin gần nhất re-run
  lastReRunAt: Date | null;               // Thời điểm re-run gần nhất
  createdAt: Date;
  updatedAt: Date;
};

export interface ImpactSbtProjectQueryOptions {
  includeHidden?: boolean;
}

export interface EarliestConfirmedImpactSbtBackfillAnchor {
  blockNumber: number;
  confirmedAt: Date;
}

const impactSbtMetadataSchema = new Schema<ImpactSbtMetadataRecord>(
  {
    sbtId: { type: String, required: true, unique: true },
    mintRequestId: { type: String, required: true, unique: true, index: true },
    verificationId: { type: String, required: true, unique: true },
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
      enum: ['PENDING', 'SUBMITTING', 'SUBMITTED', 'CONFIRMED', 'FAILED', 'DLQ', 'BLOCKED'],
      default: 'PENDING',
      index: true
    },
    attemptNumber: { type: Number, required: true, default: 0, min: 0 },
    lastErrorMessage: { type: String, default: null },
    onChainTokenId: { type: Number, default: null },
    transactionHash: { type: String, default: null },
    transactionNonce: { type: Number, default: null, min: 0 },
    submissionLeaseOwner: { type: String, default: null, index: true },
    submissionLeaseExpiresAt: { type: Date, default: null, index: true },
    blockNumber: { type: Number, default: null },
    confirmedAt: { type: Date, default: null },
    onChainTokenStatus: {
      type: String,
      enum: [...SBT_TOKEN_STATUS_NAMES, null],
      default: null
    },
    tokenStatusReason: { type: String, default: null },
    tokenStatusUpdatedAt: { type: Date, default: null },
    tokenStatusUpdatedBy: { type: String, default: null },
    tokenStatusBlockNumber: { type: Number, default: null },
    tokenStatusLogIndex: { type: Number, default: null },
    tokenStatusTransactionHash: { type: String, default: null },
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
// Index phục vụ query theo project cho impact-gallery và đúng thứ tự sort confirmedAt.
impactSbtMetadataSchema.index({ projectId: 1, status: 1, confirmedAt: -1 });
// TokenId là định danh duy nhất trên chain; partial unique index vẫn cho phép nhiều record chưa mint có giá trị null.
impactSbtMetadataSchema.index(
  { onChainTokenId: 1 },
  { unique: true, partialFilterExpression: { onChainTokenId: { $type: 'number' } } }
);
// Tối ưu truy vấn findImpactSbtMetadataByBeneficiary — sắp xếp theo confirmedAt desc
impactSbtMetadataSchema.index({ beneficiaryAddress: 1, status: 1, confirmedAt: -1 });
// Index phục vụ gallery toàn cục, sắp xếp SBT đã confirm theo thời gian mới nhất.
impactSbtMetadataSchema.index({ status: 1, confirmedAt: -1 });
// Index phục vụ bootstrap projector tìm block mint CONFIRMED nhỏ nhất.
impactSbtMetadataSchema.index({ status: 1, blockNumber: 1 });

const ImpactSbtMetadataMongoModel = mongoose.model<ImpactSbtMetadataRecord>(
  'ImpactSbtMetadata',
  impactSbtMetadataSchema,
  'impact_sbt_metadata'
);

/** Dựng query gallery dùng chung để find và count luôn áp dụng cùng chính sách ẩn. */
function buildGallerySbtQuery(
  projectId?: string,
  options: ImpactSbtProjectQueryOptions = {}
): Record<string, unknown> {
  const query: Record<string, unknown> = {
    status: 'CONFIRMED'
  };
  // Chỉ undefined mới là gallery toàn cục; chuỗi rỗng phải là filter không khớp.
  if (projectId !== undefined) {
    query.projectId = projectId;
  }
  if (!options.includeHidden) {
    query.onChainTokenStatus = { $nin: SBT_HIDDEN_FROM_GALLERY_STATUSES };
  }
  return query;
}

/**
 * Tạo mới bản ghi metadata khi Oracle verified APPROVED.
 * Mục đích: idempotency — dùng findOneAndUpdate với upsert để tránh race window
 * (2 concurrent requests cùng verificationId có thể cùng check find trước khi create).
 *
 * [IMPORTANT #19 fix] Dùng upsert operation thay vì create() để đảm bảo atomic:
 * - Nếu verificationId chưa tồn tại → tạo mới
 * - Nếu verificationId đã tồn tại → trả về existing record
 * Không cần try-catch duplicate key nữa.
 */
export async function createImpactSbtMetadata(
  data: Omit<ImpactSbtMetadataRecord, 'createdAt' | 'updatedAt'>
): Promise<ImpactSbtMetadataRecord> {
  // Dùng upsert để atomic — không cần try-catch race condition nữa
  const doc = await ImpactSbtMetadataMongoModel.findOneAndUpdate(
    { verificationId: data.verificationId },
    { $setOnInsert: data },
    { upsert: true, returnDocument: 'after' }
  ).lean().exec();
  return doc as ImpactSbtMetadataRecord;
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
    transactionNonce: null,
    submissionLeaseOwner: null,
    submissionLeaseExpiresAt: null,
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
 * Lấy danh sách SBT public toàn cục hoặc theo project cho Impact NFT Gallery.
 * @param limit Số record tối đa cần lấy.
 * @param skip Số record bỏ qua để phân trang.
 * @param projectId Bộ lọc project tùy chọn.
 * @param options Chính sách visibility dành cho caller nội bộ.
 */
export async function findImpactSbtGallery(
  limit = 20,
  skip = 0,
  projectId?: string,
  options: ImpactSbtProjectQueryOptions = {}
): Promise<ImpactSbtMetadataRecord[]> {
  return ImpactSbtMetadataMongoModel.find(buildGallerySbtQuery(projectId, options))
    .select({
      onChainTokenId: 1,
      projectId: 1,
      milestone: 1,
      beneficiaryCount: 1,
      imageCid: 1,
      onChainTokenStatus: 1,
      confirmedAt: 1
    })
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
 * Đếm số SBT public toàn cục hoặc theo project để pagination khớp với gallery.
 * @param projectId Bộ lọc project tùy chọn.
 * @param options Chính sách visibility dành cho caller nội bộ.
 */
export async function countImpactSbtGallery(
  projectId?: string,
  options: ImpactSbtProjectQueryOptions = {}
): Promise<number> {
  return ImpactSbtMetadataMongoModel.countDocuments(buildGallerySbtQuery(projectId, options)).exec();
}

/** Lấy block mint cũ nhất để projector bắt đầu replay từ thời điểm có SBT cần hiển thị. */
export async function findEarliestConfirmedImpactSbtBlock(): Promise<number | null> {
  const record = await ImpactSbtMetadataMongoModel.findOne({
    status: 'CONFIRMED',
    blockNumber: { $gte: 0 }
  })
    .select({ blockNumber: 1 })
    .sort({ blockNumber: 1 })
    .lean()
    .exec();

  const blockNumber = record?.blockNumber;
  return typeof blockNumber === 'number' && Number.isSafeInteger(blockNumber) ? blockNumber : null;
}

/** Lấy block và thời điểm CONFIRMED sớm nhất để backfill nhận diện sentinel legacy mà không rewind checkpoint khỏe mạnh. */
export async function findEarliestConfirmedImpactSbtBackfillAnchor(): Promise<EarliestConfirmedImpactSbtBackfillAnchor | null> {
  const record = await ImpactSbtMetadataMongoModel.findOne({
    status: 'CONFIRMED',
    blockNumber: { $gte: 0 },
    confirmedAt: { $type: 'date' }
  })
    .select({ blockNumber: 1, confirmedAt: 1 })
    .sort({ blockNumber: 1 })
    .lean()
    .exec();

  const blockNumber = record?.blockNumber;
  const confirmedAt = record?.confirmedAt;
  if (
    typeof blockNumber !== 'number'
    || !Number.isSafeInteger(blockNumber)
    || !(confirmedAt instanceof Date)
    || Number.isNaN(confirmedAt.getTime())
  ) {
    return null;
  }

  return { blockNumber, confirmedAt };
}

/** Đồng bộ trạng thái on-chain vào metadata mà không làm thay đổi lifecycle mint off-chain. */
export async function updateImpactSbtOnChainStatus(
  onChainTokenId: number,
  payload: {
    onChainTokenStatus: SbtTokenStatusName;
    reason: string;
    updatedBy: string;
    updatedAt: Date;
    eventLocation?: {
      blockNumber: number;
      logIndex: number;
      transactionHash: string;
    };
  }
): Promise<ImpactSbtMetadataRecord | null> {
  const query: Record<string, unknown> = {
    onChainTokenId,
    status: 'CONFIRMED'
  };
  const statusUpdatePayload: Record<string, unknown> = {
    onChainTokenStatus: payload.onChainTokenStatus,
    tokenStatusReason: payload.reason,
    tokenStatusUpdatedAt: payload.updatedAt,
    tokenStatusUpdatedBy: payload.updatedBy
  };

  if (payload.eventLocation) {
    const { blockNumber, logIndex, transactionHash } = payload.eventLocation;
    // Chỉ event mới hơn được ghi để replay cũ không ghi đè canonical state hiện tại.
    query.$or = [
      { tokenStatusBlockNumber: { $exists: false } },
      { tokenStatusBlockNumber: null },
      { tokenStatusBlockNumber: { $lt: blockNumber } },
      { tokenStatusBlockNumber: blockNumber, tokenStatusLogIndex: { $exists: false } },
      { tokenStatusBlockNumber: blockNumber, tokenStatusLogIndex: null },
      { tokenStatusBlockNumber: blockNumber, tokenStatusLogIndex: { $lt: logIndex } }
    ];
    statusUpdatePayload.tokenStatusBlockNumber = blockNumber;
    statusUpdatePayload.tokenStatusLogIndex = logIndex;
    statusUpdatePayload.tokenStatusTransactionHash = transactionHash;
  }

  return ImpactSbtMetadataMongoModel.findOneAndUpdate(
    query,
    {
      $set: statusUpdatePayload
    },
    { returnDocument: 'after' }
  ).lean().exec();
}

/** Claim atomic một mint attempt trước khi gọi RPC, ngăn hai worker broadcast cùng mintRequestId. */
export async function claimImpactSbtForSubmission(
  mintRequestId: string,
  payload: { attemptNumber: number; leaseOwner: string; leaseExpiresAt: Date }
): Promise<ImpactSbtMetadataRecord | null> {
  return ImpactSbtMetadataMongoModel.findOneAndUpdate(
    {
      mintRequestId,
      $or: [
        { status: { $in: ['PENDING', 'FAILED'] } },
        { status: 'SUBMITTING', submissionLeaseExpiresAt: { $lte: new Date() } }
      ]
    },
    {
      $set: {
        status: 'SUBMITTING',
        attemptNumber: payload.attemptNumber,
        submissionLeaseOwner: payload.leaseOwner,
        submissionLeaseExpiresAt: payload.leaseExpiresAt,
        transactionHash: null,
        transactionNonce: null,
        submittedAt: null,
        lastErrorMessage: null
      }
    },
    { returnDocument: 'after' }
  ).lean().exec();
}

/** Ghi nonce đã reserve vào đúng lease trước khi broadcast để reconciler xử lý crash an toàn. */
export async function reserveImpactSbtSubmissionNonce(
  mintRequestId: string,
  leaseOwner: string,
  transactionNonce: number
): Promise<ImpactSbtMetadataRecord | null> {
  return ImpactSbtMetadataMongoModel.findOneAndUpdate(
    { mintRequestId, status: 'SUBMITTING', submissionLeaseOwner: leaseOwner },
    { $set: { transactionNonce } },
    { returnDocument: 'after' }
  ).lean().exec();
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
    transactionNonce: number;
    attemptNumber: number;
    submittedAt: Date;
    leaseOwner: string;
  }
): Promise<ImpactSbtMetadataRecord | null> {
  return ImpactSbtMetadataMongoModel.findOneAndUpdate(
    { mintRequestId, status: 'SUBMITTING', submissionLeaseOwner: payload.leaseOwner },
    {
      $set: {
        status: 'SUBMITTED',
        transactionHash: payload.transactionHash,
        transactionNonce: payload.transactionNonce,
        attemptNumber: payload.attemptNumber,
        submittedAt: payload.submittedAt,
        lastErrorMessage: null,
        submissionLeaseOwner: null,
        submissionLeaseExpiresAt: null
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
        lastErrorMessage: null,
        submissionLeaseOwner: null,
        submissionLeaseExpiresAt: null
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
    { mintRequestId, status: { $in: ['PENDING', 'SUBMITTING', 'SUBMITTED'] } },
    {
      $set: {
        status: 'FAILED',
        attemptNumber: payload.attemptNumber,
        lastErrorMessage: payload.errorMessage,
        submissionLeaseOwner: null,
        submissionLeaseExpiresAt: null
      }
    },
    { returnDocument: 'after' }
  ).lean().exec();
}

/** Giải phóng lease đã hết hạn trước broadcast khi chưa reserve nonce, bảo đảm recovery có thể thử lại an toàn. */
export async function releaseExpiredSbtSubmissionWithoutNonce(
  mintRequestId: string,
  errorMessage: string
): Promise<ImpactSbtMetadataRecord | null> {
  return ImpactSbtMetadataMongoModel.findOneAndUpdate(
    {
      mintRequestId,
      status: 'SUBMITTING',
      transactionHash: null,
      transactionNonce: null,
      submissionLeaseExpiresAt: { $lte: new Date() }
    },
    {
      $set: {
        status: 'PENDING',
        lastErrorMessage: errorMessage,
        submissionLeaseOwner: null,
        submissionLeaseExpiresAt: null
      }
    },
    { returnDocument: 'after' }
  ).lean().exec();
}

/**
 * Chuyển metadata sang DLQ sau khi hết 7 attempt.
 * Mục đích: đánh dấu cần admin xử lý. Không xóa record — giữ để audit.
 * Đây là trạng thái cuối cùng nếu không có re-run.
 */
export async function markImpactSbtAsDlq(
  mintRequestId: string,
  payload: { dlqAt: Date; errorMessage: string; attemptNumber: number }
): Promise<ImpactSbtMetadataRecord | null> {
  return ImpactSbtMetadataMongoModel.findOneAndUpdate(
    { mintRequestId, status: 'FAILED' },
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
  payload: { reRunBy: string; reRunAt: Date },
  session?: ClientSession
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
        transactionNonce: null,
        submittedAt: null,
        submissionLeaseOwner: null,
        submissionLeaseExpiresAt: null,
        lastReRunBy: payload.reRunBy,
        lastReRunAt: payload.reRunAt
      },
      $inc: { reRunCount: 1 }
    },
    { returnDocument: 'after', ...(session ? { session } : {}) }
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
    status: { $in: ['PENDING', 'SUBMITTING', 'SUBMITTED', 'FAILED'] },
    updatedAt: { $lt: cutoffTime }
  })
    .sort({ updatedAt: 1 })
    .limit(limit)
    .lean()
    .exec();
}

/** Đếm SBT CONFIRMED của project để sinh milestone canonical trong trigger Oracle. */
export async function countConfirmedImpactSbtByProjectId(projectId: string): Promise<number> {
  return ImpactSbtMetadataMongoModel.countDocuments({ projectId, status: 'CONFIRMED' }).exec();
}
