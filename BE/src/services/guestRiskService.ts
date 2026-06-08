/**
 * Service đánh giá risk score cho guest wallet sessions — tách biệt khỏi HTTP layer.
 * Được gọi tại thời điểm tạo session (initial assessment) và trước mỗi Paymaster sponsorship.
 *
 * Risk scoring rules (FR5.G):
 * - Wallet Age: counterfactual (not deployed) → +20
 * - IP Burst: ≥3 sessions/IP/1h → +30
 * - Fingerprint Reuse: ≥3 sessions/fingerprint/24h → +25
 * - Donation Pattern: all donations same amount → +15
 * - Session Velocity: session created <60s after previous → +10
 *
 * Dependency direction:
 * guestRiskService → guestDonationRiskRepository (data access)
 * guestRiskService → guestWalletSessionRepository (data access, read-only for re-evaluation)
 * guestRiskService → anonymousDonationAuditRepository (data access)
 * guestRiskService → blockchainProvider (external RPC)
 *
 * IMPORTANT: guestRiskService must NOT import from guestSessionService
 * to avoid circular dependency. Keep business logic in service layer,
 * orchestration in session layer.
 */
import { ethers } from 'ethers';
import { getLogger } from '../config/logger';
import { GuestWalletSession } from '../models/guestWalletSessionModel';
import { GuestDonationRisk, RiskLevel } from '../models/guestDonationRiskModel';
import { ApplicationError } from '../utils/applicationError';
import {
  findGuestDonationRiskBySessionId,
  upsertGuestDonationRisk
} from '../repositories/guestDonationRiskRepository';
import {
  countRecentSessionsByIp,
  countRecentSessionsByIpExcluding,
  countRecentSessionsByFingerprint,
  findGuestWalletSessionById
} from '../repositories/guestWalletSessionRepository';
import { findAuditAmountsBySessionId } from '../repositories/anonymousDonationAuditRepository';
import { getSharedRpcProvider, resetSharedRpcProvider } from './blockchainProvider';

const logger = getLogger();

/** Ngưỡng IP burst: ≥3 sessions/IP/1h → +30. */
const IP_BURST_THRESHOLD = 3;

/** Score khi IP burst được phát hiện. */
const IP_BURST_SCORE = 30;

/** Ngưỡng fingerprint reuse: ≥3 sessions/fingerprint/24h → +25. */
const FINGERPRINT_REUSE_THRESHOLD = 3;

/** Score khi fingerprint reuse được phát hiện. */
const FINGERPRINT_REUSE_SCORE = 25;

/** Ngưỡng wallet age: counterfactual (not deployed) → +20. */
const WALLET_AGE_RISK_SCORE = 20;

/** Ngưỡng donation pattern: tất cả donations cùng amount → +15. */
const DONATION_PATTERN_RISK_SCORE = 15;

/** Score khi session velocity cao. */
const SESSION_VELOCITY_SCORE = 10;

/** Ngưỡng session velocity: <60s → +10. */
const SESSION_VELOCITY_THRESHOLD_MS = 60_000;

/** Thời gian xem xét IP burst (1 giờ). */
const IP_BURST_WINDOW_MS = 3_600_000;

/** Thời gian xem xét fingerprint reuse (24 giờ). */
const FINGERPRINT_REUSE_WINDOW_MS = 86_400_000;

/**
 * Phân loại risk score thành riskLevel và trustMultiplier tương ứng.
 * Mục đích: chuẩn hóa việc map score → level để đảm bảo nhất quán giữa các service.
 * Quy tắc:
 * - 0-25:   SAFE      → trustMultiplier = 1.0
 * - 26-50:  LOW       → trustMultiplier = 0.8
 * - 51-69:  MEDIUM    → trustMultiplier = 0.5
 * - 70-90:  HIGH      → trustMultiplier = 0.2 (dùng Token Paymaster)
 * - 91-100: CRITICAL  → trustMultiplier = 0.2 (dùng Token Paymaster)
 *
 * Lưu ý: riskScore >= 70 KHÔNG bị block mà dùng Token Paymaster thu phí gas.
 * Boundary MEDIUM/HIGH phải khớp với RISK_THRESHOLD_FOR_TOKEN_PAYMASTER = 70
 * trong guestPaymasterService.ts.
 * @param riskScore - Điểm risk từ 0-100
 * @returns Object chứa riskLevel và trustMultiplier tương ứng
 */
