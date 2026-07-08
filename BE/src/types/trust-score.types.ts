/**
 * Định nghĩa các kiểu dữ liệu cho hệ thống Trust Score của donor.
 * Mục đích: cung cấp contract type an toàn dùng chung cho service, model, repository và cache layer.
 *
 * Công thức: trustScore = clamp(KYC×0.20 + History×0.30 + Social×0.20 + Age×0.15 + Device×0.15, 0.0, 1.0)
 * Fallback: 0.5 cho donor chưa có đủ dữ liệu (xác nhận theo Q&A Q1 trong qa-task-plan.md).
 */

/** Tên các factor đóng góp vào trust score. */
export type TrustFactorName = 'kyc' | 'donationHistory' | 'socialVerification' | 'accountAge' | 'deviceBinding';

/** Trọng số cố định cho từng factor. Tổng = 1.0. */
export const TRUST_FACTOR_WEIGHTS: Record<TrustFactorName, number> = {
  kyc: 0.20,
  donationHistory: 0.30,
  socialVerification: 0.20,
  accountAge: 0.15,
  deviceBinding: 0.15
};

/** Ngưỡng donations để đạt donationHistoryScore = 1.0. */
export const DONATION_HISTORY_FULL_SCORE_THRESHOLD = 10;

/** Số ngày tối thiểu để đạt accountAgeScore = 1.0. */
export const ACCOUNT_AGE_FULL_SCORE_DAYS = 365;

/** Giá trị trust score fallback cho donor mới chưa có đủ dữ liệu. */
export const TRUST_SCORE_FALLBACK = 0.5;

/**
 * Trạng thái của bản ghi trust score — phân biệt record được tính thật vs fallback.
 * Mục đích: tránh hiển thị nhầm score trung lập 0.5 như badge đã đánh giá cho ví mới / donor chưa có user.
 *
 * - 'active': record được tính từ dữ liệu thật (user + donations).
 * - 'unknown': record được tạo tự động vì donor không tồn tại trong hệ thống.
 *   Score lưu trong DB vẫn là 0.5 để trace/debug, nhưng getTrustScoreForDonor sẽ
 *   trả về score thấp hơn (UNKNOWN_STATUS_SCORE = 0.3) cho caller — giảm Sybil/abuse risk
 *   vì ví mới được đánh giá thấp thay vì trung lập.
 *
 * Frontend / API client NÊN kiểm tra status:
 * - status === 'unknown' → hiển thị "Chưa đánh giá" thay vì badge 0.5.
 * - status === 'active' → hiển thị trustScore như bình thường.
 *
 * Field optional để backward compatible với bản ghi đã persist trước khi có field này (mặc định coi như 'active').
 */
export type TrustScoreStatus = 'active' | 'unknown';

/**
 * Trust score trả về cho donor có status === 'unknown' khi đọc qua getTrustScoreForDonor.
 * Mục đích: giảm Sybil/abuse risk — ví mới hoặc donor chưa xác minh được trả score < 0.5
 * thay vì 0.5 trung lập. Giá trị thấp hơn TRUST_SCORE_FALLBACK để conservatively bias
 * về phía "chưa đáng tin" thay vì "đáng tin trung bình".
 */
export const UNKNOWN_STATUS_SCORE = 0.3;

/**
 * Số lượng social links tối thiểu để socialVerification = true theo spec FR3.
 * Lưu ý: spec yêu cầu "3+ social links" nhưng data model hiện tại (AuthUser.socialAccountId)
 * chỉ lưu 1 trường string đơn, không phải array. Constant này được giữ lại như spec marker
 * để khi nào mở rộng thành collection `socialLinks` riêng, implementation có thể tham khảo.
 * Hiện tại implementation chỉ cần 1 link hợp lệ để verified (deviation có chủ đích).
 */
export const SOCIAL_VERIFICATION_MIN_LINKS = 3;

/**
 * Chi tiết điểm thô (0.0 – 1.0) của từng factor trước khi nhân trọng số.
 * Mục đích: lưu trữ để giải thích breakdown khi truy vấn /trust-score endpoint.
 */
