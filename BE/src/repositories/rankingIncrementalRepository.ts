import {
  findAllProjectMetrics,
  findProjectMetricsById,
  getOrCreateProjectMetrics,
  upsertProjectMetrics,
  deleteProjectMetrics,
  ProjectIncrementalMetrics
} from '../models/rankingIncrementalModel';
import { findDonationsByProjectIdInTimeRange } from '../models/donationModel';

/**
 * Hàm repository lấy hoặc tạo metrics cho project.
 * Mục đích: khởi tạo record nếu chưa có, phục vụ applyDonation khi project chưa có metrics.
 */
export async function getOrCreateProjectMetricsFromRepository(projectId: string): Promise<ProjectIncrementalMetrics> {
  return getOrCreateProjectMetrics(projectId);
}

/**
 * Hàm repository upsert metrics với MongoDB operations.
 * Mục đích: cho phép O(1) update running totals (không cần query donations).
 *
 * @param projectId - ID của project cần cập nhật
 * @param updateOperation - MongoDB update operation ($set, $inc, $addToSet...)
 */
export async function upsertProjectMetricsFromRepository(
  projectId: string,
  updateOperation: Record<string, unknown>
): Promise<ProjectIncrementalMetrics> {
  return upsertProjectMetrics(projectId, updateOperation);
}

/**
 * Hàm repository lấy tất cả project metrics.
 * Mục đích: đọc bảng xếp hạng từ incremental metrics.
 */
export async function findAllProjectMetricsFromRepository(): Promise<ProjectIncrementalMetrics[]> {
  return findAllProjectMetrics();
}

/**
 * Hàm repository lấy metrics theo projectId.
 * Mục đích: dùng cho chi tiết 1 project trong bảng xếp hạng.
 */
export async function findProjectMetricsByIdFromRepository(projectId: string): Promise<ProjectIncrementalMetrics | null> {
  return findProjectMetricsById(projectId);
}

/**
 * Hàm repository xóa metrics theo projectId.
 * Mục đích: dùng khi project bị xóa khỏi hệ thống.
 */
export async function deleteProjectMetricsFromRepository(projectId: string): Promise<void> {
  return deleteProjectMetrics(projectId);
}

/**
 * Hàm lấy donations hợp lệ trong window cho một project cụ thể.
 * Mục đích: phục vụ full recompute khi phát hiện drift hoặc sybil thay đổi.
 * Chỉ query donations của project đó, không phải toàn bộ donations.
 *
 * @param projectId - ID của project cần lấy donations
 * @param startedAt - Thời điểm bắt đầu cửa sổ thời gian
 * @param endedAt - Thời điểm kết thúc cửa sổ thời gian
 */
export async function findDonationsForProjectInWindow(
  projectId: string,
  startedAt: Date,
  endedAt: Date
) {
  return findDonationsByProjectIdInTimeRange(projectId, startedAt, endedAt);
}
