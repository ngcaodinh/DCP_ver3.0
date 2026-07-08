import type { DonorTrustScoreRecord } from '../types/trust-score.types';
import {
  findTrustScoreByDonorAddress,
  findTrustScoresByDonorAddresses,
  streamAllDonorAddressesWithTrustScore,
  upsertTrustScore
} from '../models/donorTrustScoreModel';

/**
 * Hàm lấy trust score của một donor theo wallet address.
 * Mục đích: cung cấp entry-point sạch cho service layer, tách biệt hoàn toàn khỏi Mongoose model.
 *
 * @param donorAddress - Wallet address của donor (case-insensitive, sẽ được normalize trong model).
 * @returns Bản ghi trust score hoặc null nếu donor chưa có bản ghi.
 */
export async function getTrustScoreByDonorAddress(
  donorAddress: string
): Promise<DonorTrustScoreRecord | null> {
  return findTrustScoreByDonorAddress(donorAddress);
}

/**
 * Hàm lấy trust score của nhiều donor cùng lúc theo danh sách addresses.
 * Mục đích: phục vụ G2 Trust-Adjusted QF batch-fetch để tránh N+1 query pattern.
 *
 * @param donorAddresses - Danh sách wallet addresses cần tra cứu.
 * @returns Mảng bản ghi trust score tìm thấy (có thể ít hơn input nếu một số donor chưa có score).
 */
export async function getTrustScoresByDonorAddresses(
  donorAddresses: string[]
): Promise<DonorTrustScoreRecord[]> {
  return findTrustScoresByDonorAddresses(donorAddresses);
}

/**
 * Hàm lưu hoặc cập nhật trust score của một donor.
 * Mục đích: persistence layer duy nhất cho trust score — đảm bảo idempotent upsert theo donorAddress.
 *
 * @param record - Dữ liệu trust score đầy đủ (trustId, score, breakdown, timestamps).
 * @returns Bản ghi trust score sau khi persist.
 */
export async function saveTrustScore(
  record: DonorTrustScoreRecord
): Promise<DonorTrustScoreRecord> {
  return upsertTrustScore(record);
}

/**
 * Hàm stream donor addresses theo batch để scheduler xử lý mà không gây OOM.
 * Mục đích: thay thế getAllDonorAddressesWithTrustScore để hỗ trợ 100k+ donors.
 *
 * @param callback - Hàm xử lý mỗi batch addresses.
 * @param batchSize - Số lượng addresses mỗi batch.
 */
export async function streamDonorAddressesForScheduler(
  callback: (addresses: string[]) => Promise<void>,
  batchSize: number = 500
): Promise<void> {
  return streamAllDonorAddressesWithTrustScore(callback, batchSize);
}
