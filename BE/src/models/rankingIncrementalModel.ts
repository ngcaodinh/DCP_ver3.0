import mongoose, { Schema } from 'mongoose';

/**
 * Kiểu dữ liệu đại diện cho incremental metrics của một project.
 * Lưu trữ running totals để tính QF score O(1) thay vì query toàn bộ donations mỗi lần.
 *
 * @description Tránh bottleneck: trước đây recalculateRankingSnapshot() query tất cả donations
 * trong window (có thể 300,000 docs), giờ chỉ cần 1 document/project để đọc score.
 */
export type ProjectIncrementalMetrics = {
  projectId: string;
  totalRaisedAmount: number;      // Σ dᵢ — tổng tiền quyên góp của tất cả donor hợp lệ
  sumSqrtDonations: number;       // Σ √dᵢ — tổng căn bậc 2 của từng khoản donation (chưa weighted)
  weightedSumSqrtDonations: number; // Σ √dᵢ × trustMultiplier — dùng cho QF chính thức khi > 0
  donorAddresses: string[];       // Danh sách địa chỉ ví donor duy nhất (dùng $addToSet)
  totalDonationCount: number;     // Tổng số lần quyên góp (kể cả trùng donor)
  guestDonationCount: number;     // Số lần quyên góp ẩn danh (trustMultiplier < 1.0)
  lastDonationAt: Date | null;    // Timestamp donation gần nhất (để sort/invalidate cache)
  lastFullRecomputeAt: Date | null; // Timestamp recompute cuối cùng (phát hiện drift)
  recomputeVersion: number;       // Version counter — tăng mỗi full recompute, dùng detect drift
  updatedAt: Date;
};

const incrementalSchema = new Schema<ProjectIncrementalMetrics>({
  projectId: { type: String, required: true, unique: true, index: true },
  totalRaisedAmount: { type: Number, default: 0 },
  sumSqrtDonations: { type: Number, default: 0 },
  weightedSumSqrtDonations: { type: Number, default: 0 },
  donorAddresses: { type: [String], default: [] },
  totalDonationCount: { type: Number, default: 0 },
  guestDonationCount: { type: Number, default: 0 },
  lastDonationAt: { type: Date, default: null },
  lastFullRecomputeAt: { type: Date, default: null },
  recomputeVersion: { type: Number, default: 0 },
  updatedAt: { type: Date, required: true }
});

const ProjectIncrementalMetricsMongoModel = mongoose.model<ProjectIncrementalMetrics>(
  'ProjectIncrementalMetrics',
  incrementalSchema
);

/**
 * Hàm tìm hoặc tạo metrics cho project.
 * Mục đích: khởi tạo record nếu chưa có, phục vụ applyDonation khi project chưa có metrics.
 */
export async function getOrCreateProjectMetrics(projectId: string): Promise<ProjectIncrementalMetrics> {
  const existingMetrics = await ProjectIncrementalMetricsMongoModel.findOne({ projectId })
    .lean<ProjectIncrementalMetrics>()
    .exec();

  if (existingMetrics) {
    return existingMetrics;
  }

  const now = new Date();
  const newMetrics: ProjectIncrementalMetrics = {
    projectId,
    totalRaisedAmount: 0,
    sumSqrtDonations: 0,
    weightedSumSqrtDonations: 0,
    donorAddresses: [],
    totalDonationCount: 0,
    guestDonationCount: 0,
    lastDonationAt: null,
    lastFullRecomputeAt: null,
    recomputeVersion: 0,
    updatedAt: now
  };

  const createdMetrics = await ProjectIncrementalMetricsMongoModel.create(newMetrics);
  return createdMetrics.toObject() as ProjectIncrementalMetrics;
}

/**
 * Hàm upsert metrics cho project với $set hoặc $inc operations.
 * Mục đích: cho phép O(1) update running totals (không cần query donations).
 *
 * @param projectId - ID của project cần cập nhật
 * @param updateOperation - MongoDB update operation ($set, $inc, $addToSet...)
 * @returns Document sau khi update
 */
export async function upsertProjectMetrics(
  projectId: string,
  updateOperation: Record<string, unknown>
): Promise<ProjectIncrementalMetrics> {
  const now = new Date();

  const updatedMetrics = await ProjectIncrementalMetricsMongoModel.findOneAndUpdate(
    { projectId },
    {
      ...updateOperation,
      $set: {
        ...(updateOperation.$set as Record<string, unknown> | undefined),
        updatedAt: now
      }
    },
    {
      upsert: true,
      returnDocument: 'after',
      lean: true
    }
  ).exec();

  return updatedMetrics as ProjectIncrementalMetrics;
}

/**
 * Hàm lấy tất cả project metrics.
 * Mục đích: đọc bảng xếp hạng từ incremental metrics — O(P) với P = số project,
 * thay vì O(D) với D = số donations.
 */
export async function findAllProjectMetrics(): Promise<ProjectIncrementalMetrics[]> {
  return ProjectIncrementalMetricsMongoModel.find({})
    .lean<ProjectIncrementalMetrics[]>()
    .exec();
}

/**
 * Hàm tìm metrics theo projectId.
 * Mục đích: dùng cho chi tiết 1 project trong bảng xếp hạng.
 */
export async function findProjectMetricsById(projectId: string): Promise<ProjectIncrementalMetrics | null> {
  return ProjectIncrementalMetricsMongoModel.findOne({ projectId })
    .lean<ProjectIncrementalMetrics | null>()
    .exec();
}

/**
 * Hàm xóa metrics theo projectId.
 * Mục đích: dùng khi project bị xóa khỏi hệ thống.
 */
export async function deleteProjectMetrics(projectId: string): Promise<void> {
  await ProjectIncrementalMetricsMongoModel.deleteOne({ projectId }).exec();
}
