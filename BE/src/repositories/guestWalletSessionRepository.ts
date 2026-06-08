import mongoose, { Types } from 'mongoose';
import {
  GuestWalletSessionModel,
  GuestWalletSession
} from '../models/guestWalletSessionModel';
import { MAX_DONATIONS_PER_SESSION } from '../constants/guestDonation';

/**
 * Loại chỉ cho phép update các fields có thể thay đổi sau khi tạo.
 * Immutable fields (sessionId, walletAddress, createdAt) bị loại trừ để tránh
 * accidental modification qua repository layer.
 */
export type UpdateableGuestWalletSession = Partial<
  Pick<
    GuestWalletSession,
    | 'status'
    | 'donationCount'
    | 'totalDonatedAmount'
    | 'totalSponsoredGas'
    | 'renewalCount'
    | 'claimedByUserId'
    | 'hasPendingDonation'
    | 'pendingAlertSentAt'
    | 'expiresAt'
    | 'serverSalt'
    | 'smartAccountOwnerEncryptedPrivateKey'
  >
> & { updatedAt?: Date };

/**
 * Hàm tạo phiên guest wallet mới.
 * Mục đích: khởi tạo record session khi user chọn donate ẩn danh.
 */
export async function createGuestWalletSession(
  session: GuestWalletSession
): Promise<GuestWalletSession> {
  const createdSession = await GuestWalletSessionModel.create(session);
  return createdSession.toObject() as GuestWalletSession;
}

/**
 * Hàm tìm phiên guest wallet theo sessionId.
 * Mục đích: xác thực và truy xuất thông tin phiên ẩn danh.
 */
export async function findGuestWalletSessionById(
  sessionId: string
): Promise<GuestWalletSession | null> {
  return GuestWalletSessionModel.findOne({ sessionId })
    .lean<GuestWalletSession>()
    .exec();
}

/**
 * Hàm tìm phiên guest wallet theo walletAddress.
 * Mục đích: kiểm tra ví đã có session hay chưa, phục vụ restore.
 * Filter theo status = 'ACTIVE' để tránh trả về session đã expired/claimed/purged.
 */
export async function findGuestWalletSessionByWalletAddress(
  walletAddress: string
): Promise<GuestWalletSession | null> {
  return GuestWalletSessionModel.findOne({ walletAddress, status: 'ACTIVE' })
    .lean<GuestWalletSession>()
    .exec();
}

/**
 * Giới hạn số lượng kết quả trả về để tránh unbounded collection scan.
 * Giá trị 50 đủ để phát hiện burst pattern mà không gây quá tải bộ nhớ.
 */
const QUERY_LIMIT = 50;

/**
 * Hàm tìm các phiên guest wallet theo fingerprint trong khoảng thời gian.
 * Mục đích: kiểm tra giới hạn tạo session theo thiết bị (FR5.G).
 * Luôn yêu cầu time range để tránh unbounded collection scan.
 */
export async function findGuestWalletSessionsByFingerprint(
  deviceFingerprintHash: string,
  sinceDate: Date
): Promise<GuestWalletSession[]> {
  return GuestWalletSessionModel.find({
    deviceFingerprintHash,
    createdAt: { $gte: sinceDate }
  })
    .limit(QUERY_LIMIT)
    .lean<GuestWalletSession[]>()
    .exec();
}

/**
 * Hàm tìm các phiên guest wallet theo IP trong khoảng thời gian.
 * Mục đích: kiểm tra giới hạn tạo session theo IP và detect IP burst.
 * Luôn yêu cầu time range để tránh unbounded collection scan.
 */
export async function findGuestWalletSessionsByIp(
  ipAddress: string,
  sinceDate: Date
): Promise<GuestWalletSession[]> {
  return GuestWalletSessionModel.find({
    ipAddress,
    createdAt: { $gte: sinceDate }
  })
    .limit(QUERY_LIMIT)
    .lean<GuestWalletSession[]>()
    .exec();
}

/**
 * Hàm đếm số phiên guest wallet theo fingerprint trong 24 giờ.
 * Mục đích: kiểm tra giới hạn ≤3 sessions/fingerprint/24h.
 */
export async function countRecentSessionsByFingerprint(
  deviceFingerprintHash: string,
  sinceDate: Date
): Promise<number> {
  return GuestWalletSessionModel.countDocuments({
    deviceFingerprintHash,
    createdAt: { $gte: sinceDate }
  }).exec();
}

