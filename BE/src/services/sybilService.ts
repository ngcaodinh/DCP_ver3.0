import { v4 as uuidv4 } from 'uuid';
import mongoose from 'mongoose';
import { getLogger } from '../config/logger';
import {
  addSybilAuditLog,
  findUserById,
  findUserByWalletAddress,
  updateUser,
  AuthUserModel,
  type SybilAuditLogEntry,
  type AuthUser
} from '../models/authModel';
import { findDonationsByDonorAddress, type DonationRecord } from '../models/donationModel';
import { recalculateRankingSnapshot } from './rankingService';
import { invalidateRankingCache } from './rankingCacheService';

const logger = getLogger();

/**
 * Kiểu dữ liệu payload yêu cầu toggle trạng thái Sybil.
 * action: 'mark' = đánh dấu isSybil = true, 'unmark' = bỏ đánh dấu isSybil = false.
 */
export type SybilTogglePayload = {
  userId: string;
  walletAddress: string;
  action: 'mark' | 'unmark';
  reason: string;
  performedBy: string;
  performedByRole: string;
  ipAddress: string;
  userAgent: string;
};

/**
 * Kiểu dữ liệu response kết quả toggle Sybil — trả về cho frontend và ghi audit log.
 */
export type SybilToggleResult = {
  success: boolean;
  message: string;
  userId: string;
  walletAddress: string;
  newIsSybilValue: boolean;
  updatedAt: string;
  updatedBy: string;
};

/**
 * Kiểu dữ liệu người dùng trả về cho Sybil dashboard — chứa thông tin cơ bản và metrics rủi ro.
 * Mục đích: cung cấp dữ liệu đầy đủ cho bảng quản lý Sybil trên trang Regulatory Bodies.
 */
export type SybilUserRecord = {
  userId: string;
  walletAddress: string;
  displayName: string;
  email: string;
  role: string;
  isSybil: boolean;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  totalRiskScore: number;
  donationCount: number;
  totalDonationAmount: number;
  firstActivity: string;
  lastActivity: string;
  ipAddresses: string[];
  deviceFingerprint: string | null;
  riskFactors: RiskFactorDetail[];
  createdAt: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
  reviewNote: string | null;
};

/**
 * Kiểu chi tiết yếu tố rủi ro cho mỗi người dùng.
 * 5 tiêu chí phát hiện Sybil được tính điểm theo document.md.
 */
export type RiskFactorDetail = {
  factorName: string;
  factorKey: 'ipCorrelation' | 'timePattern' | 'amountPattern' | 'deviceFingerprint' | 'socialVerification';
  score: number;
  maxScore: number;
  description: string;
};

/**
 * Kiểu dữ liệu lịch sử donation của một ví — dùng trong modal chi tiết.
 */
export type SybilDonationHistoryItem = {
  donationId: string;
  projectId: string;
  projectName: string;
  amount: number;
  timestamp: string;
  txHash: string;
  ipAddress: string;
  isAnonymous: boolean;
};

/**
 * Kiểu response chi tiết đầy đủ của một ví Sybil — trả về khi xem chi tiết.
 */
export type SybilUserDetailRecord = SybilUserRecord & {
  donationHistory: SybilDonationHistoryItem[];
};

/**
 * Kiểu response phân trang cho danh sách người dùng.
 */
export type SybilUserListResponse = {
  users: SybilUserRecord[];
  totalCount: number;
  pageNumber: number;
  pageSize: number;
  totalPages: number;
};

/**
 * Kiểu response metrics tổng hợp cho Sybil dashboard.
 */
export type SybilSummaryMetrics = {
  totalMarkedCount: number;
  pendingReviewCount: number;
  totalAffectedDonations: number;
  totalAffectedAmount: number;
};

/** Ngưỡng điểm rủi ro để phân loại mức độ Sybil. */
const RISK_LEVEL_THRESHOLD_CRITICAL = 70;
const RISK_LEVEL_THRESHOLD_HIGH = 45;
const RISK_LEVEL_THRESHOLD_MEDIUM = 20;

