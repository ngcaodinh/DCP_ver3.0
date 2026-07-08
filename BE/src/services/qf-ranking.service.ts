/**
 * Service tính Trust-Adjusted QF Rankings.
 * Công thức: trustAdjustedScore = (Σ √(dᵢ × trustᵢ))²
 * Trust fallback = 0.5 cho donor không có record.
 * Cache TTL 5 phút (Redis primary, in-memory fallback).
 */
import { getLogger } from '../config/logger';
import { getRedisClientIfReady } from '../config/redis';
import { createInMemoryCache } from '../utils/inMemoryCache';
import { parseRoundIdToTimeWindow, normalizeRoundIdForCacheKey } from '../utils/roundId.utils';
import { TRUST_SCORE_FALLBACK } from '../types/trust-score.types';
import type {
  QfRankingEntry,
  QfRankingResponse,
  QfRankingQueryInput,
  DonationData
} from '../types/qf-ranking.types';
import { assignTier } from '../types/qf-ranking.types';
import {
  findDonationsByProjectId,
  findDonationsByProjectIdInTimeRange
} from '../models/donationModel';
import { getTrustScoresByDonorAddresses } from '../repositories/donorTrustScoreRepository';

const logger = getLogger();

/**
 * Prefix và version cho cache key của QF rankings.
 * Tăng version mỗi khi thay đổi cấu trúc response để tránh serve stale data từ deployment cũ.
 * v1 → v2: thêm field skippedDonors, fix overflow guard.
 */
const QF_RANKING_CACHE_PREFIX = 'qf:rankings:v2:';

/**
 * Số lượng donation tối đa được tải về khi không giới hạn theo thời gian (roundId="all").
 * Đủ lớn để xử lý hầu hết các project, nhưng vẫn có giới hạn để tránh OOM.
 */
export const MAX_DONATIONS_FETCH = 10_000;

/** TTL cache: 5 phút = 300 giây. */
const QF_RANKING_CACHE_TTL_SECONDS = 300;

/** Cache in-memory fallback khi Redis không khả dụng. */
const qfRankingFallbackCache = createInMemoryCache<string>();

/**
 * Hàm extract message từ error object.
 * Redis error có thể là string hoặc object dạng {errorMessage: ''}.
 */
function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const msg = (error as Record<string, unknown>).message ?? (error as Record<string, unknown>).errorMessage;
    if (typeof msg === 'string') return msg;
  }
  return String(error);
}

/**
 * Hàm mask donor address thành "0xabcd...1234".
 * Mục đích: bảo vệ privacy trong response.
 */
function maskDonorAddress(address: string): string {
  const prefixLength = 6;
  const suffixLength = 4;
  const minLength = prefixLength + suffixLength;
  if (address.length < minLength) {
    return address;
  }
  const prefix = address.substring(0, prefixLength);
  const suffix = address.slice(-suffixLength);
  return `${prefix}...${suffix}`;
}

/**
 * Hàm build cache key cho QF rankings.
 */
function buildQfRankingCacheKey(projectId: string, normalizedRoundId: string): string {
  return `${QF_RANKING_CACHE_PREFIX}${projectId}:${normalizedRoundId}`;
}

/**
 * Hàm kiểm tra tính hợp lệ của response đã cache.
 * Mục đích: chặn việc serve lại data cũ (từ deployment trước fix overflow) có chứa
 * Infinity/NaN — khi JSON.stringify, Infinity/NaN bị serialize thành null, nên
 * JSON.parse không throw lỗi mà âm thầm trả về null cho các field số học.
 * Việc bump QF_RANKING_CACHE_PREFIX version khi đổi cấu trúc response cũng giúp
 * tránh trường hợp này, hàm này là lớp bảo vệ bổ sung.
 */
