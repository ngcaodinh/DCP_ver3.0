/**
 * Service xác minh giao dịch và tổng hợp dự án — phục vụ tầng Transparency Layer (Lane D).
 *
 * Mục đích:
 * - verifyTransaction: xác minh giao dịch cụ thể theo correlationId
 * - getProjectSummary: tổng hợp dòng tiền dự án theo projectId
 *
 * Cache: Redis TTL 5 phút, key = `transparency:summary:{projectId}`
 * Fallback: in-memory cache khi Redis không khả dụng
 *
 * Tiền VND lưu dạng number (double). An toàn vì VND là số nguyên và double chính xác tuyệt đối tới 2^53
 * (~9×10^15 đồng). CẢNH BÁO: nếu sau này lưu USD/token có phần thập phân thì kết luận này hết hiệu lực,
 * phải chuyển sang decimal.
 *
 * LƯU Ý BẢO MẬT:
 * - Cache summary được ký HMAC để chống sửa payload trong Redis hoặc in-memory.
 * - Không log PII ra console.
 */
import { getLogger } from '../config/logger';
import { getRedisClientIfReady } from '../config/redis';
import { createInMemoryCache } from '../utils/inMemoryCache';
import { findUnifiedTransactionByCorrelationId, aggregateSummaryByProjectId } from '../repositories/unifiedTransactionRepository';
import {
  getCompletedDisbursementSummaryByProjectId,
  findCompletedDisbursementAmountsByProjectId,
  MAX_COMPLETED_DISBURSEMENT_AMOUNTS
} from '../models/disbursementModel';
import { signCachePayload, verifyCachePayload } from '../utils/cacheIntegrity';

const logger = getLogger();

/**
 * LƯU Ý VỀ DỮ LIỆU TRONG CACHE:
 * ---------------------------------------------------------------------------
 * In-memory cache lưu JSON summary gồm:
 * - amountVnd tổng hợp và các chỉ số giải ngân
 * - projectId, donorCount và transactionCount
 *
 * Redis được ưu tiên trong production. In-memory chỉ là fallback.
 * Payload ở cả hai lớp cache đều được ký HMAC để chống sửa dữ liệu.
 * ---------------------------------------------------------------------------
 */

const summaryCachePrefix = 'transparency:summary:';
const cacheTimeToLiveSeconds = 300; // 5 phut

const summaryCacheFallback = createInMemoryCache<string>({ maxEntries: 200 });

const projectSummaryNumericFields = [
  'totalRaised',
  'totalDisbursed',
  'remaining',
  'donorCount',
  'transactionCount',
  'disbursementCount',
  'excludedReorgedVnd',
  'excludedReorgedCount'
] as const;

/** Chỉ nhận cache summary đúng schema hiện tại; cache cũ/hỏng phải được tính lại. */
function isValidProjectSummaryCache(
  value: unknown,
  expectedProjectId: string
): value is ProjectSummary {
  if (!value || typeof value !== 'object') return false;

  const summary = value as Record<string, unknown>;
  if (summary.projectId !== expectedProjectId || !Array.isArray(summary.disbursedAmounts)) {
    return false;
  }

  if (!summary.disbursedAmounts.every(
    amount => typeof amount === 'number' && Number.isFinite(amount)
  )) {
    return false;
  }

  if (!projectSummaryNumericFields.every(
    field => typeof summary[field] === 'number' && Number.isFinite(summary[field])
  )) {
    return false;
  }

  return typeof summary.overDisbursed === 'boolean'
    && typeof summary.cached === 'boolean'
    && typeof summary.fallbackMode === 'boolean';
}

/** Chỉ số sức khỏe cache — phục vụ monitoring và alerting. */
const cacheMetrics = {
  redisGetErrors: 0,
  redisSetErrors: 0,
  redisInvalidateErrors: 0,
  redisUnreachable: 0,
  lastRedisFailureAt: 0 as number
};

/** Reset chỉ số sức khỏe cache. Mục đích: phục vụ test. */
export function resetCacheMetrics(): void {
  cacheMetrics.redisGetErrors = 0;
  cacheMetrics.redisSetErrors = 0;
  cacheMetrics.redisInvalidateErrors = 0;
  cacheMetrics.redisUnreachable = 0;
  cacheMetrics.lastRedisFailureAt = 0;
}

/** Lấy chỉ số sức khỏe cache hiện tại. Mục đích: Prometheus metrics endpoint. */
export function getCacheMetrics(): Readonly<typeof cacheMetrics> {
  return { ...cacheMetrics };
}

/** Trạng thái xác nhận trên blockchain. */
export type ChainStatus = 'CONFIRMED' | 'PENDING' | 'FAILED' | 'REORGED';