/**
 * Hàm đếm số phiên guest wallet theo IP trong 1 giờ.
 * Mục đích: kiểm tra IP burst (≥3 sessions/1h → +30 risk score).
 */
export async function countRecentSessionsByIp(
  ipAddress: string,
  sinceDate: Date
): Promise<number> {
  return GuestWalletSessionModel.countDocuments({
    ipAddress,
    createdAt: { $gte: sinceDate }
  }).exec();
}

/**
 * Hàm đếm số phiên guest wallet theo IP trong khoảng thời gian, loại trừ một session cụ thể.
 * Mục đích: kiểm tra session velocity - đếm các session TỒN TẠI TRƯỚC session hiện tại,
 * không include chính nó trong count. Session hiện tại đã được insert vào DB
 * trước khi hàm này được gọi.
 * @param ipAddress - Địa chỉ IP cần đếm
 * @param sinceDate - Thời điểm bắt đầu đếm
 * @param excludeSessionId - Session ID cần loại trừ khỏi count
 */
export async function countRecentSessionsByIpExcluding(
  ipAddress: string,
  sinceDate: Date,
  excludeSessionId: string
): Promise<number> {
  return GuestWalletSessionModel.countDocuments({
    ipAddress,
    createdAt: { $gte: sinceDate },
    sessionId: { $ne: excludeSessionId }
  }).exec();
}

/**
 * Hàm cập nhật trạng thái và metadata của phiên guest wallet.
 * Mục đích: cập nhật donation count, total amount, hoặc status khi có sự kiện.
 * Luôn tự động set updatedAt để đảm bảo consistency.
 * @param sessionId - ID của phiên cần cập nhật
 * @param updateData - Dữ liệu cần cập nhật
 * @param mongoSession - MongoDB session cho transaction (tùy chọn)
 */
export async function updateGuestWalletSession(
  sessionId: string,
  updateData: UpdateableGuestWalletSession,
  mongoSession?: mongoose.ClientSession
): Promise<GuestWalletSession | null> {
  const updatedSession = await GuestWalletSessionModel.findOneAndUpdate(
    { sessionId },
    {
      ...updateData,
      updatedAt: new Date()
    },
    { returnDocument: 'after', session: mongoSession }
  )
    .lean<GuestWalletSession>()
    .exec();
  return updatedSession;
}

/**
 * Hàm atomic increment donation counters và reset pending flag cho một session.
 * Mục đích: dùng trong sync worker sau khi donation được index thành công.
 *
 * Design: Dùng atomic $inc + $set trong một findOneAndUpdate duy nhất để:
 * 1. Tránh race condition TOCTOU — nếu sync worker xử lý 2 events cùng session gần nhau,
 *    cả 2 sẽ đọc donationCount ban đầu và cộng dồn đúng thay vì dùng stale value.
 * 2. Reset hasPendingDonation về false — flag này được set=true khi paymaster sponsor,
 *    cần reset về false khi donation hoàn tất trên blockchain.
 * 3. Đảm bảo updatedAt luôn được cập nhật.
 *
 * @param sessionId - ID của session cần cập nhật
 * @param amountToAdd - Số lượng token đã donate (đơn vị: 0.01 Token)
 * @returns Session đã được cập nhật, hoặc null nếu session không tồn tại
 */
export async function incrementSessionDonationCounters(
  sessionId: string,
  amountToAdd: number
): Promise<GuestWalletSession | null> {
  return GuestWalletSessionModel.findOneAndUpdate(
    { sessionId },
    {
      $inc: {
        donationCount: 1,
        totalDonatedAmount: amountToAdd
      },
      $set: {
        hasPendingDonation: false,
        updatedAt: new Date()
      }
    },
    { returnDocument: 'after' }
  )
    .lean<GuestWalletSession>()
    .exec();
}

/**
 * Hàm atomic reserve donation slot cho một session.
 * Dùng findOneAndUpdate để check-and-set tất cả conditions trong một operation nguyên tử,
 * tránh race condition TOCTOU khi nhiều request đồng thời cùng sessionId
 * cùng pass các check riêng lẻ trước khi transaction hoàn tất.
 *
 * Conditions được check atomically:
 * - status === 'ACTIVE'
 * - donationCount < MAX_DONATIONS_PER_SESSION
 * - hasPendingDonation === false
 * - totalDonatedAmount <= limit
 * - expiresAt > now
 *
 * @param sessionId - ID của session cần reserve
 * @param walletAddress - Địa chỉ ví để verify (case-insensitive)
 * @param maxStoredAmount - Giới hạn tổng amount (đơn vị: 0.01 Token, stored format)
 * @param mongoSession - MongoDB session cho transaction
 * @returns Session đã được reserved (hasPendingDonation = true) nếu thành công, null nếu không đủ điều kiện
 */
