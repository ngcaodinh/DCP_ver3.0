import { v4 as uuidv4 } from 'uuid';
import { getLogger } from '../config/logger';
import { findUserByWalletAddress, type AuthUser } from '../models/authModel';
import { findDonationsByDonorAddress } from '../models/donationModel';
import { getTrustScoreByDonorAddress, saveTrustScore } from '../repositories/donorTrustScoreRepository';
import {
  getTrustScoreCache,
  setTrustScoreCache,
  invalidateTrustScoreCache
} from './trustScoreCacheService';
import {
  ACCOUNT_AGE_FULL_SCORE_DAYS,
  DONATION_HISTORY_FULL_SCORE_THRESHOLD,
  TRUST_FACTOR_WEIGHTS,
  TRUST_SCORE_FALLBACK,
  UNKNOWN_STATUS_SCORE,
  type DonorTrustScoreRecord,
  type TrustFactorBreakdown,
  type TrustScoreComputationInput,
  type TrustScoreComputationResult,
  type TrustScoreStatus
} from '../types/trust-score.types';

const logger = getLogger();

/** Hằng số số mili giây trong một ngày — dùng để tính accountAgeDays. */
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Map lưu Promise đang thực thi recalculate cho mỗi donorAddress.
 * Mục đích: ngăn hai concurrent calls cùng donorAddress ghi đè nhau (last-write-wins race).
 * Single-process mutex — không cần distributed lock vì app chạy 1 Node process.
 * Key = normalizedAddress (lowercase), Value = Promise đang chạy.
 */
const recalculateLockMap = new Map<string, Promise<DonorTrustScoreRecord>>();

/**
 * Hàm clamp giá trị số về khoảng [min, max].
 * Mục đích: đảm bảo trustScore luôn nằm trong [0.0, 1.0] bất kể logic tính toán.
 *
 * @param value - Giá trị cần clamp.
 * @param min - Giới hạn dưới.
 * @param max - Giới hạn trên.
 * @returns Giá trị đã được clamp.
 */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Hàm tính điểm KYC (trọng số 20%).
 * Mục đích: donor có accountStatus === 'ACTIVE' được coi là đã hoàn thành KYC → điểm đầy đủ.
 *
 * @param accountStatus - Trạng thái tài khoản của donor.
 * @returns 1.0 nếu ACTIVE, 0.0 nếu chưa KYC.
 */
function computeKycScore(accountStatus: AuthUser['accountStatus']): number {
  return accountStatus === 'ACTIVE' ? 1.0 : 0.0;
}

/**
 * Hàm tính điểm lịch sử donation (trọng số 30%).
 * Mục đích: donor có ≥10 donations INDEXED đạt điểm đầy đủ, dưới 10 tính tuyến tính.
 *
 * Công thức: min(confirmedDonationCount / THRESHOLD, 1.0)
 *
 * @param confirmedDonationCount - Số donations có trạng thái 'INDEXED'.
 * @returns Điểm trong khoảng [0.0, 1.0].
 */
function computeDonationHistoryScore(confirmedDonationCount: number): number {
  return clamp(confirmedDonationCount / DONATION_HISTORY_FULL_SCORE_THRESHOLD, 0, 1);
}

/**
 * Hàm tính điểm xác minh mạng xã hội (trọng số 20%).
 * Mục đích: donor đã liên kết ít nhất 1 tài khoản OAuth (socialAccountId hợp lệ, khác 'none') được tính verified.
 *
 * Lưu ý: spec nói "3+ social links" nhưng AuthUser chỉ lưu 1 socialAccountId — dùng 1 link là đủ để verified.
 * Nếu cần 3+ trong tương lai, cần thêm collection socialLinks riêng.
 *
 * @param socialAccountId - Social account ID từ OAuth provider.
 * @returns Object chứa điểm và trạng thái verified.
 */
function computeSocialVerificationScore(
  socialAccountId: string
): { socialVerificationScore: number; isSocialVerified: boolean } {
  // Giá trị 'none', rỗng hoặc chỉ chứa khoảng trắng = chưa liên kết social.
  // SPEC GAP FR3: spec yêu cầu "3+ social links" nhưng AuthUser.socialAccountId là 1 trường string đơn,
  // không phải mảng — nên logic hiện tại chỉ cần 1 link hợp lệ để đạt điểm verified. Đây là deviation
  // có chủ đích theo data model hiện tại. Khi model được mở rộng thành collection `socialLinks`,
  // cần thay biểu thức này bằng `count >= 3` để khớp spec gốc.
  const isSocialVerified =
    Boolean(socialAccountId) &&
    socialAccountId.trim() !== '' &&
    socialAccountId.toLowerCase() !== 'none';

  return {
    socialVerificationScore: isSocialVerified ? 1.0 : 0.0,
    isSocialVerified
  };
}