/** Nguồn gốc giao dịch. */
export type TransactionSource = 'PAYOS' | 'BLOCKCHAIN' | 'MIXED';

/** Kết quả xác minh giao dịch. */
export type VerificationResult = {
  found: boolean;
  correlationId: string;
  source: TransactionSource | null;
  /** Thong tin nguon tien (PayOS) — null neu khong co */
  payos?: {
    orderCode: string;
    amount: number;
    status: string;
    timestamp: string;
  };
  /** Thong tin on-chain — null neu chua co */
  chain?: {
    txHash: string;
    blockNumber: number | null;
    status: ChainStatus;
  };
  /** Tổng huy động của toàn dự án, null khi giao dịch không gắn project. */
  projectTotalRaised: number | null;
  /** Tổng giải ngân COMPLETED của toàn dự án, null khi giao dịch không gắn project. */
  projectTotalDisbursed: number | null;
  /** Số khoản giải ngân COMPLETED của toàn dự án, null khi giao dịch không gắn project. */
  projectDisbursementCount: number | null;
  /** Tỷ lệ giải ngân trên tổng huy động toàn dự án (bps). */
  disbursedRatioBps: number | null;
  cached: boolean;
  fallbackMode: boolean;
};

/** Tổng hợp dự án. */
export type ProjectSummary = {
  projectId: string;
  totalRaised: number;
  totalDisbursed: number;
  remaining: number;
  donorCount: number;
  transactionCount: number;
  disbursementCount: number;
  disbursedAmounts: number[];
  excludedReorgedVnd: number;
  excludedReorgedCount: number;
  overDisbursed: boolean;
  cached: boolean;
  fallbackMode: boolean;
};

/**
 * Đọc summary cache và xác minh HMAC trước khi cho phép parse JSON.
 * @param cacheKey Key của cache entry
 * @returns Payload đã xác minh và cờ cho biết có dùng in-memory fallback hay không
 */
async function getSummaryCache(
  cacheKey: string
): Promise<{ json: string | null; fallbackMode: boolean }> {
  const redisClient = getRedisClientIfReady();
  const expectedProjectId = cacheKey.slice(summaryCachePrefix.length);
  let fallbackMode = false;

  if (redisClient) {
    try {
      const cached = await redisClient.get(cacheKey);
      if (cached != null) {
        const verifiedPayload = verifyCachePayload(String(cached), cacheKey);
        if (verifiedPayload === null) {
          logger.warn('Summary cache HMAC verification failed, dropping entry.', { cacheKey });
          try {
            await redisClient.del(cacheKey);
          } catch {
            // Bỏ qua lỗi xóa cache; request hiện tại vẫn tính lại từ database.
          }
          return { json: null, fallbackMode: false };
        }
        try {
          const parsedPayload: unknown = JSON.parse(verifiedPayload);
          if (!isValidProjectSummaryCache(parsedPayload, expectedProjectId)) {
            throw new Error('invalid summary cache schema');
          }
        } catch {
          logger.warn('Summary cache payload is invalid, dropping entry.', { cacheKey });
          try {
            await redisClient.del(cacheKey);
          } catch {
            // Bỏ qua lỗi xóa cache; request hiện tại vẫn tính lại từ database.
          }
          return { json: null, fallbackMode: false };
        }
        return { json: verifiedPayload, fallbackMode: false };
      }
    } catch (err) {
      cacheMetrics.redisGetErrors++;
      cacheMetrics.lastRedisFailureAt = Date.now();
      logger.warn('Redis get summary cache failed.', {
        errorMessage: err instanceof Error ? err.message : String(err)
      });
      fallbackMode = true;
    }
  } else {
    cacheMetrics.redisUnreachable++;
    fallbackMode = true;
  }

  const fallbackPayload = summaryCacheFallback.get(cacheKey);
  if (!fallbackPayload) return { json: null, fallbackMode };

  const verifiedFallbackPayload = verifyCachePayload(fallbackPayload, cacheKey);
  if (verifiedFallbackPayload === null) {
    logger.warn('Summary in-memory cache HMAC verification failed, dropping entry.', { cacheKey });
    summaryCacheFallback.deleteByKey(cacheKey);
    return { json: null, fallbackMode: true };
  }

  try {
    const parsedPayload: unknown = JSON.parse(verifiedFallbackPayload);
    if (!isValidProjectSummaryCache(parsedPayload, expectedProjectId)) {
      throw new Error('invalid summary cache schema');
    }
  } catch {
    logger.warn('Summary in-memory cache payload is invalid, dropping entry.', { cacheKey });
    summaryCacheFallback.deleteByKey(cacheKey);
    return { json: null, fallbackMode: true };
  }

  return { json: verifiedFallbackPayload, fallbackMode: true };
}