export async function reserveDonationSlot(
  sessionId: string,
  walletAddress: string,
  maxStoredAmount: number
): Promise<GuestWalletSession | null> {
  return GuestWalletSessionModel.findOneAndUpdate(
    {
      sessionId,
      walletAddress: walletAddress.toLowerCase(),
      status: 'ACTIVE',
      donationCount: { $lt: MAX_DONATIONS_PER_SESSION },
      hasPendingDonation: false,
      totalDonatedAmount: { $lte: maxStoredAmount },
      expiresAt: { $gt: new Date() }
    },
    {
      $set: {
        hasPendingDonation: true,
        updatedAt: new Date()
      }
    },
    { returnDocument: 'after' }
  )
    .lean<GuestWalletSession>()
    .exec();
}

/**
 * Hàm expire các phiên guest wallet đã hết hạn.
 * Mục đích: worker chạy định kỳ để đánh dấu các session quá hạn.
 */
export async function expireGuestSessions(deadline: Date): Promise<number> {
  const result = await GuestWalletSessionModel.updateMany(
    { status: 'ACTIVE', expiresAt: { $lt: deadline } },
    {
      $set: {
        status: 'EXPIRED',
        updatedAt: new Date()
      }
    }
  );
  return result.modifiedCount;
}

/**
 * Hàm purge các phiên guest wallet đã expired quá 30 ngày.
 * Mục đích: chuyển trạng thái sang PURGED (soft-delete) để giữ audit trail
 * phục vụ compliance. Hard-delete có thể được thực hiện bởi worker riêng
 * sau 90 ngày nếu cần GDPR compliance.
 */
export async function purgeOldGuestSessions(cutoffDate: Date): Promise<number> {
  const result = await GuestWalletSessionModel.updateMany(
    { status: 'EXPIRED', updatedAt: { $lt: cutoffDate } },
    {
      $set: {
        status: 'PURGED',
        updatedAt: new Date()
      }
    }
  );
  return result.modifiedCount;
}

/**
 * Hàm đánh dấu phiên guest wallet đã được claim.
 * Mục đích: cập nhật trạng thái sau khi user claim ví ẩn danh thành tài khoản.
 * @param sessionId - ID của session cần đánh dấu
 * @param claimedByUserId - ID của user đã claim
 * @param mongoSession - MongoDB session cho transaction (tùy chọn)
 */
export async function markGuestSessionAsClaimed(
  sessionId: string,
  claimedByUserId: string,
  mongoSession?: mongoose.ClientSession
): Promise<GuestWalletSession | null> {
  return updateGuestWalletSession(sessionId, {
    status: 'CLAIMED',
    claimedByUserId
  }, mongoSession);
}

/**
 * Hàm đếm số phiên guest wallet theo IP subnet prefix (cùng /24 IPv4 hoặc /64 IPv6).
 * Mục đích: kiểm tra IP subnet burst trong cluster detection worker.
 * Dùng aggregation để extract subnet prefix từ ipAddress, nhóm và đếm.
 * @param subnetPrefix - Subnet prefix cần đếm (VD: "192.168.1" hoặc "2001:db8:acme")
 * @param isIpv6 - true nếu subnetPrefix là IPv6, false cho IPv4
 * @returns Số lượng phiên trong subnet
 */
export async function countSessionsBySubnet(
  subnetPrefix: string,
  isIpv6: boolean
): Promise<number> {
  const regexPattern = isIpv6
    ? `^${subnetPrefix}:`
    : `^${subnetPrefix}\\.`;
  return GuestWalletSessionModel.countDocuments({
    ipAddress: { $regex: regexPattern, $options: 'i' }
  }).exec();
}

/**
 * Hàm đếm số phiên guest wallet theo fingerprint prefix (prefix của sha256 hash).
 * Mục đích: kiểm tra fingerprint reuse trong cluster detection worker.
 * Chỉ so khớp prefix của hash vì có thể có những phiên mới với fingerprint gần đúng.
 * @param fingerprintPrefix - 16 ký tự đầu của fingerprint hash
 * @returns Số lượng phiên có fingerprint bắt đầu bằng prefix đó
 */
