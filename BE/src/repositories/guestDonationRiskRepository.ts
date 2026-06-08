import { Types } from 'mongoose';
import {
  GuestDonationRiskModel,
  GuestDonationRisk
} from '../models/guestDonationRiskModel';

/**
 * Hàm tìm bản ghi risk theo sessionId.
 * Mục đích: lấy risk score hiện tại của một phiên guest wallet.
 * @param sessionId - ID của phiên guest session
 * @returns Bản ghi risk hoặc null nếu không tìm thấy
 */
export async function findGuestDonationRiskBySessionId(
  sessionId: string
): Promise<GuestDonationRisk | null> {
  return GuestDonationRiskModel.findOne({ sessionId })
    .lean<GuestDonationRisk>()
    .exec();
}

/**
 * Hàm tìm bản ghi risk theo walletAddress.
 * Mục đích: kiểm tra lịch sử risk của một ví trước khi sponsor paymaster.
 * @param walletAddress - Địa chỉ ví EVM
 * @returns Bản ghi risk hoặc null nếu không tìm thấy
 */
export async function findGuestDonationRiskByWalletAddress(
  walletAddress: string
): Promise<GuestDonationRisk | null> {
  return GuestDonationRiskModel.findOne({ walletAddress })
    .lean<GuestDonationRisk>()
    .exec();
}

/**
 * Hàm upsert bản ghi risk evaluation cho một phiên.
 * Mục đích: cập nhật risk score sau mỗi lần đánh giá (tạo session hoặc donate).
 * Sử dụng upsert để tạo record mới nếu chưa có, hoặc cập nhật nếu đã tồn tại.
 * @param sessionId - ID của phiên guest session
 * @param riskData - Dữ liệu risk cần cập nhật
 * @returns Bản ghi risk đã được tạo/cập nhật
 */
export async function upsertGuestDonationRisk(
  sessionId: string,
  riskData: Partial<GuestDonationRisk>
): Promise<GuestDonationRisk> {
  const now = new Date();
  const result = await GuestDonationRiskModel.findOneAndUpdate(
    { sessionId },
    {
      $set: {
        ...riskData,
        lastEvaluatedAt: now,
        updatedAt: now
      },
      $setOnInsert: {
        createdAt: now
      }
    },
    {
      upsert: true,
      returnDocument: 'after'
    }
  )
    .lean<GuestDonationRisk>()
    .exec();
  return result;
}

/**
 * Hàm đánh dấu một session là cluster suspect.
 * Mục đích: ghi nhận khi phát hiện nhiều wallets cùng fingerprint/IP có thể là Sybil farm.
 * @param sessionId - ID của phiên guest session
 * @param clusterId - ID của cluster được phát hiện
 * @returns Bản ghi risk đã được cập nhật hoặc null nếu không tìm thấy
 */
export async function markAsClusterSuspect(
  sessionId: string,
  clusterId: string
): Promise<GuestDonationRisk | null> {
  const updated = await GuestDonationRiskModel.findOneAndUpdate(
    { sessionId },
    {
      $set: {
        clusterSuspect: true,
        clusterId,
        updatedAt: new Date()
      }
    },
    { returnDocument: 'after' }
  )
    .lean<GuestDonationRisk>()
    .exec();
  return updated;
}

/**
 * Hàm batch đánh dấu nhiều sessions là cluster suspect cùng lúc.
 * Mục đích: thay thế N lần gọi markAsClusterSuspect bằng 1 updateMany query.
 * Tránh N+1 write khi cluster có nhiều wallets.
 * @param sessionIds - Danh sách ID của các phiên guest session
 * @param clusterId - ID của cluster được phát hiện
 * @returns Số bản ghi đã được cập nhật
 */
export async function markManyAsClusterSuspect(
  sessionIds: string[],
  clusterId: string
): Promise<number> {
  if (!sessionIds.length) return 0;

  const result = await GuestDonationRiskModel.updateMany(
    { sessionId: { $in: sessionIds } },
    {
      $set: {
        clusterSuspect: true,
        clusterId,
        updatedAt: new Date()
      }
    }
  );
  return result.modifiedCount;
}

/**
 * Hàm đếm số wallet trong cùng cluster.
 * Mục đích: kiểm tra mức độ nghiêm trọng của cluster — nếu >5 wallets cùng cluster → flag cao.
 * @param clusterId - ID của cluster cần đếm
 * @returns Số lượng wallet trong cluster
 */
export async function countClusterMembers(clusterId: string): Promise<number> {
  return GuestDonationRiskModel.countDocuments({ clusterId }).exec();
}

/**
 * Hàm tìm tất cả cluster suspects với cursor-based pagination.
 * Mục đích: gửi danh sách cho admin dashboard khi guest donations > 60% total.
 * Performance: Sử dụng cursor-based pagination thay vì skip() để tránh O(N) scan
 * với dataset lớn. Cursor dựa trên _id với thứ tự tăng dần.
 * @param upperBound - Giới hạn tối đa số kết quả trả về (mặc định 1000)
 * @param lastSeenId - Cursor: _id của bản ghi cuối cùng đã thấy (null cho trang đầu)
 * @returns Array các bản ghi cluster suspect
 */
export async function findAllClusterSuspects(
  upperBound: number = 1000,
  lastSeenId?: string
): Promise<GuestDonationRisk[]> {
  const query: Record<string, unknown> = { clusterSuspect: true };

  // Cursor-based pagination: chỉ lấy các bản ghi có _id lớn hơn lastSeenId
  if (lastSeenId) {
    try {
      query._id = { $gt: new Types.ObjectId(lastSeenId) };
    } catch {
      // Invalid ObjectId format, ignore cursor filter
    }
  }

  return GuestDonationRiskModel.find(query)
    .sort({ _id: 1 })
    .limit(upperBound)
    .lean<GuestDonationRisk[]>()
    .exec();
}

