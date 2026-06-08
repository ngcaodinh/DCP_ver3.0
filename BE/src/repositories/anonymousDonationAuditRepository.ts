/**
 * Repository cho collection anonymous_donation_audits — tách biệt MongoDB queries
 * theo pattern repository pattern, giữ business logic và data access layer riêng biệt.
 * Phục vụ các worker đọc/ghi audit records phục vụ risk scoring và reconciliation.
 */
import mongoose from 'mongoose';
import {
  AnonymousDonationAuditModel,
  AnonymousDonationAudit
} from '../models/anonymousDonationAuditModel';

/**
 * Hàm tìm audit record theo userOpHash.
 * Mục đích: kiểm tra duplicate UserOperation trước khi sponsor paymaster.
 * @param userOpHash - Hash của UserOperation (unique index)
 * @returns Audit record hoặc null nếu không tìm thấy
 */
export async function findAuditByUserOpHash(
  userOpHash: string
): Promise<AnonymousDonationAudit | null> {
  return AnonymousDonationAuditModel.findOne({ userOpHash })
    .lean<AnonymousDonationAudit>()
    .exec();
}

/**
 * Hàm tìm audit records theo sessionId.
 * Mục đích: lấy toàn bộ lịch sử donation của một phiên guest wallet.
 * @param sessionId - ID của phiên guest session
 * @returns Danh sách audit records
 */
export async function findAuditsBySessionId(
  sessionId: string
): Promise<AnonymousDonationAudit[]> {
  return AnonymousDonationAuditModel.find({ sessionId })
    .lean<AnonymousDonationAudit[]>()
    .exec();
}

/**
 * Hàm tìm các khoản donation amounts theo sessionId với projection.
 * Mục đích: checkDonationPattern chỉ cần field amount, dùng projection để tối ưu performance.
 * @param sessionId - ID của phiên guest session
 * @returns Mảng các khoản donation amounts
 */
export async function findAuditAmountsBySessionId(
  sessionId: string
): Promise<number[]> {
  const results = await AnonymousDonationAuditModel.find({ sessionId })
    .select('amount -_id')
    .lean<{ amount: number }[]>()
    .exec();
  return results.map((r) => Number(r.amount));
}

/**
 * Hàm tìm audit records theo walletAddress.
 * Mục đích: lấy donation history của một ví cụ thể phục vụ risk evaluation.
 * @param walletAddress - Địa chỉ ví EVM
 * @returns Danh sách audit records
 */
export async function findAuditsByWalletAddress(
  walletAddress: string
): Promise<AnonymousDonationAudit[]> {
  return AnonymousDonationAuditModel.find({ walletAddress })
    .lean<AnonymousDonationAudit[]>()
    .exec();
}

/**
 * Hàm tìm audit records theo projectId.
 * Mục đích: rebuild weighted QF metrics trong recomputeProjectMetrics.
 * Mỗi audit record chứa trustMultiplier của guest donation tại thời điểm donate.
 * @param projectId - ID của project
 * @returns Danh sách audit records của project đó
 */
export async function findAuditsByProjectId(
  projectId: string
): Promise<AnonymousDonationAudit[]> {
  return AnonymousDonationAuditModel.find({ projectId })
    .lean<AnonymousDonationAudit[]>()
    .exec();
}

/**
 * Hàm tìm audit records theo projectId trong cửa sổ thời gian.
 * Mục đích: rebuild weighted QF metrics với lọc thời gian ở Database layer.
 * Trả về đúng lượng record trong window, không load toàn bộ project audits vào RAM.
 * @param projectId - ID của project
 * @param startedAt - Thời điểm bắt đầu cửa sổ
 * @param endedAt - Thời điểm kết thúc cửa sổ
 * @returns Danh sách audit records trong window
 */
export async function findAuditsForProjectInWindow(
  projectId: string,
  startedAt: Date,
  endedAt: Date
): Promise<AnonymousDonationAudit[]> {
  return AnonymousDonationAuditModel.find({
    projectId,
    createdAt: { $gte: startedAt, $lte: endedAt }
  })
    .lean<AnonymousDonationAudit[]>()
    .exec();
}

/**
 * Hàm tìm các audit records chưa được index on-chain.
 * Mục đích: reconciliation worker tìm các donation đã sponsor nhưng chưa có onChainTxHash.
 * Những record này có thể là token kẹt trong pipeline.
 * @param limit - Giới hạn số bản ghi trả về (mặc định 100)
 * @param sessionIdFilter - Lọc theo sessionId cụ thể (tùy chọn)
 * @returns Danh sách audit records chưa được index
 */