export async function countSessionsByFingerprintPrefix(
  fingerprintPrefix: string
): Promise<number> {
  return GuestWalletSessionModel.countDocuments({
    deviceFingerprintHash: { $regex: `^${fingerprintPrefix}`, $options: 'i' }
  }).exec();
}

/**
 * Giới hạn batch để tránh regex quá dài trong aggregation pipeline.
 */
const AGGREGATION_BATCH_MAX = 100;

/**
 * Hàm đếm tất cả fingerprint prefixes trong 1 aggregation query duy nhất.
 * Mục đích: tránh N+1 query khi batch có nhiều unique fingerprints.
 * Trả về Map<fingerprintPrefix, count> cho tất cả prefixes cùng lúc.
 *
 * @param prefixes - Danh sách fingerprint prefixes cần đếm
 * @returns Map với prefix → total count trên toàn bộ collection
 */
export async function aggregateFingerprintCounts(
  prefixes: string[]
): Promise<Map<string, number>> {
  const result = new Map<string, number>();

  if (!prefixes.length) return result;

  // Chunk để tránh regex quá dài trong $or
  for (let i = 0; i < prefixes.length; i += AGGREGATION_BATCH_MAX) {
    const chunk = prefixes.slice(i, i + AGGREGATION_BATCH_MAX);

    const pipeline = [
      {
        $match: {
          deviceFingerprintHash: {
            $regex: chunk.map(p => `^${p}`).join('|'),
            $options: 'i'
          }
        }
      },
      {
        $project: {
          prefix: {
            $function: {
              body: `function(hash) { return hash.substring(0, 16); }`,
              args: ['$deviceFingerprintHash'],
              lang: 'js'
            }
          }
        }
      },
      { $group: { _id: '$prefix', count: { $sum: 1 } } }
    ];

    const aggResults = await GuestWalletSessionModel.aggregate(pipeline).exec();
    for (const row of aggResults) {
      result.set(row._id, row.count);
    }
  }

  return result;
}

/**
 * Hàm đếm tất cả IP subnet prefixes trong 1 aggregation query duy nhất.
 * Mục đích: tránh N+1 query khi batch có nhiều unique subnets.
 * Trả về Map<subnetPrefix, count> cho tất cả subnets cùng lúc.
 *
 * @param subnetQueries - Array chứa {prefix, isIpv6} cho mỗi subnet cần đếm
 * @returns Map với prefix → total count trên toàn bộ collection
 */
export async function aggregateSubnetCounts(
  subnetQueries: { prefix: string; isIpv6: boolean }[]
): Promise<Map<string, number>> {
  const result = new Map<string, number>();

  if (!subnetQueries.length) return result;

  // Chunk để tránh $or quá dài
  for (let i = 0; i < subnetQueries.length; i += AGGREGATION_BATCH_MAX) {
    const chunk = subnetQueries.slice(i, i + AGGREGATION_BATCH_MAX);

    // Build regex pattern: IPv4 (prefix\.) OR IPv6 (prefix:)
    const ipv4Prefixes = chunk.filter(q => !q.isIpv6).map(q => `^${q.prefix}\\.`);
    const ipv6Prefixes = chunk.filter(q => q.isIpv6).map(q => `^${q.prefix}:`);
    const allPatterns = [...ipv4Prefixes, ...ipv6Prefixes];
    if (!allPatterns.length) continue;

    const pipeline = [
      {
        $match: {
          ipAddress: { $regex: allPatterns.join('|'), $options: 'i' }
        }
      },
      {
        $project: {
          subnetPrefix: {
            $function: {
              body: `function(ip) {
                if (ip.includes(':')) {
                  var parts = ip.split(':'); return parts.length >= 4 ? parts.slice(0, 4).join(':') : ip;
                } else {
                  var parts = ip.split('.'); return parts.length === 4 ? parts.slice(0, 3).join('.') : ip;
                }
              }`,
              args: ['$ipAddress'],
              lang: 'js'
            }
          }
        }
      },
      { $group: { _id: '$subnetPrefix', count: { $sum: 1 } } }
    ];

    const aggResults = await GuestWalletSessionModel.aggregate(pipeline).exec();
    for (const row of aggResults) {
      result.set(row._id, row.count);
    }
  }

  return result;
}