/**
 * Hàm tính điểm tuổi tài khoản (trọng số 15%).
 * Mục đích: donor có tài khoản càng lâu càng đáng tin cậy. Đạt điểm đầy đủ sau 365 ngày.
 *
 * Công thức: min(ageDays / ACCOUNT_AGE_FULL_SCORE_DAYS, 1.0)
 *
 * @param accountAgeProxyDate - Ngày proxy để ước tính tuổi tài khoản
 *                              (ưu tiên ngày donation đầu tiên, fallback lastLoginAt).
 * @returns Object chứa điểm và số ngày tuổi ước tính.
 */
function computeAccountAgeScore(
  accountAgeProxyDate: Date
): { accountAgeScore: number; accountAgeDays: number } {
  const rawTimestamp = accountAgeProxyDate.getTime();

  // Guard Invalid Date — getTime() trả NaN nếu date không hợp lệ; fallback về 0 để tránh poison score.
  if (!Number.isFinite(rawTimestamp)) {
    return { accountAgeScore: 0, accountAgeDays: 0 };
  }

  const accountAgeDays = Math.floor((Date.now() - rawTimestamp) / MILLISECONDS_PER_DAY);

  // Clamp về [0, ∞) trước khi tính tỉ lệ — bảo vệ trường hợp date trong tương lai
  const normalizedAgeDays = Math.max(0, accountAgeDays);
  const accountAgeScore = clamp(normalizedAgeDays / ACCOUNT_AGE_FULL_SCORE_DAYS, 0, 1);

  return { accountAgeScore, accountAgeDays: normalizedAgeDays };
}

/**
 * Hàm tính điểm device binding (trọng số 15%).
 * Mục đích: donor đã bind ít nhất 1 device identifier (FCM token hoặc số điện thoại) được tính đủ điểm.
 *
 * @param fcmDeviceToken - FCM push notification token. null = chưa bind.
 * @param phoneNumber - Số điện thoại đã verify. null = chưa bind.
 * @returns Object chứa điểm và trạng thái binding.
 */
function computeDeviceBindingScore(
  fcmDeviceToken: string | null,
  phoneNumber: string | null
): { deviceBindingScore: number; isDeviceBound: boolean } {
  const isDeviceBound = fcmDeviceToken !== null || phoneNumber !== null;
  return {
    deviceBindingScore: isDeviceBound ? 1.0 : 0.0,
    isDeviceBound
  };
}

/**
 * Hàm tính trust score thuần túy từ input đã chuẩn bị.
 * Mục đích: pure function không có side-effect — dễ test và tái sử dụng.
 *
 * Công thức:
 *   trustScore = clamp(
 *     KYC×0.20 + History×0.30 + Social×0.20 + Age×0.15 + Device×0.15,
 *     0.0, 1.0
 *   )
 *
 * @param input - Dữ liệu đầu vào đã được fetch và normalize từ các collections liên quan.
 * @returns Kết quả trust score và breakdown chi tiết.
 */
export function computeTrustScore(input: TrustScoreComputationInput): TrustScoreComputationResult {
  const kycScore = computeKycScore(input.accountStatus);
  const donationHistoryScore = computeDonationHistoryScore(input.confirmedDonationCount);
  const { socialVerificationScore, isSocialVerified } = computeSocialVerificationScore(
    input.socialAccountId
  );
  const { accountAgeScore, accountAgeDays } = computeAccountAgeScore(input.accountAgeProxyDate);
  const { deviceBindingScore, isDeviceBound } = computeDeviceBindingScore(
    input.fcmDeviceToken,
    input.phoneNumber
  );

  // Tổng hợp trust score bằng cách nhân từng factor với trọng số tương ứng
  const rawTrustScore =
    kycScore * TRUST_FACTOR_WEIGHTS.kyc +
    donationHistoryScore * TRUST_FACTOR_WEIGHTS.donationHistory +
    socialVerificationScore * TRUST_FACTOR_WEIGHTS.socialVerification +
    accountAgeScore * TRUST_FACTOR_WEIGHTS.accountAge +
    deviceBindingScore * TRUST_FACTOR_WEIGHTS.deviceBinding;

  const trustScore = clamp(rawTrustScore, 0.0, 1.0);

  const factorBreakdown: TrustFactorBreakdown = {
    kycScore,
    donationHistoryScore,
    donationCount: input.confirmedDonationCount,
    socialVerificationScore,
    isSocialVerified,
    accountAgeScore,
    accountAgeDays,
    deviceBindingScore,
    isDeviceBound
  };

  return { trustScore, factorBreakdown };
}