export function computeRiskLevelAndMultiplier(
  riskScore: number
): RiskScoreClassification {
  if (riskScore <= 25) {
    return { riskLevel: 'SAFE', trustMultiplier: 1.0 };
  }
  if (riskScore <= 50) {
    return { riskLevel: 'LOW', trustMultiplier: 0.8 };
  }
  if (riskScore < 70) {
    return { riskLevel: 'MEDIUM', trustMultiplier: 0.5 };
  }
  if (riskScore <= 90) {
    return { riskLevel: 'HIGH', trustMultiplier: 0.2 };
  }
  return { riskLevel: 'CRITICAL', trustMultiplier: 0.2 };
}

/**
 * Kết quả phân loại risk score.
 * Dùng chung cho cả service layer và repository layer để đảm bảo type consistency.
 */
export type RiskScoreClassification = {
  riskLevel: RiskLevel;
  trustMultiplier: number;
};

/**
 * Kết quả đánh giá risk cho một session.
 */
export type RiskEvaluationResult = RiskScoreClassification & {
  riskScore: number;
  factors: {
    walletAgeScore: number;
    ipBurstScore: number;
    fingerprintReuseScore: number;
    donationPatternScore: number;
    sessionVelocityScore: number;
  };
  blocked: boolean;
};

/**
 * Hàm kiểm tra wallet age — check xem Smart Account đã deployed on-chain hay chưa.
 * Counterfactual (chưa deployed) → cao risk vì attacker có thể tạo nhiều wallets không tốn chi phí.
 * Deployed wallet → đã tốn gas deploy → lower risk.
 * Dùng singleton provider để tránh tạo provider mới mỗi lần gọi.
 */
async function checkWalletAge(walletAddress: string): Promise<number> {
  try {
    const provider = getSharedRpcProvider();
    const code = await provider.getCode(walletAddress);
    // 0x = chưa deployed (counterfactual), >0x = đã deploy
    return code === '0x' ? WALLET_AGE_RISK_SCORE : 0;
  } catch (error) {
    logger.warn('Failed to check wallet age on-chain.', {
      walletAddress,
      errorMessage: error instanceof Error ? error.message : String(error)
    });
    return 0;
  }
}

/**
 * Hàm kiểm tra IP burst — đếm sessions cùng IP trong 1 giờ.
 * ≥3 sessions → cao risk vì có thể là bot/script tạo nhiều wallets.
 * Fallback về 0 khi DB query fail — fail-safe thay vì fail-open.
 * Lý do: không để attacker trigger DB error để inflate risk score của chính mình.
 */
async function checkIPBurst(ipAddress: string): Promise<number> {
  try {
    const oneHourAgo = new Date(Date.now() - IP_BURST_WINDOW_MS);
    const count = await countRecentSessionsByIp(ipAddress, oneHourAgo);
    return count >= IP_BURST_THRESHOLD ? IP_BURST_SCORE : 0;
  } catch (error) {
    logger.error('DB check failed for IP burst — treating as no burst (fail-safe).', {
      ipAddress,
      errorMessage: error instanceof Error ? error.message : String(error)
    });
    return 0;
  }
}

/**
 * Hàm kiểm tra fingerprint reuse — đếm sessions cùng fingerprint trong 24 giờ.
 * ≥3 sessions → cao risk vì cùng thiết bị tạo nhiều wallets.
 * Fallback về 0 khi DB query fail — fail-safe, không inflate score khi attacker trigger lỗi.
 */
async function checkFingerprintReuse(deviceFingerprintHash: string): Promise<number> {
  try {
    const oneDayAgo = new Date(Date.now() - FINGERPRINT_REUSE_WINDOW_MS);
    const count = await countRecentSessionsByFingerprint(deviceFingerprintHash, oneDayAgo);
    return count >= FINGERPRINT_REUSE_THRESHOLD ? FINGERPRINT_REUSE_SCORE : 0;
  } catch (error) {
    logger.error('DB check failed for fingerprint reuse — treating as no reuse (fail-safe).', {
      deviceFingerprintHash,
      errorMessage: error instanceof Error ? error.message : String(error)
    });
    return 0;
  }
}