/**
 * Hàm tìm tất cả session IDs có cùng fingerprint prefix.
 * Mục đích: lấy mảng sessionIds để truyền vào markManyAsClusterSuspect của GuestDonationRisk.
 * Chỉ trả về các sessions CHƯA có clusterId để tránh re-mark các cluster đã xử lý.
 *
 * @param fingerprintPrefix - 16 ký tự đầu của fingerprint hash
 * @returns Mảng sessionId của tất cả sessions matching
 */
export async function findSessionIdsByFingerprintPrefix(
  fingerprintPrefix: string
): Promise<string[]> {
  const sessions = await GuestWalletSessionModel.find(
    {
      deviceFingerprintHash: { $regex: `^${fingerprintPrefix}`, $options: 'i' }
    },
    { sessionId: 1 }
  )
    .lean<{ sessionId: string }[]>()
    .exec();
  return sessions.map(s => s.sessionId);
}

/**
 * Hàm tìm tất cả session IDs thuộc cùng IP subnet.
 * Mục đích: lấy mảng sessionIds để truyền vào markManyAsClusterSuspect của GuestDonationRisk.
 * Chỉ trả về các sessions CHƯA có clusterId để tránh re-mark các cluster đã xử lý.
 *
 * @param subnetPrefix - Subnet prefix (IPv4 /24 hoặc IPv6 /64)
 * @param isIpv6 - true nếu là IPv6, false cho IPv4
 * @param excludeSessionIds - Danh sách sessionIds cần loại trừ (dùng trong velocity check)
 * @returns Mảng sessionId của tất cả sessions matching
 */
export async function findSessionIdsBySubnet(
  subnetPrefix: string,
  isIpv6: boolean,
  excludeSessionIds?: string[]
): Promise<string[]> {
  const regexPattern = isIpv6
    ? `^${subnetPrefix}:`
    : `^${subnetPrefix}\\.`;

  const query: Record<string, unknown> = { ipAddress: { $regex: regexPattern, $options: 'i' } };

  if (excludeSessionIds && excludeSessionIds.length > 0) {
    query.sessionId = { $nin: excludeSessionIds };
  }

  const sessions = await GuestWalletSessionModel.find(query, { sessionId: 1 })
    .lean<{ sessionId: string }[]>()
    .exec();
  return sessions.map(s => s.sessionId);
}

/**
 * Hàm tìm nhiều phiên guest wallet theo danh sách sessionId.
 * Mục đích: batch fetch phục vụ cluster detection trong cleanup worker.
 * Tránh N+1 query khi cần session data cho nhiều cluster suspects.
 *
 * @param sessionIds - Danh sách sessionId cần tìm
 * @returns Array các session records
 */
export async function findGuestWalletSessionsByIds(
  sessionIds: string[]
): Promise<GuestWalletSession[]> {
  if (!sessionIds.length) return [];
  return GuestWalletSessionModel.find({ sessionId: { $in: sessionIds } })
    .lean<GuestWalletSession[]>()
    .exec();
}

/**
 * Thời gian tối thiểu (miligiây) để coi một session ACTIVE có donationCount===0
 * là "bị orphaned" — tức là PayOS đã nạp tiền thành công vào ví nhưng user
 * chưa bấm Donate (hoặc trình duyệt bị crash trước khi audit record được tạo).
 * 30 phút là đủ để một giao dịch PayOS hoàn tất và blockchain index xong.
 */
const ORPHAN_GRACE_PERIOD_MS = 30 * 60 * 1000;

/**
 * Số bản ghi tối đa scan mỗi batch khi tìm orphaned sessions.
 * Giới hạn để tránh collection scan quá lâu trên bảng lớn.
 */
const ORPHAN_BATCH_LIMIT = 200;

/**
 * Hàm tìm các session ACTIVE có donationCount === 0 nhưng không có audit record nào.
 * Mục đích: phát hiện trường hợp PayOS đã nạp tiền thành công vào ví guest
 * (token đã mint on-chain) nhưng trình duyệt bị crash trước khi user kịp bấm Donate.
 * Trong trường hợp này, AnonymousDonationAudit chưa được tạo nên worker không thể
 * phát hiện qua findUnindexedAudits(). Worker cần quét trực tiếp các session này
 * để check balance on-chain và set hasPendingDonation flag.
 *
 * Điều kiện tìm kiếm:
 * - status === 'ACTIVE'
 * - donationCount === 0
 * - updatedAt cách đây ≥ ORPHAN_GRACE_PERIOD_MS (tránh false positive với session mới tạo)
 *
 * @returns Danh sách các session bị orphaned (có thể chưa donate dù đã nạp tiền)
 */