/**
 * Ghi summary payload đã ký HMAC vào Redis hoặc in-memory fallback.
 * @param cacheKey Key của cache entry
 * @param json Dữ liệu JSON cần lưu
 * @returns true nếu phải dùng in-memory fallback
 */
async function setSummaryCache(cacheKey: string, json: string): Promise<boolean> {
  const signedPayload = signCachePayload(json, cacheKey);
  const redisClient = getRedisClientIfReady();
  if (redisClient) {
    try {
      await redisClient.set(cacheKey, signedPayload, { EX: cacheTimeToLiveSeconds });
      return false;
    } catch (err) {
      cacheMetrics.redisSetErrors++;
      cacheMetrics.lastRedisFailureAt = Date.now();
      logger.warn('Redis set summary cache failed.', {
        errorMessage: err instanceof Error ? err.message : String(err)
      });
    }
  } else {
    cacheMetrics.redisUnreachable++;
  }

  summaryCacheFallback.set(cacheKey, signedPayload, cacheTimeToLiveSeconds);
  return true;
}

/**
 * Tính tỷ lệ giải ngân trên tổng huy động theo basis points.
 * @param raised Tổng số tiền quyên góp của dự án
 * @param disbursed Tổng số tiền giải ngân COMPLETED của dự án
 * @returns Tỷ lệ bps hoặc null nếu tổng huy động bằng 0
 */
function calculateDisbursedRatioBps(
  raised: number,
  disbursed: number
): number | null {
  if (raised <= 0) return null;
  return Math.round((disbursed / raised) * 10000);
}

/**
 * Xác minh giao dịch theo correlationId.
 * Trả về thông tin nguồn tiền, trạng thái on-chain và số liệu tổng hợp của dự án.
 *
 * @param correlationId ID tương quan của giao dịch (format: "deposit:{orderCode}" hoặc "donation:{txHash}")
 * @returns Kết quả xác minh, gồm found=false nếu không tìm thấy
 */
export async function verifyTransaction(
  correlationId: string
): Promise<VerificationResult> {
  // Query trực tiếp correlationId; summary dự án dùng cache chung với endpoint /summary.
  const transaction = await findUnifiedTransactionByCorrelationId(correlationId);

  if (!transaction) {
    return {
      found: false,
      correlationId,
      source: null,
      projectTotalRaised: null,
      projectTotalDisbursed: null,
      projectDisbursementCount: null,
      disbursedRatioBps: null,
      cached: false,
      fallbackMode: false
    };
  }

  // Dùng cùng getProjectSummary để /verify và /summary không thể lệch nguồn số liệu.
  const projectSummary = transaction.projectId
    ? await getProjectSummary(transaction.projectId)
    : null;
  const disbursedRatioBps = projectSummary
    ? calculateDisbursedRatioBps(projectSummary.totalRaised, projectSummary.totalDisbursed)
    : null;

  const result: VerificationResult = {
    found: true,
    correlationId: transaction.correlationId,
    source: transaction.source as TransactionSource,
    payos: transaction.payosOrderCode
      ? {
          orderCode: transaction.payosOrderCode,
          amount: transaction.amountVnd,
          status: transaction.payosStatus || 'UNKNOWN',
          timestamp: transaction.eventTimestamp.toISOString()
        }
      : undefined,
    chain: transaction.chainTxHash
      ? {
          // Backend trả đủ hash để frontend hiển thị rút gọn nhưng vẫn copy được chuỗi gốc.
          txHash: transaction.chainTxHash,
          blockNumber: transaction.chainBlockNumber,
          status: transaction.chainStatus as ChainStatus
        }
      : undefined,
    projectTotalRaised: projectSummary?.totalRaised ?? null,
    projectTotalDisbursed: projectSummary?.totalDisbursed ?? null,
    projectDisbursementCount: projectSummary?.disbursementCount ?? null,
    disbursedRatioBps,
    cached: projectSummary?.cached ?? false,
    fallbackMode: projectSummary?.fallbackMode ?? false
  };

  return result;
}

/**
 * Lấy tổng hợp dòng tiền của một dự án.
 * Bao gồm tổng quyên góp, tổng giải ngân, donor unique và số giao dịch.
 *
 * @param projectId ID của dự án
 * @returns Tổng hợp dự án, trả zero values nếu không có dữ liệu
 */