function isValidCachedRanking(data: QfRankingResponse): boolean {
  if (data == null || data.scores == null || data.metadata == null) return false;

  const numericFields = [
    data.scores.projectTrustAdjustedScore,
    data.scores.originalQfScore,
    data.scores.totalDonors,
    data.scores.totalDonationRecords,
    data.scores.skippedDonors
  ];

  if (!Array.isArray(data.rankings)) return false;

  // Kiểm tra từng entry trong rankings để chặn Infinity/null len vào từng field số học
  for (const entry of data.rankings) {
    if (
      entry == null ||
      typeof entry.contributionAmount !== 'number' || !Number.isFinite(entry.contributionAmount) ||
      typeof entry.trustScore !== 'number' || !Number.isFinite(entry.trustScore) ||
      typeof entry.trustAdjustedMatch !== 'number' || !Number.isFinite(entry.trustAdjustedMatch)
    ) {
      return false;
    }
  }

  // Kiểm tra trustFactors — averageTrustScore cũng có thể bị null nếu từ deployment cũ
  if (data.trustFactors == null || typeof data.trustFactors.averageTrustScore !== 'number' || !Number.isFinite(data.trustFactors.averageTrustScore)) {
    return false;
  }

  return numericFields.every(value => typeof value === 'number' && Number.isFinite(value));
}

/**
 * Hàm lấy kết quả từ cache (Redis → in-memory fallback).
 */
async function getQfRankingCache(cacheKey: string): Promise<string | null> {
  const redisClient = getRedisClientIfReady();

  if (redisClient) {
    try {
      const cached = await redisClient.get(cacheKey);
      if (cached) {
        logger.info('QF ranking cache HIT (Redis)', { cacheKey });
        return cached;
      }
    } catch (error) {
      logger.warn('Redis get QF ranking cache thất bại — fallback in-memory.', {
        cacheKey,
        errorMessage: extractErrorMessage(error)
      });
    }
  }

  return qfRankingFallbackCache.get(cacheKey);
}

/**
 * Hàm lưu kết quả vào cache (Redis primary, in-memory fallback).
 */
async function setQfRankingCache(cacheKey: string, payload: string): Promise<void> {
  const redisClient = getRedisClientIfReady();

  if (redisClient) {
    try {
      await redisClient.set(cacheKey, payload, { EX: QF_RANKING_CACHE_TTL_SECONDS });
      return;
    } catch (error) {
      logger.warn('Redis set QF ranking cache thất bại — fallback in-memory.', {
        cacheKey,
        errorMessage: extractErrorMessage(error)
      });
    }
  }

  qfRankingFallbackCache.set(cacheKey, payload, QF_RANKING_CACHE_TTL_SECONDS);
}

/**
 * Hàm fetch donations theo project và time window.
 */
async function fetchDonations(projectId: string, timeWindow: { startAt: Date; endAt: Date } | null): Promise<DonationData[]> {
  if (timeWindow === null) {
    const donations = await findDonationsByProjectId(projectId, MAX_DONATIONS_FETCH);
    return donations.map(d => ({ donorAddress: d.donorAddress.toLowerCase(), amount: d.amount }));
  }

  const donations = await findDonationsByProjectIdInTimeRange(projectId, timeWindow.startAt, timeWindow.endAt);
  return donations.map(d => ({ donorAddress: d.donorAddress.toLowerCase(), amount: d.amount }));
}

/**
 * Hàm batch-fetch trust scores cho nhiều donor addresses.
 */
async function fetchTrustScores(donorAddresses: string[]): Promise<Map<string, number>> {
  const trustMap = new Map<string, number>();

  if (donorAddresses.length === 0) {
    return trustMap;
  }

  const trustRecords = await getTrustScoresByDonorAddresses(donorAddresses);

  for (const record of trustRecords) {
    trustMap.set(record.donorAddress.toLowerCase(), record.trustScore);
  }

  return trustMap;
}

/**
 * Hàm gộp donations theo donor address.
 * Mục đích: sum totalAmount cho mỗi address duy nhất.
 */
function aggregateDonationsByAddress(donations: DonationData[]): Map<string, number> {
  const aggregated = new Map<string, number>();

  for (const donation of donations) {
    const address = donation.donorAddress.toLowerCase();
    const current = aggregated.get(address) || 0;
    aggregated.set(address, current + donation.amount);
  }

  return aggregated;
}

/**
 * Input cho hàm computeTrustAdjustedRankings.
 */
interface ComputeRankingsInput {
  aggregatedDonations: Map<string, number>;
  trustScoreMap: Map<string, number>;
}