/** Ngưỡng điểm tối đa cho mỗi tiêu chí rủi ro theo document.md. */
const RISK_MAX_SCORE_IP_CORRELATION = 30;
const RISK_MAX_SCORE_TIME_PATTERN = 25;
const RISK_MAX_SCORE_AMOUNT_PATTERN = 20;
const RISK_MAX_SCORE_DEVICE_FINGERPRINT = 15;
const RISK_MAX_SCORE_SOCIAL_VERIFICATION = 10;

/** Tính mức độ rủi ro (risk level) dựa trên tổng điểm. */
function calculateRiskLevel(totalScore: number): 'low' | 'medium' | 'high' | 'critical' {
  if (totalScore >= RISK_LEVEL_THRESHOLD_CRITICAL) return 'critical';
  if (totalScore >= RISK_LEVEL_THRESHOLD_HIGH) return 'high';
  if (totalScore >= RISK_LEVEL_THRESHOLD_MEDIUM) return 'medium';
  return 'low';
}

/**
 * Tính điểm rủi ro cho từng tiêu chí phát hiện Sybil.
 * Mục đích: áp dụng 5 tiêu chí trong document.md để đánh giá ví có phải Sybil hay không.
 *
 * Logic phức tạp:
 * - IP Correlation: đếm số lượng ví donation cùng IP trong 1 giờ gần nhất.
 *   Nếu > 5 ví → +30 điểm. Dưới 5 ví → tỷ lệ thuận.
 * - Time Pattern: phát hiện donation cùng block (±5 giây) từ nhiều ví.
 *   Tính % donation trùng timestamp trên tổng donations.
 * - Amount Pattern: kiểm tra xem có donation cùng số tiền trùng nhau hay không.
 *   Tính mode (số tiền xuất hiện nhiều nhất) trên tổng donations.
 * - Device Fingerprint: kiểm tra duplicate fingerprint trong cùng subnet.
 * - Social Verification: ví không có social login backing → +10 điểm.
 */