/**
 * Hàm kiểm tra donation pattern — tất cả donations trong session có cùng amount.
 * Nếu tất cả donations đều same exact amount → có thể là scripted/farming.
 */
async function checkDonationPattern(sessionId: string): Promise<number> {
  try {
    const amounts = await findAuditAmountsBySessionId(sessionId);
    if (amounts.length < 3) {
      return 0;
    }
    const firstAmount = amounts[0];
    const allSame = amounts.every((amt) => amt === firstAmount);
    return allSame ? DONATION_PATTERN_RISK_SCORE : 0;
  } catch (error) {
    logger.warn('Failed to check donation pattern.', {
      sessionId,
      errorMessage: error instanceof Error ? error.message : String(error)
    });
    return 0;
  }
}

/**
 * Hàm kiểm tra session velocity — session mới được tạo quá nhanh so với các session cũ từ cùng IP.
 * Dấu hiệu automated session creation.
 * Session hiện tại đã được insert vào DB trước khi hàm này được gọi.
 * Dùng excludeSessionId để loại trừ chính nó khỏi count.
 * @param ipAddress - Địa chỉ IP của session
 * @param sessionCreatedAt - Thời điểm session hiện tại được tạo, dùng để tính window
 * @param excludeSessionId - Session ID cần loại trừ khỏi count (chính session hiện tại)
 */
async function checkSessionVelocity(
  ipAddress: string,
  sessionCreatedAt: Date,
  excludeSessionId: string
): Promise<number> {
  try {
    const sinceDate = new Date(sessionCreatedAt.getTime() - SESSION_VELOCITY_THRESHOLD_MS);
    const count = await countRecentSessionsByIpExcluding(ipAddress, sinceDate, excludeSessionId);
    // Nếu có >= 1 session trong window 60s → session mới được tạo quá nhanh → suspicious
    return count >= 1 ? SESSION_VELOCITY_SCORE : 0;
  } catch (error) {
    logger.warn('Failed to check session velocity.', {
      ipAddress,
      errorMessage: error instanceof Error ? error.message : String(error)
    });
    return 0;
  }
}

/**
 * Hàm đánh giá risk cho một guest session.
 * Được gọi tại:
 * 1. POST /api/guest/session (initial assessment sau khi tạo session)
 * 2. POST /api/guest/paymaster/sponsor (re-evaluation trước mỗi donation)
 *
 * @param session - Guest session data
 * @param ipAddress - IP address hiện tại của request
 * @param sessionCreatedAt - Thời điểm session được tạo (dùng exclude chính nó khỏi velocity check)
 * @returns RiskEvaluationResult chứa score, level, multiplier, và factors chi tiết
 */
export async function evaluateGuestRisk(
  session: Pick<GuestWalletSession, 'sessionId' | 'walletAddress' | 'deviceFingerprintHash'>,
  ipAddress: string,
  sessionCreatedAt?: Date
): Promise<RiskEvaluationResult> {
  const effectiveCreatedAt = sessionCreatedAt ?? new Date();

  // Chạy song song tất cả 5 checks không phụ thuộc nhau để optimize latency
  const [walletAgeScore, ipBurstScore, fingerprintReuseScore, donationPatternScore, sessionVelocityScore] =
    await Promise.all([
      checkWalletAge(session.walletAddress),
      checkIPBurst(ipAddress),
      checkFingerprintReuse(session.deviceFingerprintHash),
      checkDonationPattern(session.sessionId),
      checkSessionVelocity(ipAddress, effectiveCreatedAt, session.sessionId)
    ]);

  const riskScore = Math.min(
    100,
    walletAgeScore + ipBurstScore + fingerprintReuseScore + donationPatternScore + sessionVelocityScore
  );

  // blocked = true khi riskLevel === 'CRITICAL' (riskScore >= 91).
  // HIGH (70-90): dùng Token Paymaster, KHÔNG block theo design.
  // CRITICAL (91-100): dùng Token Paymaster, trustMultiplier = 0.2. KHÔNG block.
  // 'blocked' field dùng để track trong DB, không trigger reject ở Paymaster layer.
  // Quyết định block/sponsor thực tế phụ thuộc vào business logic ở service layer.
  const { riskLevel, trustMultiplier } = computeRiskLevelAndMultiplier(riskScore);

  const result: RiskEvaluationResult = {
    riskScore,
    riskLevel,
    trustMultiplier,
    factors: {
      walletAgeScore,
      ipBurstScore,
      fingerprintReuseScore,
      donationPatternScore,
      sessionVelocityScore
    },
    blocked: riskLevel === 'CRITICAL'
  };

  logger.info('Guest risk evaluated.', {
    sessionId: session.sessionId,
    walletAddress: session.walletAddress,
    riskScore,
    riskLevel,
    trustMultiplier,
    factors: result.factors
  });

  return result;
}

