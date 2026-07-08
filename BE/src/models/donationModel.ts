import mongoose, { Schema } from 'mongoose';

export type DonationStatus = 'PENDING_ONCHAIN' | 'ONCHAIN_CONFIRMED' | 'INDEXED';

export type DonationRecord = {
  transactionHash: string;
  projectId: string;
  donorAddress: string;
  amount: number;
  timestamp: Date;
  isAnonymous: boolean;
  blockNumber: number;
  donationStatus: DonationStatus;
  onChainConfirmedAt: Date;
  indexedAt: Date;
  correlationId: string;
  createdAt: Date;
  updatedAt: Date;
};

const donationSchema = new Schema<DonationRecord>({
  transactionHash: { type: String, required: true, unique: true },
  projectId: { type: String, required: true, index: true },
  donorAddress: { type: String, required: true, index: true },
  amount: { type: Number, required: true },
  timestamp: { type: Date, required: true, index: true },
  isAnonymous: { type: Boolean, required: true },
  blockNumber: { type: Number, required: true, index: true },
  donationStatus: { type: String, required: true, enum: ['PENDING_ONCHAIN', 'ONCHAIN_CONFIRMED', 'INDEXED'], default: 'INDEXED' },
  onChainConfirmedAt: { type: Date, required: true },
  indexedAt: { type: Date, required: true },
  correlationId: { type: String, required: true, index: true },
  createdAt: { type: Date, required: true },
  updatedAt: { type: Date, required: true }
});

const DonationMongoModel = mongoose.model<DonationRecord>('Donation', donationSchema);

/** Hàm upsert donation theo transaction hash. Mục đích: đảm bảo indexer không ghi trùng dữ liệu event on-chain. */
export async function upsertDonationByTransactionHash(payload: DonationRecord): Promise<DonationRecord> {
  const updatedDonation = await DonationMongoModel.findOneAndUpdate(
    { transactionHash: payload.transactionHash },
    payload,
    { upsert: true, returnDocument: 'after' }
  ).exec();

  return updatedDonation!.toObject() as DonationRecord;
}

/**
 * Hàm lấy danh sách donation theo project.
 * Mục đích: phục vụ API lịch sử quyên góp minh bạch theo UC3.1.
 * Chỉ trả về donations đã được xác nhận trên chain (donationStatus: 'INDEXED').
 */
export async function findDonationsByProjectId(projectId: string, limitCount: number): Promise<DonationRecord[]> {
  return DonationMongoModel.find({ projectId, donationStatus: 'INDEXED' })
    .sort({ timestamp: -1 })
    .limit(limitCount)
    .lean<DonationRecord[]>()
    .exec();
}

/** Hàm lấy danh sách donation toàn cục. Mục đích: cung cấp dữ liệu gốc cho trang danh sách nhà hảo tâm công khai. */
export async function findDonations(limitCount: number): Promise<DonationRecord[]> {
  return DonationMongoModel.find({}).sort({ timestamp: -1 }).limit(limitCount).lean<DonationRecord[]>().exec();
}

/** Hàm lấy donation toàn cục có phân trang. Mục đích: hỗ trợ server-side pagination cho API nhà hảo tâm. */
export async function findDonationsPaginated(limitCount: number, skipCount: number): Promise<DonationRecord[]> {
  return DonationMongoModel.find({}).sort({ timestamp: -1 }).skip(skipCount).limit(limitCount).lean<DonationRecord[]>().exec();
}

/** Hàm lấy donation theo project có phân trang. Mục đích: trả dữ liệu nhà hảo tâm theo đúng dự án người dùng chọn. */
export async function findDonationsByProjectIdPaginated(projectId: string, limitCount: number, skipCount: number): Promise<DonationRecord[]> {
  return DonationMongoModel.find({ projectId }).sort({ timestamp: -1 }).skip(skipCount).limit(limitCount).lean<DonationRecord[]>().exec();
}

/** Hàm đếm tổng donation. Mục đích: tính metadata phân trang cho API nhà hảo tâm. */
export async function countDonations(projectId?: string): Promise<number> {
  const normalizedProjectId = String(projectId || '').trim();
  const filterQuery = normalizedProjectId ? { projectId: normalizedProjectId } : {};
  return DonationMongoModel.countDocuments(filterQuery).exec();
}