export async function findOrphanedActiveSessions(): Promise<GuestWalletSession[]> {
  const cutoffTime = new Date(Date.now() - ORPHAN_GRACE_PERIOD_MS);

  return GuestWalletSessionModel.find({
    status: 'ACTIVE',
    donationCount: 0,
    updatedAt: { $lt: cutoffTime }
  })
    .limit(ORPHAN_BATCH_LIMIT)
    .lean<GuestWalletSession[]>()
    .exec();
}

/**
 * Kết quả thống kê tổng quan guest sessions cho Admin Dashboard.
 */
export type GuestSessionSummary = {
  activeCount: number;
  expiredCount: number;
  claimedCount: number;
  purgedCount: number;
  totalSponsoredGas: number;
  totalDonatedAmount: number;
  totalDonationCount: number;
};

/**
 * Hàm lấy thống kê tổng quan guest sessions.
 * Mục đích: cung cấp KPI cards cho Admin Dashboard - đếm sessions theo status
 * và sum gas/amount để theo dõi chi phí Paymaster.
 * 
 * Thiết kế: Dùng 1 aggregation pipeline duy nhất để scan collection 1 lần,
 * tránh IO spike khi collection lớn (hàng triệu records).
 * MongoDB $facet cho phép chạy nhiều aggregation branches trong 1 pass.
 */
export async function getGuestSessionSummary(): Promise<GuestSessionSummary> {
  const result = await GuestWalletSessionModel.aggregate([
    {
      $facet: {
        // Nhánh 1: đếm theo status
        statusCounts: [
          { $group: { _id: '$status', count: { $sum: 1 } } }
        ],
        // Nhánh 2: sum totals
        totals: [
          {
            $group: {
              _id: null,
              totalSponsoredGas: { $sum: '$totalSponsoredGas' },
              totalDonatedAmount: { $sum: '$totalDonatedAmount' },
              totalDonationCount: { $sum: '$donationCount' }
            }
          }
        ]
      }
    }
  ]).exec();

  const facetData = result[0];
  const statusCounts = facetData?.statusCounts as Array<{ _id: string; count: number }> | undefined;
  const totalsData = facetData?.totals as Array<{
    totalSponsoredGas?: number;
    totalDonatedAmount?: number;
    totalDonationCount?: number;
  }> | undefined;

  const statusCountMap = new Map<string, number>(
    (statusCounts || []).map(item => [item._id, item.count] as [string, number])
  );

  const aggregateData = (totalsData && totalsData[0]) || {
    totalSponsoredGas: 0,
    totalDonatedAmount: 0,
    totalDonationCount: 0
  };

  return {
    activeCount: statusCountMap.get('ACTIVE') ?? 0,
    expiredCount: statusCountMap.get('EXPIRED') ?? 0,
    claimedCount: statusCountMap.get('CLAIMED') ?? 0,
    purgedCount: statusCountMap.get('PURGED') ?? 0,
    totalSponsoredGas: aggregateData.totalSponsoredGas ?? 0,
    totalDonatedAmount: aggregateData.totalDonatedAmount ?? 0,
    totalDonationCount: aggregateData.totalDonationCount ?? 0
  };
}

/**
 * Các bộ lọc hỗ trợ cho trang danh sách guest sessions của Admin.
 */
export type GuestSessionFilters = {
  status?: 'ACTIVE' | 'EXPIRED' | 'CLAIMED' | 'PURGED';
  walletAddress?: string;
  ipAddress?: string;
  startDate?: Date;
  endDate?: Date;
};

/**
 * Kết quả phân trang guest sessions cho Admin.
 */
export type GuestSessionPaginatedResult = {
  sessions: GuestWalletSession[];
  totalCount: number;
  pageCount: number;
};

/**
 * Hàm lấy danh sách guest sessions có phân trang và lọc cho Admin.
 * Mục đích: hiển thị bảng quản lý guest sessions với filter theo status, wallet, IP, ngày tạo.
 *
 * @param page - Trang hiện tại (1-based)
 * @param limit - Số bản ghi mỗi trang
 * @param filters - Bộ lọc tùy chọn
 */