/**
 * Hàm đánh giá và lưu risk record vào MongoDB.
 * Dùng cho initial assessment khi tạo session.
 * Tự động upsert để tạo record mới hoặc cập nhật nếu đã tồn tại.
 * @param session - Guest session data
 * @param ipAddress - IP address hiện tại
 * @param sessionCreatedAt - Thời điểm session được tạo
 */
export async function evaluateAndSaveGuestRisk(
  session: Pick<GuestWalletSession, 'sessionId' | 'walletAddress' | 'deviceFingerprintHash'>,
  ipAddress: string,
  sessionCreatedAt?: Date
): Promise<GuestDonationRisk> {
  const result = await evaluateGuestRisk(session, ipAddress, sessionCreatedAt);

  const upserted = await upsertGuestDonationRisk(session.sessionId, {
    sessionId: session.sessionId,
    walletAddress: session.walletAddress,
    riskScore: result.riskScore,
    riskLevel: result.riskLevel,
    trustMultiplier: result.trustMultiplier,
    factors: result.factors,
    blocked: result.blocked,
    blockedAt: result.blocked ? new Date() : null,
    blockedReason: result.blocked ? 'Risk score exceeds threshold' : null
  });

  return upserted;
}

/**
 * Hàm đánh giá và lưu risk với re-evaluation khi donation thất bại.
 * Dùng để tăng risk score nếu có suspicious activity.
 * Lookup session để lấy deviceFingerprintHash gốc — riskRecord không lưu trường này.
 *
 * Lưu ý: Hàm này KHÔNG tự động lưu kết quả vào DB, chỉ trả về evaluation result.
 * Caller phải tự gọi upsertGuestDonationRisk nếu cần lưu.
 */
export async function reEvaluateGuestRiskOnly(
  sessionId: string,
  ipAddress: string
): Promise<RiskEvaluationResult> {
  let riskRecord;
  let session;

  try {
    [riskRecord, session] = await Promise.all([
      findGuestDonationRiskBySessionId(sessionId),
      findGuestWalletSessionById(sessionId)
    ]);
  } catch (error) {
    logger.error('Database error during re-evaluation.', {
      sessionId,
      ipAddress,
      originalError: error instanceof Error ? error.message : String(error)
    });
    throw new ApplicationError(
      'Không thể đánh giá risk. Vui lòng thử lại sau.',
      503,
      'INTERNAL_ERROR'
    );
  }

  if (!riskRecord) {
    throw new ApplicationError(
      'Không tìm thấy risk record cho phiên này.',
      404,
      'GUEST_SESSION_NOT_FOUND'
    );
  }

  if (!session) {
    throw new ApplicationError(
      'Không tìm thấy session cho phiên này.',
      404,
      'GUEST_SESSION_NOT_FOUND'
    );
  }

  return evaluateGuestRisk(
    {
      sessionId: riskRecord.sessionId,
      walletAddress: riskRecord.walletAddress,
      deviceFingerprintHash: session.deviceFingerprintHash
    },
    ipAddress,
    session.createdAt
  );
}
