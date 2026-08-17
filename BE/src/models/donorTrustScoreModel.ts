import mongoose, { Schema } from 'mongoose';
import type { DonorTrustScoreRecord, TrustFactorBreakdown } from '../types/trust-score.types';

/**
 * Schema con cho factorBreakdown — lưu chi tiết điểm thô từng factor.
 * Mục đích: tái sử dụng trong Mongoose schema chính và đảm bảo type-safe khi query.
 */
const trustFactorBreakdownSchema = new Schema<TrustFactorBreakdown>(
  {
    kycScore: { type: Number, required: true, min: 0, max: 1 },
    donationHistoryScore: { type: Number, required: true, min: 0, max: 1 },
    donationCount: { type: Number, required: true, min: 0 },
    socialVerificationScore: { type: Number, required: true, min: 0, max: 1 },
    isSocialVerified: { type: Boolean, required: true },
    accountAgeScore: { type: Number, required: true, min: 0, max: 1 },
    accountAgeDays: { type: Number, required: true, min: 0 },
    deviceBindingScore: { type: Number, required: true, min: 0, max: 1 },
    isDeviceBound: { type: Boolean, required: true }
  },
  { _id: false }
);

/**
 * Schema chính cho collection donor_trust_scores.
 * Mục đích: lưu trust score tổng hợp và breakdown chi tiết của từng donor để G2 dùng cho Trust-Adjusted QF.
 *
 * Index strategy (theo spec Section 6.4):
 * - trustId: unique — đảm bảo mỗi bản ghi có định danh duy nhất.
 * - donorAddress: unique — mỗi donor chỉ có 1 bản ghi trust score (upsert pattern).
 * - trustScore: desc — tối ưu sort khi G2 truy vấn top donors theo trust.
 */
const donorTrustScoreSchema = new Schema<DonorTrustScoreRecord>(
  {
    trustId: { type: String, required: true, unique: true },
    donorAddress: { type: String, required: true, unique: true },
    donorUserId: { type: String, required: true, index: true },
    trustScore: { type: Number, required: true, min: 0, max: 1, index: true },
    factorBreakdown: { type: trustFactorBreakdownSchema, required: true },
    // Trạng thái bản ghi — phân biệt record 'active' (tính thật) vs 'unknown' (donor không tồn tại).
    // Mặc định 'active' để backward compatible với bản ghi đã persist trước khi có field này.
    status: {
      type: String,
      enum: ['active', 'unknown'],
      default: 'active'
    },
    lastCalculatedAt: { type: Date, required: true }
  },
  {
    timestamps: true,
    // Thêm index desc cho trustScore để tối ưu sort theo trust khi G2 rank donors.
    // Tránh scan toàn collection khi số lượng donor tăng lớn.
  }
);

// Index desc cho trustScore — dùng bởi G2 Trust-Adjusted QF ranking query.
donorTrustScoreSchema.index({ trustScore: -1 });

export const DonorTrustScoreModel = mongoose.models?.DonorTrustScore
  || mongoose.model<DonorTrustScoreRecord>('DonorTrustScore', donorTrustScoreSchema);

/**
 * Hàm tìm bản ghi trust score theo wallet address của donor.
 * Mục đích: tra cứu trust score hiện tại trước khi quyết định có cần recalculate không.
 *
 * @param donorAddress - Wallet address của donor (sẽ được lowercase trước khi query).
 * @returns Bản ghi trust score hoặc null nếu chưa có.
 */
export async function findTrustScoreByDonorAddress(
  donorAddress: string
): Promise<DonorTrustScoreRecord | null> {
  return DonorTrustScoreModel.findOne({ donorAddress: donorAddress.toLowerCase() })
    .lean<DonorTrustScoreRecord>()
    .exec();
}

/**
 * Hàm upsert trust score của một donor.
 * Mục đích: tạo mới hoặc cập nhật bản ghi trust score sau mỗi lần recalculate.
 * Dùng donorAddress làm filter để đảm bảo mỗi donor chỉ có 1 bản ghi (unique index).
 *
 * @param record - Dữ liệu trust score đầy đủ bao gồm breakdown.
 * @returns Bản ghi trust score sau khi upsert.
 */
export async function upsertTrustScore(
  record: DonorTrustScoreRecord
): Promise<DonorTrustScoreRecord> {
  const normalizedRecord = { ...record, donorAddress: record.donorAddress.toLowerCase() };

  const updatedRecord = await DonorTrustScoreModel.findOneAndUpdate(
    { donorAddress: normalizedRecord.donorAddress },
    normalizedRecord,
    { upsert: true, returnDocument: 'after' }
  ).exec();

  return updatedRecord!.toObject() as DonorTrustScoreRecord;
}

/**
 * Hàm lấy danh sách tất cả donor addresses đã có bản ghi trust score với batch-based streaming.
 * Mục đích: cung cấp tập địa chỉ cho daily scheduler recalculate toàn bộ mà không gây OOM
 * khi collection lớn (>100k documents). Chunk-based streaming qua callback giảm memory footprint.
 *
 * Implementation: dùng cursor nhưng accumulate documents theo batchSize trước khi emit.
 * Tránh load toàn bộ collection vào memory cùng lúc.
 *
 * @param callback - Hàm xử lý từng batch addresses. Return Promise<void>.
 * @param batchSize - Số lượng documents mỗi batch (default: 500).
 */
export async function streamAllDonorAddressesWithTrustScore(
  callback: (addresses: string[]) => Promise<void>,
  batchSize: number = 500
): Promise<void> {
  const cursor = DonorTrustScoreModel.find({})
    .select('donorAddress')
    .lean<Pick<DonorTrustScoreRecord, 'donorAddress'>[]>()
    .cursor({ batchSize });

  let batch: string[] = [];

  // Iterate through cursor and accumulate into batches.
  for await (const doc of cursor) {
    batch.push(doc.donorAddress);

    if (batch.length >= batchSize) {
      await callback(batch);
      batch = [];
    }
  }

  // Emit remaining items as the final partial batch.
  if (batch.length > 0) {
    await callback(batch);
  }
}

/**
 * Hàm lấy trust score của nhiều donor cùng lúc theo danh sách addresses.
 * Mục đích: G2 Trust-Adjusted QF batch-fetch scores để tính matching formula mà không cần N query.
 *
 * @param donorAddresses - Danh sách wallet addresses (sẽ được normalize lowercase).
 * @returns Mảng bản ghi trust score tìm thấy.
 */
export async function findTrustScoresByDonorAddresses(
  donorAddresses: string[]
): Promise<DonorTrustScoreRecord[]> {
  if (!donorAddresses.length) {
    return [];
  }

  const normalizedAddresses = donorAddresses
    .map(address => String(address || '').trim().toLowerCase())
    .filter(Boolean);

  if (!normalizedAddresses.length) {
    return [];
  }

  return DonorTrustScoreModel.find({ donorAddress: { $in: normalizedAddresses } })
    .lean<DonorTrustScoreRecord[]>()
    .exec();
}
