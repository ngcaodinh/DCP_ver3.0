import { getRedisClientIfReady } from '../config/redis';
import { findLatestApprovedFoundationKycSubmission } from '../models/organizationKycModel';
import { createInMemoryCache } from '../utils/inMemoryCache';
import { signCachePayload, verifyCachePayload } from '../utils/cacheIntegrity';

const FOUNDATION_KYC_STATUS_CACHE_KEY = 'transparency:foundation-kyc-status';
const FOUNDATION_KYC_STATUS_CACHE_TTL_SECONDS = 120;
const foundationKycStatusFallbackCache = createInMemoryCache<string>({ maxEntries: 1 });

export type FoundationKycPublicStatus = {
  status: 'VERIFIED' | 'NOT_VERIFIED';
  verifiedAt: string | null;
  organizationName: string | null;
};

/** Kiểm tra shape trước khi đưa payload cache đã giải mã vào response public. */
function isFoundationKycPublicStatus(value: unknown): value is FoundationKycPublicStatus {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  const candidateKeys = Object.keys(candidate);
  if (
    candidateKeys.length !== 3 ||
    !candidateKeys.every((key) => key === 'status' || key === 'verifiedAt' || key === 'organizationName')
  ) {
    return false;
  }
  return (
    (candidate.status === 'VERIFIED' || candidate.status === 'NOT_VERIFIED') &&
    (candidate.verifiedAt === null || typeof candidate.verifiedAt === 'string') &&
    (candidate.organizationName === null || typeof candidate.organizationName === 'string')
  );
}

/** Đọc payload status đã ký HMAC từ Redis hoặc cache fallback, loại bỏ entry bị tamper. */
async function getCachedStatus(): Promise<FoundationKycPublicStatus | null> {
  const redisClient = getRedisClientIfReady();
  let signedPayload: string | null = null;
  if (redisClient) {
    try {
      signedPayload = await redisClient.get(FOUNDATION_KYC_STATUS_CACHE_KEY);
    } catch {
      signedPayload = null;
    }
  }
  signedPayload ||= foundationKycStatusFallbackCache.get(FOUNDATION_KYC_STATUS_CACHE_KEY);
  if (!signedPayload) return null;

  const verifiedPayload = verifyCachePayload(signedPayload, FOUNDATION_KYC_STATUS_CACHE_KEY);
  if (!verifiedPayload) {
    foundationKycStatusFallbackCache.deleteByKey(FOUNDATION_KYC_STATUS_CACHE_KEY);
    if (redisClient) await redisClient.del(FOUNDATION_KYC_STATUS_CACHE_KEY).catch(() => undefined);
    return null;
  }

  try {
    const parsedPayload: unknown = JSON.parse(verifiedPayload);
    if (!isFoundationKycPublicStatus(parsedPayload)) {
      foundationKycStatusFallbackCache.deleteByKey(FOUNDATION_KYC_STATUS_CACHE_KEY);
      if (redisClient) await redisClient.del(FOUNDATION_KYC_STATUS_CACHE_KEY).catch(() => undefined);
      return null;
    }
    return {
      status: parsedPayload.status,
      verifiedAt: parsedPayload.verifiedAt,
      organizationName: parsedPayload.organizationName
    };
  } catch {
    return null;
  }
}

/** Ghi status public vào cache kèm chữ ký HMAC để chống sửa payload trong cache. */
async function setCachedStatus(status: FoundationKycPublicStatus): Promise<void> {
  const signedPayload = signCachePayload(JSON.stringify(status), FOUNDATION_KYC_STATUS_CACHE_KEY);
  const redisClient = getRedisClientIfReady();
  if (redisClient) {
    try {
      await redisClient.set(FOUNDATION_KYC_STATUS_CACHE_KEY, signedPayload, { EX: FOUNDATION_KYC_STATUS_CACHE_TTL_SECONDS });
      return;
    } catch {
      // Cache fallback vẫn bảo đảm endpoint hoạt động khi Redis tạm thời unavailable.
    }
  }
  foundationKycStatusFallbackCache.set(
    FOUNDATION_KYC_STATUS_CACHE_KEY,
    signedPayload,
    FOUNDATION_KYC_STATUS_CACHE_TTL_SECONDS
  );
}

/**
 * Lấy đúng ba trường trạng thái FOUNDATION được phép công khai.
 * Mục đích: không để lộ tài khoản ngân hàng, file, CID hoặc số đăng ký pháp nhân.
 */
export async function getFoundationKycPublicStatus(): Promise<FoundationKycPublicStatus> {
  const cachedStatus = await getCachedStatus();
  if (cachedStatus) return cachedStatus;

  const approvedSubmission = await findLatestApprovedFoundationKycSubmission();
  const publicStatus: FoundationKycPublicStatus = approvedSubmission
    ? {
        status: 'VERIFIED',
        verifiedAt: approvedSubmission.reviewedAt?.toISOString() || null,
        organizationName: approvedSubmission.organizationName
      }
    : {
        status: 'NOT_VERIFIED',
        verifiedAt: null,
        organizationName: null
      };

  await setCachedStatus(publicStatus);
  return publicStatus;
}