/**
 * Hàm tính tổng giá trị donation toàn hệ thống.
 * Mục đích: cung cấp số liệu giao dịch thật cho metric tổng quan của admin dashboard.
 */
export async function aggregateTotalDonationAmount(): Promise<number> {
  const aggregateResult = await DonationMongoModel.aggregate<{ totalAmount: number }>([
    {
      $group: {
        _id: null,
        totalAmount: { $sum: '$amount' }
      }
    }
  ]);

  if (!aggregateResult.length) {
    return 0;
  }

  return Number(aggregateResult[0].totalAmount || 0);
}

/**
 * Hàm lấy danh sách donation theo donor address.
 * Mục đích: phục vụ FR5/UC5.1 — truy xuất lịch sử donation của một ví để tính risk score.
 */
export async function findDonationsByDonorAddress(donorAddress: string): Promise<DonationRecord[]> {
  return DonationMongoModel.find({ donorAddress: donorAddress.toLowerCase() })
    .sort({ timestamp: -1 })
    .lean<DonationRecord[]>()
    .exec();
}


/** Hàm lấy tổng donation theo project. Mục đích: trả về số tiền đã quyên góp để hiển thị ở danh sách và trang chi tiết. */
export async function aggregateDonationSummaryByProjectId(projectId: string): Promise<{ totalAmount: number; donationCount: number }> {
  const aggregateResult = await DonationMongoModel.aggregate<{ totalAmount: number; donationCount: number }>([
    { $match: { projectId } },
    { $group: { _id: null, totalAmount: { $sum: '$amount' }, donationCount: { $sum: 1 } } }
  ]);

  if (!aggregateResult.length) {
    return { totalAmount: 0, donationCount: 0 };
  }

  return { totalAmount: aggregateResult[0].totalAmount, donationCount: aggregateResult[0].donationCount };
}

/** Hàm lấy block lớn nhất đã index. Mục đích: hỗ trợ endpoint sync event chỉ đọc block mới. */
export async function findLatestIndexedBlockNumber(): Promise<number> {
  const latestRecord = await DonationMongoModel.findOne({}).sort({ blockNumber: -1 }).lean<DonationRecord>().exec();
  return latestRecord?.blockNumber || 0;
}

/** Hàm lấy timestamp donation gần nhất của một dự án. Mục đích: trả thời gian quyên góp cuối cùng thay vì updatedAt của project record. */
export async function findLatestDonationTimestampByProjectId(projectId: string): Promise<Date | null> {
  const latestDonationRecord = await DonationMongoModel.findOne({ projectId })
    .sort({ timestamp: -1 })
    .select('timestamp')
    .lean<{ timestamp: Date } | null>()
    .exec();
  return latestDonationRecord?.timestamp || null;
}

/** Hàm lấy donation trong khoảng thời gian. Mục đích: cung cấp tập đóng góp cho job tính bảng xếp hạng QF. */
export async function findDonationsInTimeRange(startedAt: Date, endedAt: Date): Promise<DonationRecord[]> {
  return DonationMongoModel.find({
    timestamp: { $gte: startedAt, $lte: endedAt },
    donationStatus: 'INDEXED'
  })
    .sort({ timestamp: -1 })
    .lean<DonationRecord[]>()
    .exec();
}

/** Hàm lấy donation của một project trong khoảng thời gian. Mục đích: phục vụ recompute project metrics. */
export async function findDonationsByProjectIdInTimeRange(projectId: string, startedAt: Date, endedAt: Date): Promise<DonationRecord[]> {
  return DonationMongoModel.find({
    projectId,
    timestamp: { $gte: startedAt, $lte: endedAt },
    donationStatus: 'INDEXED'
  })
    .sort({ timestamp: -1 })
    .lean<DonationRecord[]>()
    .exec();
}

/**
 * Hàm đếm donations kể từ một thời điểm.
 * Mục đích: phục vụ reconciliation worker tính tỷ lệ guest donations.
 * @param sinceDate - Thời điểm bắt đầu
 * @returns Số lượng donations
 */
export async function countDonationsSince(sinceDate: Date): Promise<number> {
  return DonationMongoModel.countDocuments({
    timestamp: { $gte: sinceDate }
  }).exec();
}