/**
 * Kết quả tạm thời từ computeTrustAdjustedRankings.
 */
interface ComputeRankingsIntermediate {
  donorScores: Array<{ address: string; amount: number; trustScore: number; trustAdjusted: number; rawScore: number }>;
  totalTrustAdjustedScore: number;
  totalRawScore: number;
  donorsWithTrustScore: number;
  donorsWithFallback: number;
  /** Số unique addresses bị bỏ qua vì amount > MAX_SAFE_DONATION_AMOUNT hoặc kết quả không hữu hạn. */
  skippedDonors: number;
}

/**
 * Hàm compute rankings từ dữ liệu đã aggregated.
 * Pure function — dễ test.
 *
 * Công thức:
 * - trustAdjusted = √(amount × trustScore)
 * - projectTrustAdjustedScore = (Σ trustAdjusted)²
 * - rawScore = √amount
 * - originalQfScore = (Σ rawScore)²
 *
 * Giới hạn số an toàn: donation có amount vượt 1 triệu tỷ VND (1e15) sẽ bị bỏ qua.
 * Ngưỡng này vừa cách xa mọi giá trị donation thực tế, vừa đảm bảo amount × trustScore
 * không vượt Number.MAX_SAFE_INTEGER (~9×10¹⁵), tránh mất độ chính xác hoặc tràn số
 * khi bình phương tổng điểm (Σ trustAdjusted)².
 */
export const MAX_SAFE_DONATION_AMOUNT = 1e15;

export function computeTrustAdjustedRankings(input: ComputeRankingsInput): ComputeRankingsIntermediate {
  let totalTrustAdjustedScore = 0;
  let totalRawScore = 0;
  let donorsWithTrustScore = 0;
  let donorsWithFallback = 0;
  let skippedDonors = 0;

  const donorScores: ComputeRankingsIntermediate['donorScores'] = [];

  for (const [address, amount] of input.aggregatedDonations) {
    // Bỏ qua donations có giá trị không hợp lệ (≤0) để tránh NaN lan truyền vào công thức.
    if (amount <= 0) continue;

    // Bỏ qua donations vượt ngưỡng an toàn để chặn Infinity khi amount × trustScore
    // vượt Number.MAX_SAFE_INTEGER. Donor này bị đếm vào skippedDonors để FE biết.
    if (amount > MAX_SAFE_DONATION_AMOUNT) {
      skippedDonors++;
      continue;
    }

    const trustScore = input.trustScoreMap.get(address) ?? TRUST_SCORE_FALLBACK;

    if (input.trustScoreMap.has(address)) {
      donorsWithTrustScore++;
    } else {
      donorsWithFallback++;
    }

    const trustAdjusted = Math.sqrt(amount * trustScore);
    const rawScore = Math.sqrt(amount);

    // Phòng thêm: nếu kết quả vẫn không hữu hạn (ví dụ trustScore bất thường), bỏ qua và đếm.
    if (!Number.isFinite(trustAdjusted) || !Number.isFinite(rawScore)) {
      skippedDonors++;
      continue;
    }

    totalTrustAdjustedScore += trustAdjusted;
    totalRawScore += rawScore;

    donorScores.push({
      address,
      amount,
      trustScore,
      trustAdjusted,
      rawScore
    });
  }

  return {
    donorScores,
    totalTrustAdjustedScore,
    totalRawScore,
    donorsWithTrustScore,
    donorsWithFallback,
    skippedDonors
  };
}

/**
 * Hàm finalize rankings — sort, paginate, build response.
 * skippedDonors được lấy từ intermediate để điền vào scores.skippedDonors.
 */