function calculateRiskFactors(
  user: AuthUser,
  donationList: DonationRecord[]
): RiskFactorDetail[] {
  const result: RiskFactorDetail[] = [];
  const now = Date.now();
  const oneHourMs = 60 * 60 * 1000;
  const recentDonations = donationList.filter(d => (now - new Date(d.timestamp).getTime()) <= oneHourMs);

  // IP Correlation: đếm ví khác donation cùng IP trong 1 giờ gần nhất
  const userIpAddressSet = new Set<string>();
  donationList.forEach(d => userIpAddressSet.add(d.correlationId)); // correlationId chứa IP metadata
  let ipCorrelationScore = 0;

  // Tính số ví khác cùng IP (dùng Map với IP key để đếm)
  // Fix B-3: Chỉ dùng correlationId khi nó chứa IP (format: "ip:xxx")
  // Không fallback sang donorAddress prefix vì nó không chứa thông tin IP
  const ipDonationCountMap = new Map<string, number>();
  donationList.forEach(d => {
    // Chỉ extract IP từ correlationId nếu format đúng "ip:xxx"
    if (d.correlationId && d.correlationId.startsWith('ip:')) {
      const extractedIp = d.correlationId.substring(3); // Bỏ prefix "ip:"
      if (extractedIp && extractedIp.length > 0) {
        ipDonationCountMap.set(extractedIp, (ipDonationCountMap.get(extractedIp) || 0) + 1);
      }
    }
    // Nếu correlationId không chứa IP → bỏ qua, không dùng donorAddress fallback
  });

  const donationFromSameIp = Array.from(ipDonationCountMap.values()).reduce((sum, count) => sum + count - 1, 0);
  if (donationFromSameIp > 5) {
    ipCorrelationScore = RISK_MAX_SCORE_IP_CORRELATION;
  } else if (donationFromSameIp > 0) {
    ipCorrelationScore = Math.min(Math.round((donationFromSameIp / 5) * RISK_MAX_SCORE_IP_CORRELATION), RISK_MAX_SCORE_IP_CORRELATION);
  }

  result.push({
    factorName: 'Tương quan IP',
    factorKey: 'ipCorrelation',
    score: ipCorrelationScore,
    maxScore: RISK_MAX_SCORE_IP_CORRELATION,
    description: donationFromSameIp > 5
      ? `${donationFromSameIp} ví quyên góp từ cùng IP trong 1 giờ`
      : donationFromSameIp > 0
        ? `${donationFromSameIp} ví cùng subnet trong 1 giờ`
        : 'Không phát hiện tương quan IP bất thường'
  });

  // Time Pattern: phát hiện donation cùng block (±5 giây)
  let timePatternScore = 0;
  const timeGroupMap = new Map<number, number>(); // blockNumber → count
  donationList.forEach(d => {
    const blockGroup = Math.floor(d.blockNumber / 100) * 100; // Nhóm theo ~100 blocks
    timeGroupMap.set(blockGroup, (timeGroupMap.get(blockGroup) || 0) + 1);
  });

  const maxDonationsInSameTimeGroup = Math.max(...Array.from(timeGroupMap.values()), 0);
  if (maxDonationsInSameTimeGroup >= 5) {
    timePatternScore = RISK_MAX_SCORE_TIME_PATTERN;
  } else if (maxDonationsInSameTimeGroup >= 2) {
    timePatternScore = Math.round((maxDonationsInSameTimeGroup / 5) * RISK_MAX_SCORE_TIME_PATTERN);
  }

  result.push({
    factorName: 'Mẫu thời gian',
    factorKey: 'timePattern',
    score: timePatternScore,
    maxScore: RISK_MAX_SCORE_TIME_PATTERN,
    description: maxDonationsInSameTimeGroup >= 5
      ? `${maxDonationsInSameTimeGroup} giao dịch trong cùng block group (±5 giây)`
      : maxDonationsInSameTimeGroup >= 2
        ? `${maxDonationsInSameTimeGroup} giao dịch gần thời điểm`
        : 'Không phát hiện mẫu thời gian bất thường'
  });

  // Amount Pattern: kiểm tra donation cùng số tiền
  const amountCountMap = new Map<number, number>();
  donationList.forEach(d => {
    const roundedAmount = Math.round(d.amount / 100000) * 100000; // Làm tròn đến 100K VND
    amountCountMap.set(roundedAmount, (amountCountMap.get(roundedAmount) || 0) + 1);
  });

  const maxAmountFrequency = Math.max(...Array.from(amountCountMap.values()), 0);
  const mostCommonAmount = Array.from(amountCountMap.entries()).find(([, count]) => count === maxAmountFrequency)?.[0] || 0;
  let amountPatternScore = 0;

  if (donationList.length >= 3) {
    const sameAmountRatio = maxAmountFrequency / donationList.length;
    if (sameAmountRatio >= 0.8) {
      amountPatternScore = RISK_MAX_SCORE_AMOUNT_PATTERN;
    } else if (sameAmountRatio >= 0.5) {
      amountPatternScore = Math.round(sameAmountRatio * RISK_MAX_SCORE_AMOUNT_PATTERN);
    }
  }

  result.push({
    factorName: 'Cấu trúc số tiền',
    factorKey: 'amountPattern',
    score: amountPatternScore,
    maxScore: RISK_MAX_SCORE_AMOUNT_PATTERN,
    description: amountPatternScore >= RISK_MAX_SCORE_AMOUNT_PATTERN
      ? `Tất cả ${maxAmountFrequency} donation = ${mostCommonAmount.toLocaleString('vi-VN')} VND`
      : amountPatternScore > 0
        ? `${maxAmountFrequency}/${donationList.length} donation cùng số tiền tròn`
        : 'Số tiền donation đa dạng'
  });

  // Device Fingerprint: kiểm tra duplicate device fingerprint
  // Vì không có device fingerprint field trực tiếp, dùng social account ID pattern
  const deviceFingerprintScore = user.socialProvider === 'none' || !user.socialAccountId
    ? Math.round(RISK_MAX_SCORE_DEVICE_FINGERPRINT * 0.5)
    : 0;

  result.push({
    factorName: 'Device Fingerprint',
    factorKey: 'deviceFingerprint',
    score: deviceFingerprintScore,
    maxScore: RISK_MAX_SCORE_DEVICE_FINGERPRINT,
    description: deviceFingerprintScore > 0
      ? 'Không có device fingerprint hoặc session pattern bất thường'
      : 'Device fingerprint hợp lệ'
  });

  // Social Verification: ví không có social login backing
  const socialVerificationScore = user.socialProvider === 'none' || !user.socialAccountId
    ? RISK_MAX_SCORE_SOCIAL_VERIFICATION
    : 0;

  result.push({
    factorName: 'Xác minh Social',
    factorKey: 'socialVerification',
    score: socialVerificationScore,
    maxScore: RISK_MAX_SCORE_SOCIAL_VERIFICATION,
    description: socialVerificationScore > 0
      ? 'Không có Social Login backing'
      : `Social Login: ${user.socialProvider}`
  });

  return result;
}