export async function getProjectSummary(
  projectId: string
): Promise<ProjectSummary> {
  const cacheKey = `${summaryCachePrefix}${projectId}`;

  const cacheResult = await getSummaryCache(cacheKey);
  if (cacheResult.json) {
    logger.info('Project summary cache hit.', { projectId });
    // getSummaryCache đã validate JSON và schema trước khi trả payload.
    const parsed = JSON.parse(cacheResult.json) as ProjectSummary;
    return { ...parsed, cached: true, fallbackMode: cacheResult.fallbackMode };
  }
  logger.info('Project summary cache miss.', { projectId });

  // Ba truy vấn độc lập nên chạy song song; total/count lấy toàn bộ dữ liệu,
  // còn amounts chỉ lấy 100 khoản gần nhất để giới hạn kích thước response.
  const [summaryStats, disbursementStats, disbursedAmounts] = await Promise.all([
    aggregateSummaryByProjectId(projectId),
    getCompletedDisbursementSummaryByProjectId(projectId),
    findCompletedDisbursementAmountsByProjectId(projectId, MAX_COMPLETED_DISBURSEMENT_AMOUNTS)
  ]);

  const totalDisbursed = disbursementStats.totalCompletedAmount;
  // Kẹp remaining về 0 để UI không phải xử lý số âm; cờ giữ lại tín hiệu cho kiểm toán.
  const remaining = Math.max(0, summaryStats.totalRaisedVnd - totalDisbursed);
  const overDisbursed = totalDisbursed > summaryStats.totalRaisedVnd;

  const result: ProjectSummary = {
    projectId,
    totalRaised: summaryStats.totalRaisedVnd,
    totalDisbursed,
    remaining,
    donorCount: summaryStats.uniqueDonorCount,
    transactionCount: summaryStats.totalTransactions,
    disbursementCount: disbursementStats.completedCount,
    // Count tính trên toàn bộ bản ghi; amounts chỉ là 100 khoản gần nhất để giới hạn payload.
    disbursedAmounts,
    excludedReorgedVnd: summaryStats.excludedReorgedVnd,
    excludedReorgedCount: summaryStats.excludedReorgedCount,
    overDisbursed,
    cached: false,
    fallbackMode: cacheResult.fallbackMode
  };

  let usedFallbackForSet = false;
  try {
    usedFallbackForSet = await setSummaryCache(cacheKey, JSON.stringify(result));
  } catch (error) {
    // Cache là lớp tối ưu; lỗi ký/ghi không được làm hỏng số liệu đã tính từ database.
    logger.warn('Không thể ghi project summary vào cache.', {
      errorMessage: error instanceof Error ? error.message : String(error)
    });
  }
  result.fallbackMode = result.fallbackMode || usedFallbackForSet;

  return result;
}

/**
 * Xóa cache khi có transaction mới được sync.
 * Sử dụng SCAN thay vì KEYS trong production để tránh block Redis.
 *
 * @param projectId ID của dự án (optional — nếu không có sẽ xóa toàn bộ summary cache)
 */
export async function invalidateVerificationCache(projectId?: string): Promise<void> {
  const redisClient = getRedisClientIfReady();

  if (redisClient) {
    try {
      // Có projectId thì key đã xác định, không cần SCAN toàn namespace.
      // Chỉ dùng SCAN khi worker cần invalidate toàn bộ summary sau một cycle sync.
      const keyList: string[] = projectId
        ? [`${summaryCachePrefix}${projectId}`]
        : [];

      if (!projectId) {
        for await (const batch of redisClient.scanIterator({
          MATCH: `${summaryCachePrefix}*`,
          COUNT: 200
        })) {
          // scanIterator trả về string[] | Buffer[] — normalize sang string bằng String()
          keyList.push(...batch.map(k => String(k)));
        }
      }

      let keysDeleted = 0;
      if (keyList.length > 0) {
        // UNLINK giải phóng key khỏi namespace ngay và reclaim memory ở background.
        const unlinkCommand = redisClient.unlink as (...keys: string[]) => Promise<number>;
        keysDeleted = await unlinkCommand(...keyList);
      }

      logger.info('Verification cache invalidated via UNLINK.', {
        projectId,
        keysDeleted
      });
    } catch (err) {
      cacheMetrics.redisInvalidateErrors++;
      cacheMetrics.lastRedisFailureAt = Date.now();
      logger.warn('Redis invalidate verification cache failed.', {
        errorMessage: err instanceof Error ? err.message : String(err)
      });
    }
  }

  // Có projectId thì chỉ xóa đúng entry, tránh làm mất cache của dự án khác.
  if (projectId) {
    summaryCacheFallback.deleteByKey(`${summaryCachePrefix}${projectId}`);
  } else {
    summaryCacheFallback.clearAll();
  }
}