export type TrustFactorBreakdown = {
  /** Điểm KYC: 1.0 nếu accountStatus === 'ACTIVE', else 0.0. */
  kycScore: number;
  /** Điểm lịch sử donation: ≥10 confirmed → 1.0, tuyến tính với count/10 khi < 10. */
  donationHistoryScore: number;
  /** Số donation confirmed thực tế. */
  donationCount: number;
  /** Điểm xác minh mạng xã hội: 1.0 nếu có ≥1 social account được liên kết, else 0.0. */
  socialVerificationScore: number;
  /** Trạng thái xác minh social (true khi socialAccountId hợp lệ và không phải 'none'). */
  isSocialVerified: boolean;
  /** Điểm tuổi tài khoản: tuyến tính min(ageDays/365, 1.0). */
  accountAgeScore: number;
  /** Số ngày tuổi tài khoản ước tính (proxy từ ngày donation đầu tiên hoặc lastLoginAt). */
  accountAgeDays: number;
  /** Điểm device binding: 1.0 nếu có fcmDeviceToken hoặc phoneNumber, else 0.0. */
  deviceBindingScore: number;
  /** Trạng thái binding (true khi có ít nhất 1 device identifier). */
  isDeviceBound: boolean;
};

/**
 * Dữ liệu đầu vào để tính trust score của một donor.
 * Mục đích: tách biệt data-fetching (repository) với logic tính toán (service thuần túy).
 */
export type TrustScoreComputationInput = {
  /** Wallet address của donor (đã lowercase). */
  donorAddress: string;
  /** ID người dùng trong collection users. */
  donorUserId: string;
  /** Trạng thái tài khoản: 'ACTIVE' = đã KYC, 'INACTIVE_PENDING_KYC' = chưa KYC. */
  accountStatus: 'ACTIVE' | 'INACTIVE_PENDING_KYC';
  /** Social account ID từ OAuth. Giá trị 'none' hoặc rỗng = chưa liên kết. */
  socialAccountId: string;
  /** FCM device token cho push notification. null = chưa bind. */
  fcmDeviceToken: string | null;
  /** Số điện thoại. null = chưa bind. */
  phoneNumber: string | null;
  /** Số donation có trạng thái 'INDEXED' của donor. */
  confirmedDonationCount: number;
  /**
   * Ngày proxy để tính tuổi tài khoản.
   * Ưu tiên: ngày donation đầu tiên (nếu có), fallback: lastLoginAt.
   */
  accountAgeProxyDate: Date;
};

/**
 * Kết quả tính toán trust score đầy đủ, sẵn sàng lưu vào collection donor_trust_scores.
 * Mục đích: là output chuẩn của computeTrustScore() và là shape lưu trong DB.
 */
export type DonorTrustScoreRecord = {
  /** UUID duy nhất của bản ghi trust score. */
  trustId: string;
  /** Wallet address của donor (lowercase). */
  donorAddress: string;
  /** UUID tham chiếu đến collection users. */
  donorUserId: string;
  /** Trust score tổng hợp trong khoảng [0.0, 1.0]. */
  trustScore: number;
  /**
   * Trạng thái của record: 'active' (tính từ dữ liệu thật) hoặc 'unknown' (donor không tồn tại).
   * Optional để backward compatible — record cũ không có field được coi như 'active'.
   */
  status?: TrustScoreStatus;
  /** Chi tiết breakdown của từng factor. */
  factorBreakdown: TrustFactorBreakdown;
  /** Thời điểm lần cuối tính lại trust score. */
  lastCalculatedAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Kết quả trả về từ computeTrustScore() — chứa cả score lẫn breakdown để caller quyết định dùng gì.
 * Mục đích: service layer không cần query DB để lấy breakdown sau khi đã tính.
 */
export type TrustScoreComputationResult = {
  /** Trust score cuối cùng đã clamp về [0.0, 1.0]. */
  trustScore: number;
  /** Chi tiết breakdown từng factor. */
  factorBreakdown: TrustFactorBreakdown;
};