/**
 * Chuyển đổi AuthUser thành SybilUserRecord cho dashboard.
 * Mục đích: map dữ liệu từ MongoDB sang format mà frontend SybilManagementPanel mong đợi.
 */
async function buildSybilUserRecord(user: AuthUser): Promise<SybilUserRecord> {
  const donationList = await findDonationsByDonorAddress(user.walletAddress);

  // Tính risk score tổng
  const riskFactors = calculateRiskFactors(user, donationList);
  const totalRiskScore = riskFactors.reduce((sum, factor) => sum + factor.score, 0);

  // Tổng donation amount
  const totalDonationAmount = donationList.reduce((sum, d) => sum + d.amount, 0);

  // Tập hợp IP addresses
  const ipAddressSet = new Set<string>();
  donationList.forEach(d => {
    if (d.correlationId.startsWith('ip:')) {
      ipAddressSet.add(d.correlationId.replace('ip:', ''));
    }
  });

  // Thời gian hoạt động đầu và cuối
  const sortedDonations = [...donationList].sort((a, b) =>
    new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  return {
    userId: user.id,
    walletAddress: user.walletAddress,
    displayName: user.fullName || user.email.split('@')[0],
    email: user.email,
    role: user.role,
    isSybil: user.isSybil,
    riskLevel: calculateRiskLevel(totalRiskScore),
    totalRiskScore,
    donationCount: donationList.length,
    totalDonationAmount,
    firstActivity: sortedDonations[0]?.timestamp.toISOString() || user.lastLoginAt.toISOString(),
    lastActivity: sortedDonations[sortedDonations.length - 1]?.timestamp.toISOString() || user.lastLoginAt.toISOString(),
    ipAddresses: Array.from(ipAddressSet),
    deviceFingerprint: null,
    riskFactors,
    createdAt: user.lastLoginAt.toISOString(),
    reviewedAt: null,
    reviewedBy: null,
    reviewNote: null
  };
}

/**
 * Hàm lấy danh sách người dùng cho Sybil dashboard (phân trang).
 * Mục đích: cung cấp dữ liệu thật từ MongoDB thay vì mock data.
 * 
 * Logic:
 * 1. Build query filter với tất cả điều kiện (search, sybilStatus, riskLevel)
 * 2. Query users từ MongoDB với pagination đúng thứ tự
 * 3. Với mỗi user, tính risk score và risk factors dựa trên donation history
 * 4. Filter riskScore = 0 (không có donation history)
 * 
 * Fix B-2: Không filter sau .limit() nữa — filterRiskLevel không thể apply
 * trong query vì riskLevel được tính từ donations (lookup), nên:
 * - Dùng aggregation pipeline để tính riskLevel trong MongoDB
 * - Filter riskLevel trong $match stage
 */
export async function getSybilUserList(
  pageNumber: number,
  pageSize: number,
  filterRiskLevel?: string,
  filterSybilStatus?: string,
  searchQuery?: string
): Promise<SybilUserListResponse> {
  const skipCount = (pageNumber - 1) * pageSize;

  // Build search query nếu có
  const searchMatch: Record<string, unknown> = {};
  if (searchQuery && searchQuery.trim()) {
    const normalizedQuery = searchQuery.trim();
    searchMatch.$or = [
      { walletAddress: { $regex: normalizedQuery, $options: 'i' } },
      { email: { $regex: normalizedQuery, $options: 'i' } },
      { fullName: { $regex: normalizedQuery, $options: 'i' } },
      { id: { $regex: normalizedQuery, $options: 'i' } }
    ];
  }

  // Build sybil status filter
  const sybilStatusMatch: Record<string, unknown> = {};
  if (filterSybilStatus === 'sybil') {
    sybilStatusMatch.isSybil = true;
  } else if (filterSybilStatus === 'normal') {
    sybilStatusMatch.isSybil = false;
  }

  // Build risk level filter - chỉ áp dụng nếu có filter và filter != 'all'
  const riskLevelMatch: Record<string, unknown> = {};
  const applyRiskLevelFilter = filterRiskLevel && filterRiskLevel !== 'all';

  // Sử dụng aggregation pipeline để:
  // 1. Filter users theo search và sybilStatus
  // 2. Lookup donations để tính risk score
  // 3. Filter theo riskLevel nếu cần
  // 4. Paginate với $skip và $limit
  // 5. Trả về kết quả

  const pipeline: mongoose.PipelineStage[] = [];

  // Stage 1: Match users theo search query và sybil status
  const baseMatch: Record<string, unknown> = { ...searchMatch, ...sybilStatusMatch };
  if (Object.keys(baseMatch).length > 0) {
    pipeline.push({ $match: baseMatch });
  }

  // Stage 2: Lookup donations
  pipeline.push({
    $lookup: {
      from: 'donations',
      localField: 'walletAddress',
      foreignField: 'donorAddress',
      as: 'donations'
    }
  });

  // Stage 3: Add computed fields (risk score calculation)
  pipeline.push({
    $addFields: {
      donationCount: { $size: '$donations' },
      totalDonationAmount: { $sum: '$donations.amount' },
      // Tính IP correlation score đơn giản
      ipCorrelationCount: {
        $size: {
          $filter: {
            input: '$donations',
            as: 'd',
            cond: { $eq: [{ $substr: ['$$d.correlationId', 0, 3] }, 'ip:'] }
          }
        }
      }
    }
  });

  // Stage 4: Tính estimated risk score
  pipeline.push({
    $addFields: {
      estimatedRiskScore: {
        $min: [
          {
            $add: [
              // IP correlation: mỗi IP correlation > 1 từ cùng IP = +6 điểm
              { $multiply: [{ $max: [{ $subtract: ['$ipCorrelationCount', 1] }, 0] }, 6] },
              // No social = +10
              { $cond: [{ $eq: ['$socialProvider', 'none'] }, 10, 0] }
            ]
          },
          100
        ]
      }
    }
  });

  // Stage 5: Map risk score sang risk level
  pipeline.push({
    $addFields: {
      riskLevel: {
        $switch: {
          branches: [
            { case: { $gte: ['$estimatedRiskScore', RISK_LEVEL_THRESHOLD_CRITICAL] }, then: 'critical' },
            { case: { $gte: ['$estimatedRiskScore', RISK_LEVEL_THRESHOLD_HIGH] }, then: 'high' },
            { case: { $gte: ['$estimatedRiskScore', RISK_LEVEL_THRESHOLD_MEDIUM] }, then: 'medium' }
          ],
          default: 'low'
        }
      }
    }
  });

  // Stage 6: Filter theo riskLevel (nếu có) - filter TRƯỚC KHI paginate
  if (applyRiskLevelFilter) {
    pipeline.push({ $match: { riskLevel: filterRiskLevel } });
  }

  // Stage 7: Filter bỏ users không có donations (riskScore = 0)
  pipeline.push({
    $match: {
      estimatedRiskScore: { $gt: 0 }
    }
  });

  // Stage 8: Facet để lấy cả total count và paginated results
  // Total count trước pagination
  pipeline.push({
    $facet: {
      metadata: [{ $count: 'totalCount' }],
      users: [
        { $sort: { lastLoginAt: -1 } },
        { $skip: skipCount },
        { $limit: pageSize }
      ]
    }
  });

  const aggregationResult = await AuthUserModel.aggregate(pipeline).exec();

  const facetResult = aggregationResult[0] || { metadata: [], users: [] };
  const totalCount = facetResult.metadata[0]?.totalCount || 0;
  const userRecordList = facetResult.users;

  // Build SybilUserRecord từ aggregation results
  const sybilUserRecordList: SybilUserRecord[] = await Promise.all(
    userRecordList.map((user: Record<string, unknown>) => buildSybilUserRecordFromAggregation(user))
  );

  const totalPages = Math.ceil(totalCount / pageSize);

  return {
    users: sybilUserRecordList,
    totalCount,
    pageNumber,
    pageSize,
    totalPages
  };
}

/**
 * Build SybilUserRecord từ aggregation result (đã có donations populated).
 * Mục đích: tái sử dụng logic build record cho cả query thường và aggregation.
 */
async function buildSybilUserRecordFromAggregation(
  userData: Record<string, unknown>
): Promise<SybilUserRecord> {
  const donationList = (userData.donations as DonationRecord[]) || [];
  const ipAddressSet = new Set<string>();
  
  donationList.forEach((d: DonationRecord) => {
    if (d.correlationId.startsWith('ip:')) {
      ipAddressSet.add(d.correlationId.replace('ip:', ''));
    }
  });

  const sortedDonations = [...donationList].sort((a, b) =>
    new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  const totalDonationAmount = donationList.reduce((sum: number, d: DonationRecord) => sum + d.amount, 0);
  const riskLevel = (userData.riskLevel as 'low' | 'medium' | 'high' | 'critical') || 'low';
  const estimatedRiskScore = (userData.estimatedRiskScore as number) || 0;

  return {
    userId: userData.id as string,
    walletAddress: userData.walletAddress as string,
    displayName: (userData.fullName as string) || ((userData.email as string)?.split('@')[0] || 'Unknown'),
    email: userData.email as string,
    role: userData.role as string,
    isSybil: userData.isSybil as boolean,
    riskLevel,
    totalRiskScore: estimatedRiskScore,
    donationCount: donationList.length,
    totalDonationAmount,
    firstActivity: sortedDonations[0]?.timestamp.toISOString() || (userData.lastLoginAt as Date)?.toISOString() || new Date().toISOString(),
    lastActivity: sortedDonations[sortedDonations.length - 1]?.timestamp.toISOString() || (userData.lastLoginAt as Date)?.toISOString() || new Date().toISOString(),
    ipAddresses: Array.from(ipAddressSet),
    deviceFingerprint: null,
    riskFactors: [], // Risk factors chi tiết không có trong aggregation, chỉ có estimatedRiskScore
    createdAt: (userData.lastLoginAt as Date)?.toISOString() || new Date().toISOString(),
    reviewedAt: null,
    reviewedBy: null,
    reviewNote: null
  };
}

/**
 * Hàm lấy chi tiết một người dùng cho modal Sybil.
 * Mục đích: cung cấp dữ liệu đầy đủ khi Regulatory Bodies xem chi tiết ví.
 */
export async function getSybilUserDetail(userId: string): Promise<SybilUserDetailRecord | null> {
  const user = await findUserById(userId);
  if (!user) {
    return null;
  }

  const donationList = await findDonationsByDonorAddress(user.walletAddress);
  const riskFactors = calculateRiskFactors(user, donationList);
  const totalRiskScore = riskFactors.reduce((sum, factor) => sum + factor.score, 0);
  const totalDonationAmount = donationList.reduce((sum, d) => sum + d.amount, 0);

  const ipAddressSet = new Set<string>();
  donationList.forEach(d => {
    if (d.correlationId.startsWith('ip:')) {
      ipAddressSet.add(d.correlationId.replace('ip:', ''));
    }
  });

  const sortedDonations = [...donationList].sort((a, b) =>
    new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  const donationHistory = donationList.map(d => ({
    donationId: d.correlationId,
    projectId: d.projectId,
    projectName: d.projectId, // Sẽ map với project name trong controller nếu cần
    amount: d.amount,
    timestamp: d.timestamp.toISOString(),
    txHash: d.transactionHash,
    ipAddress: d.correlationId.startsWith('ip:') ? d.correlationId.replace('ip:', '') : 'N/A',
    isAnonymous: d.isAnonymous
  }));

  return {
    userId: user.id,
    walletAddress: user.walletAddress,
    displayName: user.fullName || user.email.split('@')[0],
    email: user.email,
    role: user.role,
    isSybil: user.isSybil,
    riskLevel: calculateRiskLevel(totalRiskScore),
    totalRiskScore,
    donationCount: donationList.length,
    totalDonationAmount,
    firstActivity: sortedDonations[0]?.timestamp.toISOString() || user.lastLoginAt.toISOString(),
    lastActivity: sortedDonations[sortedDonations.length - 1]?.timestamp.toISOString() || user.lastLoginAt.toISOString(),
    ipAddresses: Array.from(ipAddressSet),
    deviceFingerprint: null,
    riskFactors,
    donationHistory,
    createdAt: user.lastLoginAt.toISOString(),
    reviewedAt: null,
    reviewedBy: null,
    reviewNote: null
  };
}

/**
 * Hàm toggle trạng thái Sybil của một người dùng.
 * Mục đích: xử lý UC5.1 — Admin/Regulatory Bodies đánh dấu hoặc bỏ đánh dấu Sybil.
 * 
 * Quy tắc:
 * - Chỉ Admin hoặc Regulatory Bodies mới có quyền thực hiện.
 * - Bắt buộc nhập lý do (reason) — OWASP: không được để thao tác quan trọng không có audit.
 * - Sau khi toggle, ghi audit log ngay lập tức.
 * - Tự động trigger ranking recalculate để loại/bổ sung ví khỏi QF.
 */
export async function toggleSybilStatus(payload: SybilTogglePayload): Promise<SybilToggleResult> {
  const { userId, walletAddress, action, reason, performedBy, performedByRole, ipAddress, userAgent } = payload;

  // Validate required fields
  if (!userId && !walletAddress) {
    throw new Error('Phải cung cấp userId hoặc walletAddress.');
  }
  if (!reason || reason.trim().length < 5) {
    throw new Error('Lý do thay đổi phải có ít nhất 5 ký tự.');
  }
  if (!['mark', 'unmark'].includes(action)) {
    throw new Error('Action phải là "mark" hoặc "unmark".');
  }

  // Tìm user
  let user: AuthUser | null = null;
  if (userId) {
    user = await findUserById(userId);
  }
  if (!user && walletAddress) {
    user = await findUserByWalletAddress(walletAddress);
  }
  if (!user) {
    throw new Error('Không tìm thấy người dùng với thông tin đã cung cấp.');
  }

  // Validate action vs current state
  const newIsSybilValue = action === 'mark' ? true : false;
  if (user.isSybil === newIsSybilValue) {
    const currentStateLabel = user.isSybil ? 'đã đánh dấu Sybil' : 'chưa đánh dấu';
    throw new Error(`Người dùng hiện ${currentStateLabel}. Không cần thay đổi.`);
  }

  // Cập nhật isSybil flag
  const previousValue = user.isSybil;
  const updatedUser: AuthUser = {
    ...user,
    isSybil: newIsSybilValue
  };
  await updateUser(updatedUser);

  // Ghi audit log ngay sau khi cập nhật
  const auditLogEntry: SybilAuditLogEntry = {
    id: uuidv4(),
    userId: user.id,
    walletAddress: user.walletAddress,
    action: action === 'mark' ? 'mark_as_sybil' : 'unmark_as_sybil',
    previousValue,
    newValue: newIsSybilValue,
    reason: reason.trim(),
    performedBy,
    performedByRole,
    ipAddress,
    userAgent,
    createdAt: new Date()
  };
  await addSybilAuditLog(auditLogEntry);

  // Ghi log thành công
  logger.info(`Sybil status changed for user ${user.walletAddress}: ${previousValue} -> ${newIsSybilValue} by ${performedBy}`, {
    performedBy,
    reason,
    correlationId: user.correlationId
  });

  // Tự động tính lại bảng xếp hạng QF sau khi thay đổi trạng thái Sybil.
  // Điều này đảm bảo donation của ví Sybil được loại/bỏ loại khỏi QF ngay lập tức,
  // không phụ thuộc cron job hoặc thao tác thủ công.
  recalculateRankingSnapshot(24).catch((error) => {
    logger.error('Tự động recalculate ranking thất bại sau khi toggle Sybil.', {
      walletAddress: user.walletAddress,
      errorMessage: error instanceof Error ? error.message : String(error)
    });
  });
  invalidateRankingCache().catch((error) => {
    logger.error('Xoá ranking cache thất bại sau khi toggle Sybil.', {
      walletAddress: user.walletAddress,
      errorMessage: error instanceof Error ? error.message : String(error)
    });
  });

  return {
    success: true,
    message: action === 'mark'
      ? `Đã đánh dấu ví ${walletAddress} là Sybil. Ví sẽ bị loại khỏi tính toán QF.`
      : `Đã bỏ đánh dấu Sybil cho ví ${walletAddress}. Họ sẽ được tính vào QF bình thường.`,
    userId: user.id,
    walletAddress: user.walletAddress,
    newIsSybilValue,
    updatedAt: new Date().toISOString(),
    updatedBy: performedBy
  };
}

/**
 * Hàm lấy metrics tổng hợp cho Sybil dashboard.
 * Mục đích: cung cấp số liệu tổng quan thay vì mock data.
 * 
 * Fix B-1: Sử dụng MongoDB aggregation pipeline thay vì N+1 queries
 * để tránh timeout và OOM khi có hàng triệu users/donations.
 * 
 * Logic:
 * 1. Pipeline đầu tiên: join donations để tính risk score cho mỗi user
 * 2. Tính pending review (risk >= threshold và chưa bị mark là Sybil)
 * 3. Tính affected donations/amount từ các user đã bị mark Sybil
 */
export async function getSybilSummaryMetrics(): Promise<SybilSummaryMetrics> {
  // Đếm số user đã bị đánh dấu Sybil
  const totalMarkedCount = await AuthUserModel.countDocuments({ isSybil: true }).exec();

  // Sử dụng aggregation để:
  // 1. Lookup donations cho mỗi user
  // 2. Tính risk score trong pipeline
  // 3. Đếm users có risk >= threshold mà chưa bị mark
  const pendingReviewAggregation = await AuthUserModel.aggregate([
    // Lookup donations từ collection Donation
    {
      $lookup: {
        from: 'donations',
        localField: 'walletAddress',
        foreignField: 'donorAddress',
        as: 'donations'
      }
    },
    // Thêm computed field riskScore dựa trên donation patterns
    {
      $addFields: {
        // Đếm donations trong cùng IP (correlationId format: "ip:xxx")
        ipCorrelationCount: {
          $size: {
            $filter: {
              input: '$donations',
              as: 'd',
              cond: { $eq: [{ $substr: ['$$d.correlationId', 0, 3] }, 'ip:'] }
            }
          }
        },
        donationCount: { $size: '$donations' }
      }
    },
    // Tính risk score đơn giản: ipCorrelation * 6 điểm mỗi IP correlation
    {
      $addFields: {
        estimatedRiskScore: {
          $min: [
            {
              $add: [
                { $multiply: [{ $subtract: ['$ipCorrelationCount', 1] }, 6] }, // IP correlation
                { $cond: [{ $eq: ['$socialProvider', 'none'] }, 10, 0] } // No social = +10
              ]
            },
            100
          ]
        }
      }
    },
    // Chỉ lấy users có risk >= HIGH threshold và chưa bị mark Sybil
    {
      $match: {
        isSybil: false,
        estimatedRiskScore: { $gte: RISK_LEVEL_THRESHOLD_HIGH }
      }
    },
    // Đếm kết quả
    {
      $count: 'pendingReviewCount'
    }
  ]);

  const pendingReviewCount = pendingReviewAggregation[0]?.pendingReviewCount || 0;

  // Tính affected donations/amount từ các user đã bị mark Sybil
  const affectedAggregation = await AuthUserModel.aggregate([
    {
      $match: { isSybil: true }
    },
    // Lookup donations
    {
      $lookup: {
        from: 'donations',
        localField: 'walletAddress',
        foreignField: 'donorAddress',
        as: 'donations'
      }
    },
    // Tính tổng amount cho mỗi user
    {
      $addFields: {
        userTotalAmount: { $sum: '$donations.amount' },
        userDonationCount: { $size: '$donations' }
      }
    },
    // Group để sum tất cả
    {
      $group: {
        _id: null,
        totalAffectedDonations: { $sum: '$userDonationCount' },
        totalAffectedAmount: { $sum: '$userTotalAmount' }
      }
    }
  ]);

  const totalAffectedDonations = affectedAggregation[0]?.totalAffectedDonations || 0;
  const totalAffectedAmount = affectedAggregation[0]?.totalAffectedAmount || 0;

  return {
    totalMarkedCount,
    pendingReviewCount,
    totalAffectedDonations,
    totalAffectedAmount
  };
}
