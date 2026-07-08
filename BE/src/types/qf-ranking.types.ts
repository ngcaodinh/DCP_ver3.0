/**
 * Định nghĩa các kiểu dữ liệu cho Trust-Adjusted QF Ranking API.
 * Mục đích: cung cấp contract type an toàn cho service, controller và routes layer.
 *
 * Công thức: trustAdjustedScore = (Σ √(dᵢ × trustᵢ))²
 * Trong đó: dᵢ = donation amount, trustᵢ = trust score của donor.
 */

/** Ngưỡng tier Bronze: score < 0.3. */
export const TIER_BRONZE_MAX = 0.3;

/** Ngưỡng tier Silver: 0.3 <= score < 0.6. Gold: score >= 0.6. */
export const TIER_SILVER_MAX = 0.6;

/** Loại tier badge hiển thị cho donor. */
export type QfTier = 'Bronze' | 'Silver' | 'Gold';

/**
 * Một entry trong bảng xếp hạng QF — đại diện cho một donor đã contribute.
 * Address được mask để bảo vệ privacy.
 */
export interface QfRankingEntry {
  /** Địa chỉ donor đã mask: "0xabcd...1234". */
  donorAddress: string;
  /** Tổng số tiền đã quyên góp (VND). */
  contributionAmount: number;
  /** Trust score của donor (0.0 - 1.0). */
  trustScore: number;
  /** Điểm trust-adjusted: √(amount × trustScore). */
  trustAdjustedMatch: number;
  /** Tier badge: Bronze < 0.3, Silver < 0.6, Gold >= 0.6. */
  tier: QfTier;
}

/**
 * Các chỉ số tổng hợp của project QF.
 */
export interface QfScores {
  /** Tổng điểm QF đã trust-adjust: (Σ √(dᵢ × trustᵢ))². */
  projectTrustAdjustedScore: number;
  /** Điểm QF gốc không nhân trust: (Σ √dᵢ)². */
  originalQfScore: number;
  /** Tổng số donor unique đã contribute. */
  totalDonors: number;
  /** Tổng số donation records đã indexed. */
  totalDonationRecords: number;
}

/**
 * Thông tin về trust scores trong ranking này.
 */
export interface QfTrustFactors {
  /** Trung bình trust score của các donor trong ranking. */
  averageTrustScore: number;
  /** Số donor có record trust score trong DB. */
  donorsWithTrustScore: number;
  /** Số donor dùng fallback trust = 0.5. */
  donorsWithFallback: number;
}

/**
 * Metadata của response — phục vụ pagination và cache info.
 */
export interface QfRankingMetadata {
  /** Project ID được query. */
  projectId: string;
  /** Round ID đã normalize (default | all | YYYY-MM | raw). */
  roundId: string;
  /** Tổng số items trong full ranking. */
  totalItems: number;
  /** Tổng số pages. */
  totalPages: number;
  /** Trang hiện tại (1-based). */
  currentPage: number;
  /** Số items mỗi trang. */
  pageSize: number;
  /** ISO timestamp khi cache được tạo (null nếu không cache). */
  cachedAt: string | null;
  /** Flag cho biết response đến từ cache. */
  cacheHit: boolean;
}

/**
 * Response đầy đủ của GET /rankings/trust-adjusted.
 */
export interface QfRankingResponse {
  /** Danh sách donor đã rank. */
  rankings: QfRankingEntry[];
  /** Các chỉ số tổng hợp của project. */
  scores: QfScores;
  /** Thông tin về trust scores. */
  trustFactors: QfTrustFactors;
  /** Metadata cho pagination. */
  metadata: QfRankingMetadata;
}

/**
 * Input query cho ranking API — validated qua Zod schema.
 */
export interface QfRankingQueryInput {
  /** Project ID bắt buộc. */
  projectId: string;
  /** Round ID optional (default = undefined → 30 days window). */
  roundId?: string;
  /** Số trang (default = 1). */
  page: number;
  /** Số items mỗi trang (default = 20, max = 50). */
  limit: number;
}

/**
 * Dữ liệu donation thô từ MongoDB (map sang kiểu internal).
 */
export interface DonationData {
  donorAddress: string;
  amount: number;
}

/**
 * Hàm gán tier dựa trên trust score.
 * Mục đích: map score number sang tier label.
 *
 * @param trustScore - Trust score của donor (0.0 - 1.0).
 * @returns Tier badge tương ứng.
 */
export function assignTier(trustScore: number): QfTier {
  if (trustScore < TIER_BRONZE_MAX) {
    return 'Bronze';
  }
  if (trustScore < TIER_SILVER_MAX) {
    return 'Silver';
  }
  return 'Gold';
}