function finalizeRankings(
  intermediate: ComputeRankingsIntermediate,
  totalDonationRecords: number,
  page: number,
  limit: number,
  projectId: string,
  roundId: string,
  cachedAt: string | null,
  cacheHit: boolean
): QfRankingResponse {
  const sorted = [...intermediate.donorScores].sort((a, b) => b.trustAdjusted - a.trustAdjusted);

  const projectTrustAdjustedScore = intermediate.totalTrustAdjustedScore ** 2;
  const originalQfScore = intermediate.totalRawScore ** 2;

  const totalItems = sorted.length;
  const totalPages = Math.ceil(totalItems / limit);
  const startIndex = (page - 1) * limit;
  const paged = sorted.slice(startIndex, startIndex + limit);

  const averageTrustScore = intermediate.donorScores.length > 0
    ? intermediate.donorScores.reduce((sum, d) => sum + d.trustScore, 0) / intermediate.donorScores.length
    : 0;

  const rankings: QfRankingEntry[] = paged.map(d => ({
    donorAddress: maskDonorAddress(d.address),
    contributionAmount: d.amount,
    trustScore: Math.round(d.trustScore * 1000) / 1000,
    trustAdjustedMatch: Math.round(d.trustAdjusted * 1000) / 1000,
    tier: assignTier(d.trustScore)
  }));

  return {
    rankings,
    scores: {
      projectTrustAdjustedScore: Math.round(projectTrustAdjustedScore * 1000) / 1000,
      originalQfScore: Math.round(originalQfScore * 1000) / 1000,
      totalDonors: intermediate.donorScores.length,
      totalDonationRecords,
      skippedDonors: intermediate.skippedDonors
    },
    trustFactors: {
      averageTrustScore: Math.round(averageTrustScore * 1000) / 1000,
      donorsWithTrustScore: intermediate.donorsWithTrustScore,
      donorsWithFallback: intermediate.donorsWithFallback
    },
    metadata: {
      projectId,
      roundId,
      totalItems,
      totalPages,
      currentPage: page,
      pageSize: limit,
      cachedAt,
      cacheHit
    }
  };
}

/**
 * Entry point chính — lấy Trust-Adjusted QF Rankings cho một project.
 * Logic:
 * 1. Parse roundId → time window
 * 2. Check cache
 * 3. Fetch donations + trust scores
 * 4. Compute rankings
 * 5. Cache result
 * 6. Return paginated response
 */
export async function getTrustAdjustedQfRankings(
  query: QfRankingQueryInput
): Promise<QfRankingResponse> {
  const { projectId, roundId, page, limit } = query;

  const normalizedRoundId = normalizeRoundIdForCacheKey(roundId);
  const timeWindow = parseRoundIdToTimeWindow(roundId);
  const cacheKey = buildQfRankingCacheKey(projectId, normalizedRoundId);

  logger.info('Fetching trust-adjusted QF rankings', {
    projectId,
    roundId: normalizedRoundId,
    page,
    limit,
    hasTimeWindow: timeWindow !== null
  });

  const cached = await getQfRankingCache(cacheKey);
  if (cached) {
    try {
      const cachedData = JSON.parse(cached) as QfRankingResponse;
      if (isValidCachedRanking(cachedData)) {
        cachedData.metadata.currentPage = page;
        cachedData.metadata.cacheHit = true;
        return cachedData;
      }
      logger.warn('Cached QF ranking chứa giá trị không hữu hạn hoặc thiếu field, recomputing', { cacheKey });
    } catch {
      logger.warn('Failed to parse cached QF ranking, recomputing', { cacheKey });
    }
  }

  const donations = await fetchDonations(projectId, timeWindow);
  const aggregatedDonations = aggregateDonationsByAddress(donations);
  const uniqueAddresses = Array.from(aggregatedDonations.keys());
  const trustScoreMap = await fetchTrustScores(uniqueAddresses);

  const intermediate = computeTrustAdjustedRankings({ aggregatedDonations, trustScoreMap });

  const response = finalizeRankings(intermediate, donations.length, page, limit, projectId, normalizedRoundId, null, false);

  try {
    await setQfRankingCache(cacheKey, JSON.stringify(response));
    response.metadata.cachedAt = new Date().toISOString();
  } catch (error) {
    logger.warn('Failed to cache QF ranking result', {
      projectId,
      errorMessage: extractErrorMessage(error)
    });
  }

  logger.info('QF rankings computed', {
    projectId,
    totalDonors: intermediate.donorScores.length,
    totalDonationRecords: donations.length,
    skippedDonors: intermediate.skippedDonors,
    cacheHit: false
  });

  return response;
}