export async function findUnindexedAudits(
  limit: number = 100,
  sessionIdFilter?: string
): Promise<AnonymousDonationAudit[]> {
  const query: Record<string, unknown> = {
    onChainTxHash: null,
    indexedAt: null
  };

  if (sessionIdFilter) {
    query.sessionId = sessionIdFilter;
  }

  return AnonymousDonationAuditModel.find(query)
    .sort({ createdAt: 1 })
    .limit(limit)
    .lean<AnonymousDonationAudit[]>()
    .exec();
}

/**
 * Hàm đếm số donation ẩn danh trong một khoảng thời gian.
 * Mục đích: tính tỷ lệ guest donations so với total donations phục vụ anti-farming check.
 * @param sinceDate - Thời điểm bắt đầu
 * @returns Số lượng donation ẩn danh
 */
export async function countAnonymousDonationsSince(
  sinceDate: Date
): Promise<number> {
  return AnonymousDonationAuditModel.countDocuments({
    createdAt: { $gte: sinceDate }
  }).exec();
}

/**
 * Hàm tạo audit record mới.
 * Mục đích: ghi nhận mỗi lần paymaster được sponsor.
 * @param audit - Dữ liệu audit cần tạo
 * @param session - MongoDB session cho transaction (tùy chọn)
 * @returns Audit record đã được tạo
 */
export async function createAuditRecord(
  audit: AnonymousDonationAudit,
  session?: mongoose.ClientSession
): Promise<AnonymousDonationAudit> {
  const created = await AnonymousDonationAuditModel.create([audit], { session });
  return created[0].toObject() as AnonymousDonationAudit;
}

/**
 * Hàm cập nhật audit record sau khi index on-chain.
 * Mục đích: ghi nhận transaction hash và block number sau khi donation được confirm.
 * @param userOpHash - Hash của UserOperation
 * @param txData - Dữ liệu on-chain cần cập nhật
 * @returns Audit record đã được cập nhật
 */
export async function updateAuditOnChainData(
  userOpHash: string,
  txData: { onChainTxHash: string; onChainBlockNumber: number }
): Promise<AnonymousDonationAudit | null> {
  return AnonymousDonationAuditModel.findOneAndUpdate(
    { userOpHash },
    {
      $set: {
        onChainTxHash: txData.onChainTxHash,
        onChainBlockNumber: txData.onChainBlockNumber,
        indexedAt: new Date()
      }
    },
    { returnDocument: 'after' }
  )
    .lean<AnonymousDonationAudit>()
    .exec();
}

/**
 * Hàm cập nhật audit record bằng transaction hash (reverse lookup).
 * Mục đích: khi sync worker chạy, nó chỉ có transaction hash từ blockchain event
 * nhưng không có userOpHash. Dùng hàm này để link audit record sau khi
 * donation event được đồng bộ. Cập nhật idempotent — nếu đã có onChainTxHash
 * thì bỏ qua để tránh double-update khi job chạy lại.
 * @param onChainTxHash - Transaction hash trên blockchain
 * @param onChainBlockNumber - Block number chứa transaction
 * @returns Số bản ghi đã được cập nhật (0 = đã có data hoặc không tìm thấy)
 */
export async function updateAuditByTransactionHash(
  onChainTxHash: string,
  onChainBlockNumber: number
): Promise<number> {
  const result = await AnonymousDonationAuditModel.updateOne(
    {
      onChainTxHash: onChainTxHash,
      indexedAt: null // Chỉ update nếu chưa được index (idempotent guard)
    },
    {
      $set: {
        onChainBlockNumber,
        indexedAt: new Date()
      }
    }
  );
  return result.modifiedCount;
}

/**
 * Hàm link audit records đến user đã claim.
 * Mục đích: cập nhật claimedByUserId sau khi guest wallet được migrate sang tài khoản.
 * @param sessionId - ID của phiên guest session
 * @param claimedByUserId - ID của user đã claim
 * @param mongoSession - MongoDB session cho transaction (tùy chọn)
 * @returns Số bản ghi đã được cập nhật
 */
export async function linkAuditsToClaimedUser(
  sessionId: string,
  claimedByUserId: string,
  mongoSession?: mongoose.ClientSession
): Promise<number> {
  const result = await AnonymousDonationAuditModel.updateMany(
    { sessionId },
    {
      $set: {
        claimedByUserId
      }
    },
    { session: mongoSession }
  );
  return result.modifiedCount;
}