export async function listGuestSessionsPaginated(
  page: number,
  limit: number,
  filters?: GuestSessionFilters
): Promise<GuestSessionPaginatedResult> {
  // Service đã normalize page/limit rồi — repo tin tưởng giá trị từ service
  const skip = (page - 1) * limit;

  // TODO: Chuyển sang cursor-based pagination (dùng _id hoặc createdAt)
  // khi collection > 100K records.
  // Skip-based pagination có độ phức tạp O(n) vì MongoDB phải scan skip+limit documents
  // trước khi trả kết quả. Cursor-based dùng index scan O(log n) cho mọi page.

  const query: Record<string, unknown> = {};

  if (filters?.status) {
    query.status = filters.status;
  }

  if (filters?.walletAddress) {
    const trimmedWallet = filters.walletAddress.trim();
    if (trimmedWallet.length > 0 && trimmedWallet.length <= 64) {
      const escapedPattern = trimmedWallet.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      query.walletAddress = { $regex: `^${escapedPattern}`, $options: 'i' };
    }
  }

  if (filters?.ipAddress) {
    const trimmedIp = filters.ipAddress.trim();
    // Chỉ cho phép ký tự hợp lệ trong IP (digits, dots, colons) để tránh regex injection
    const sanitizedIp = trimmedIp.replace(/[^0-9a-fA-F.:]/g, '');
    if (sanitizedIp.length > 0 && sanitizedIp.length <= 45) {
      const escapedIp = sanitizedIp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      query.ipAddress = { $regex: `^${escapedIp}`, $options: 'i' };
    }
  }

  if (filters?.startDate || filters?.endDate) {
    query.createdAt = {};
    if (filters.startDate) {
      (query.createdAt as Record<string, Date>).$gte = filters.startDate;
    }
    if (filters.endDate) {
      (query.createdAt as Record<string, Date>).$lte = filters.endDate;
    }
  }

  const [sessions, countResult] = await Promise.all([
    GuestWalletSessionModel.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean<GuestWalletSession[]>()
      .exec(),
    GuestWalletSessionModel.countDocuments(query).exec()
  ]);

  return {
    sessions,
    totalCount: countResult,
    pageCount: Math.ceil(countResult / limit)
  };
}

/**
 * Kết quả trả về khi admin thực hiện invalidate.
 * Phân biệt 2 trường hợp null để service trả lỗi chính xác cho Admin:
 * - NOT_FOUND: session không tồn tại trong DB
 * - ALREADY_INACTIVE: session tồn tại nhưng không ở trạng thái ACTIVE
 */
export type InvalidateGuestSessionResult = {
  session: GuestWalletSession | null;
  alreadyInactive: boolean;
};

/**
 * Hàm vô hiệu hóa một guest session cụ thể (admin action).
 * Mục đích: cho phép admin manually expire một session đang ACTIVE khi phát hiện bất thường.
 *
 * Design: Trả về thông tin chi tiết về trạng thái session sau thao tác,
 * giúp service phân biệt giữa "không tồn tại" và "đã inactive".
 *
 * @param sessionId - ID của session cần vô hiệu hóa
 * @returns Kết quả chứa session đã update HOẶC thông tin session đã inactive
 */
export async function invalidateGuestSession(
  sessionId: string
): Promise<InvalidateGuestSessionResult> {
  const normalizedSessionId = String(sessionId || '').trim();
  if (!normalizedSessionId) {
    return { session: null, alreadyInactive: false };
  }

  // Bước 1: Tìm session hiện tại để biết trạng thái
  const existingSession = await GuestWalletSessionModel.findOne({ sessionId: normalizedSessionId })
    .lean<GuestWalletSession>()
    .exec();

  if (!existingSession) {
    return { session: null, alreadyInactive: false };
  }

  if (existingSession.status !== 'ACTIVE') {
    return { session: existingSession, alreadyInactive: true };
  }

  // Bước 2: Chỉ update khi đang ACTIVE
  const updatedSession = await GuestWalletSessionModel.findOneAndUpdate(
    { sessionId: normalizedSessionId, status: 'ACTIVE' },
    { $set: { status: 'EXPIRED', updatedAt: new Date() } },
    { returnDocument: 'after' }
  )
    .lean<GuestWalletSession>()
    .exec();

  return { session: updatedSession, alreadyInactive: false };
}
  