/**
 * Hàm nội bộ thực hiện logic recalculate thực sự.
 * Mục đích: orchestrate việc fetch user + donations → normalize input → computeTrustScore → persist.
 * Được gọi bởi recalculateTrustScoreForDonor sau khi đã giữ lock per-donor.
 *
 * Nếu donor không tồn tại trong hệ thống → trả về TRUST_SCORE_FALLBACK (0.5).
 * Đây là fallback "partial trust" theo Q&A Q1 trong qa-task-plan.md.
 *
 * @param normalizedAddress - Wallet address đã lowercase.
 * @returns Bản ghi trust score đã persist.
 */
async function doRecalculateTrustScoreForDonor(
  normalizedAddress: string
): Promise<DonorTrustScoreRecord> {

  const user = await findUserByWalletAddress(normalizedAddress);

  // Donor không tồn tại trong hệ thống → tạo bản ghi fallback với trust = 0.5
  if (!user) {
    logger.warn('Donor không tồn tại khi tính trust score — dùng fallback.', {
      donorAddress: normalizedAddress
    });

    const existingRecord = await getTrustScoreByDonorAddress(normalizedAddress);
    const now = new Date();

    // Nếu đã có bản ghi cũ → giữ nguyên, không overwrite với fallback
    if (existingRecord) {
      return existingRecord;
    }

    // Tạo bản ghi fallback mới cho địa chỉ chưa từng tính
    // Đánh dấu status='unknown' để frontend phân biệt "chưa đánh giá" với score trung lập 0.5 thật sự.
    // Risk nếu KHÔNG có status: ví mới / Sybil được gán 0.5 trông giống "medium trust" thật,
    // và record sẽ giữ 0.5 mãi mãi nếu user không bao giờ tồn tại → stale score gây hiểu nhầm.
    const fallbackRecord: DonorTrustScoreRecord = {
      trustId: uuidv4(),
      donorAddress: normalizedAddress,
      donorUserId: 'unknown',
      trustScore: TRUST_SCORE_FALLBACK,
      status: 'unknown',
      factorBreakdown: {
        kycScore: 0,
        donationHistoryScore: 0,
        donationCount: 0,
        socialVerificationScore: 0,
        isSocialVerified: false,
        accountAgeScore: 0,
        accountAgeDays: 0,
        deviceBindingScore: 0,
        isDeviceBound: false
      },
      lastCalculatedAt: now,
      createdAt: now,
      updatedAt: now
    };

    return saveTrustScore(fallbackRecord);
  }

  // Lấy lịch sử donations của donor — chỉ đếm INDEXED (đã confirmed on-chain)
  const donations = await findDonationsByDonorAddress(normalizedAddress);
  const confirmedDonations = donations.filter(donation => donation.donationStatus === 'INDEXED');
  const confirmedDonationCount = confirmedDonations.length;

  // Tính proxy ngày tạo tài khoản: dùng ngày donation đầu tiên nếu có, fallback lastLoginAt.
  // Dùng reduce để tìm timestamp nhỏ nhất — không phụ thuộc vào thứ tự sort từ repository.
  const oldestDonationDate =
    confirmedDonations.length > 0
      ? confirmedDonations.reduce(
          (oldest, donation) => (donation.timestamp < oldest ? donation.timestamp : oldest),
          confirmedDonations[0].timestamp
        )
      : null;

  const accountAgeProxyDate = oldestDonationDate ?? user.lastLoginAt ?? new Date(0);

  // Lấy bản ghi hiện có trước khi tính toán — tránh query thứ 2 sau khi đã compute.
  const existingRecord = await getTrustScoreByDonorAddress(normalizedAddress);

  const input: TrustScoreComputationInput = {
    donorAddress: normalizedAddress,
    donorUserId: user.id,
    accountStatus: user.accountStatus,
    socialAccountId: user.socialAccountId,
    fcmDeviceToken: user.fcmDeviceToken,
    phoneNumber: user.phoneNumber,
    confirmedDonationCount,
    accountAgeProxyDate
  };

  const { trustScore, factorBreakdown } = computeTrustScore(input);

  const now = new Date();

  const record: DonorTrustScoreRecord = {
    trustId: existingRecord?.trustId ?? uuidv4(),
    donorAddress: normalizedAddress,
    donorUserId: user.id,
    trustScore,
    status: 'active',
    factorBreakdown,
    lastCalculatedAt: now,
    createdAt: existingRecord?.createdAt ?? now,
    updatedAt: now
  };

  // Invalidate cache TRƯỚC khi save — tránh window stale nếu throw giữa saveTrustScore và invalidate.
  // Cache miss sau invalidate sẽ fallback DB đọc giá trị mới hoặc trả TRUST_SCORE_FALLBACK (0.5).
  await invalidateTrustScoreCache(normalizedAddress);

  const savedRecord = await saveTrustScore(record);

  logger.info('Trust score đã được tính lại thành công.', {
    donorAddress: normalizedAddress,
    trustScore,
    confirmedDonationCount
  });

  return savedRecord;
}

