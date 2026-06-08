import mongoose, { Schema } from 'mongoose';

export type RankingProjectItem = {
  projectId: string;
  projectName: string;
  organizationName: string;
  rankPosition: number;
  totalRaisedAmount: number;
  uniqueDonorCount: number;
  quadraticScoreRaw: number;
  matchingAmount: number;
  totalFundingScore: number;
};

export type RankingSnapshotRecord = {
  snapshotId: string;
  calculatedAt: Date;
  calculationWindowHours: number;
  calculationWindowStartedAt: Date;
  calculationWindowEndedAt: Date;
  totalValidDonations: number;
  skippedInvalidDonationCount: number;
  skippedSybilDonationCount: number;
  rankingItems: RankingProjectItem[];
  createdAt: Date;
};

const rankingProjectItemSchema = new Schema<RankingProjectItem>(
  {
    projectId: { type: String, required: true, index: true },
    projectName: { type: String, required: true },
    organizationName: { type: String, required: true },
    rankPosition: { type: Number, required: true },
    totalRaisedAmount: { type: Number, required: true },
    uniqueDonorCount: { type: Number, required: true },
    quadraticScoreRaw: { type: Number, required: true },
    matchingAmount: { type: Number, required: true },
    totalFundingScore: { type: Number, required: true }
  },
  { _id: false }
);

const rankingSnapshotSchema = new Schema<RankingSnapshotRecord>({
  snapshotId: { type: String, required: true, unique: true },
  calculatedAt: { type: Date, required: true, index: true },
  calculationWindowHours: { type: Number, required: true },
  calculationWindowStartedAt: { type: Date, required: true },
  calculationWindowEndedAt: { type: Date, required: true },
  totalValidDonations: { type: Number, required: true },
  skippedInvalidDonationCount: { type: Number, required: true },
  skippedSybilDonationCount: { type: Number, required: true },
  rankingItems: { type: [rankingProjectItemSchema], required: true },
  createdAt: { type: Date, required: true }
});

const RankingSnapshotMongoModel = mongoose.model<RankingSnapshotRecord>('RankingSnapshot', rankingSnapshotSchema);

/**
 * ID cố định dùng làm anchor cho UPSERT.
 * Mọi lần recalculate đều ghi đè document này thay vì tạo document mới.
 */
const CURRENT_RANKING_SNAPSHOT_ID = 'current-ranking';

/**
 * Hàm lưu / cập nhật snapshot bảng xếp hạng bằng UPSERT.
 * Mục đích: thay vì tạo document mới mỗi 5 phút, luôn ghi đè 1 document duy nhất
 * có snapshotId = 'current-ranking', đảm bảo API đọc luôn nhất quán mà không phình collection.
 */
export async function createRankingSnapshot(snapshot: RankingSnapshotRecord): Promise<RankingSnapshotRecord> {
  const upserted = await RankingSnapshotMongoModel.findOneAndUpdate(
    // Filter: luôn match document có snapshotId = 'current-ranking'
    { snapshotId: CURRENT_RANKING_SNAPSHOT_ID },
    // Payload: ghi đè toàn bộ document, createdAt cập nhật theo thời điểm hiện tại
    {
      $set: {
        calculatedAt: snapshot.calculatedAt,
        calculationWindowHours: snapshot.calculationWindowHours,
        calculationWindowStartedAt: snapshot.calculationWindowStartedAt,
        calculationWindowEndedAt: snapshot.calculationWindowEndedAt,
        totalValidDonations: snapshot.totalValidDonations,
        skippedInvalidDonationCount: snapshot.skippedInvalidDonationCount,
        skippedSybilDonationCount: snapshot.skippedSybilDonationCount,
        rankingItems: snapshot.rankingItems,
        // createdAt được cập nhật mỗi lần upsert để phản ánh thời điểm tính toán mới nhất
        createdAt: new Date()
      },
      // Khi upsert (document chưa tồn tại), đặt snapshotId cố định
      $setOnInsert: { snapshotId: CURRENT_RANKING_SNAPSHOT_ID }
    },
    {
      upsert: true,                     // Tạo document nếu chưa có, update nếu đã có
      returnDocument: 'after',          // Trả về document sau khi update/upsert (thay thế deprecated `new: true`)
      lean: true                        // Trả về plain object thuần JS thay vì Mongoose document
    }
  ).exec();

  return upserted as RankingSnapshotRecord;
}

/** Hàm lấy snapshot bảng xếp hạng mới nhất. Mục đích: phục vụ endpoint đọc ranking hiện tại với độ trễ thấp. */
export async function findLatestRankingSnapshot(): Promise<RankingSnapshotRecord | null> {
  return RankingSnapshotMongoModel.findOne({}).sort({ calculatedAt: -1, createdAt: -1 }).lean<RankingSnapshotRecord>().exec();
}