/**
 * Hàm public recalculate trust score cho một donor với per-donor mutex.
 * Mục đích: ngăn hai concurrent calls cùng donorAddress (scheduler + on-demand webhook)
 * chạy song song và gây last-write-wins race. Call thứ hai sẽ chờ call thứ nhất hoàn thành
 * rồi dùng lại kết quả — tránh duplicate compute và upsert chồng chéo.
 *
 * @param donorAddress - Wallet address của donor (case-insensitive).
 * @returns Bản ghi trust score đã persist hoặc fallback nếu donor không có dữ liệu.
 */
export async function recalculateTrustScoreForDonor(
  donorAddress: string
): Promise<DonorTrustScoreRecord> {
  const normalizedAddress = donorAddress.toLowerCase();

  // Nếu đang có job chạy cho address này → chờ và reuse kết quả, không chạy lại.
  const existingLock = recalculateLockMap.get(normalizedAddress);
  if (existingLock) {
    logger.info('Trust score recalculate: chờ job đang chạy cho cùng donor.', {
      donorAddress: normalizedAddress
    });
    return existingLock;
  }

  // Tạo Promise mới, lưu vào map trước khi await để các call song song thấy được.
  const jobPromise = doRecalculateTrustScoreForDonor(normalizedAddress).finally(() => {
    // Xóa lock sau khi job hoàn thành (thành công hoặc lỗi) để lần sau có thể recalc lại.
    recalculateLockMap.delete(normalizedAddress);
  });

  recalculateLockMap.set(normalizedAddress, jobPromise);
  return jobPromise;
}

/**
 * Hàm lấy trust score hiện tại của một donor.
 * Mục đích: cung cấp trust score nhanh từ cache/DB mà không recalculate lại từ đầu.
 * Trả về TRUST_SCORE_FALLBACK (0.5) nếu chưa có bản ghi.
 * Nếu bản ghi có status === 'unknown' (donor không tồn tại trong auth), trả về UNKNOWN_STATUS_SCORE (0.3)
 * thay vì trustScore thực tế — giảm Sybil/abuse risk cho ví chưa xác minh.
 *
 * Luồng xử lý: cache (Redis → in-memory) → DB → fallback. Cache hit trả về trực tiếp,
 * cache miss thì đọc DB rồi backfill vào cache để request kế tiếp không phải query DB.
 *
 * @param donorAddress - Wallet address của donor.
 * @returns Trust score trong khoảng [0.0, 1.0]. Trả UNKNOWN_STATUS_SCORE (0.3) nếu donor không có user.
 */
export async function getTrustScoreForDonor(donorAddress: string): Promise<number> {
  const normalizedAddress = donorAddress.toLowerCase();

  // Hàm tiện ích — chuyển record thành score trả về cho caller.
  // Áp dụng rule "status unknown → trả score thấp" để giảm Sybil risk.
  const resolveScore = (record: DonorTrustScoreRecord): number => {
    if (record.status === 'unknown') {
      return UNKNOWN_STATUS_SCORE;
    }
    return record.trustScore;
  };

  // Thử đọc từ cache trước — cache chứa chuỗi JSON của toàn bộ DonorTrustScoreRecord.
  const cachedPayload = await getTrustScoreCache(normalizedAddress);
  if (cachedPayload) {
    try {
      const cachedRecord = JSON.parse(cachedPayload) as DonorTrustScoreRecord;
      return resolveScore(cachedRecord);
    } catch (error) {
      // Cache bị corrupt (ví dụ schema cũ, payload không phải JSON hợp lệ) — bỏ qua và fallback DB
      logger.warn('Trust score cache payload không hợp lệ — fallback về DB.', {
        errorMessage: (error as Error).message
      });
    }
  }

  // Cache miss — đọc DB rồi backfill cache để request sau không phải query lại.
  const record = await getTrustScoreByDonorAddress(normalizedAddress);
  if (!record) {
    return TRUST_SCORE_FALLBACK;
  }

  await setTrustScoreCache(normalizedAddress, JSON.stringify(record));

  return resolveScore(record);
}

/**
 * Hàm lấy trust score đầy đủ kèm breakdown của một donor.
 * Mục đích: phục vụ endpoint /api/trust-score/:donorAddress (P2) giải thích factors cho frontend.
 * Trả về null nếu donor chưa có bản ghi trust score nào.
 *
 * @param donorAddress - Wallet address của donor.
 * @returns Bản ghi trust score đầy đủ hoặc null.
 */
export async function getTrustScoreDetailForDonor(
  donorAddress: string
): Promise<DonorTrustScoreRecord | null> {
  return getTrustScoreByDonorAddress(donorAddress.toLowerCase());
}
