/**
 * Service xac minh giao dich va tong hop du an — phuc vu tang Transparency Layer (Lane D).
 *
 * Muc dich:
 * - verifyTransaction: xac minh giao dich cu the theo correlationId
 * - getProjectSummary: tong hop dong tien du an theo projectId
 *
 * Cache: Redis TTL 5 phut, key = `transparency:verify:{correlationId}` va `transparency:summary:{projectId}`
 * Fallback: in-memory cache khi Redis khong kha dung
 *
 * LUU Y BAO MAT:
 * - PII (walletAddress) duoc mask trong response
 * - Khong log PII ra console
 */
import { getLogger } from '../config/logger';
import { getRedisClientIfReady } from '../config/redis';
import { createInMemoryCache } from '../utils/inMemoryCache';
import { findUnifiedTransactionByCorrelationId, aggregateSummaryByProjectId } from '../repositories/unifiedTransactionRepository';
import { findDisbursementsByProjectId } from '../models/disbursementModel';

const logger = getLogger();

/**
 * CAVEATS VE PII TRONG CACHE:
 * ---------------------------------------------------------------------------
 * In-memory cache luu tru JSON response chua:
 * - walletAddress: dia chi vi blockchain (PII nhe)
 * - amountVnd: so tien giao dich
 *
 * Redis duoc uu tien trong production. In-memory chi la fallback.
 * ---------------------------------------------------------------------------
 */

const verifyCachePrefix = 'transparency:verify:';
const summaryCachePrefix = 'transparency:summary:';
const cacheTimeToLiveSeconds = 300; // 5 phut

const verifyCacheFallback = createInMemoryCache<string>({ maxEntries: 500 });
const summaryCacheFallback = createInMemoryCache<string>({ maxEntries: 200 });

/** Trang thai xac nhan tren blockchain */
export type ChainStatus = 'CONFIRMED' | 'PENDING' | 'FAILED' | 'REORGED';

/** Nguon goc giao dich */
export type TransactionSource = 'PAYOS' | 'BLOCKCHAIN' | 'MIXED';

/** Ket qua xac minh giao dich */
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
  /** Tong so giai ngan lien quan */
  totalDisbursed: number;
  /** So luong giai ngan */
  disbursementCount: number;
  /** Ty le raised vs disbursed (bps) */
  disbursedRatioBps: number | null;
  cached: boolean;
  fallbackMode: boolean;
};

/** Thong tin nguoi quyen gop trong summary */
export type DonorSummary = {
  donorCount: number;
  transactionCount: number;
};

/** Tong hop du an */
export type ProjectSummary = {
  projectId: string;
  totalRaised: number;
  totalDisbursed: number;
  remaining: number;
  donorCount: number;
  transactionCount: number;
  disbursementCount: number;
  disbursedAmounts: number[];
  cached: boolean;
  fallbackMode: boolean;
};

/**
 * Mask dia chi vi Ethereum — chi hien 6 ky tu dau va 4 ky tu cuoi.
 * @param address Dia chi vi day du
 * @returns Dia chi da mask
 */
function maskWalletAddress(address: string | null | undefined): string | null {
  if (!address || address.length < 10) return null;
  return `${address.substring(0, 6)}...${address.substring(address.length - 4)}`;
}

/**
 * Lay du lieu tu cache (Redis hoac in-memory fallback).
 * @param cacheKey Key cua cache entry
 * @returns JSON string hoac null neu khong co
 */
async function getFromCache(cacheKey: string): Promise<string | null> {
  const redisClient = getRedisClientIfReady();
  if (redisClient) {
    try {
      const cached = await redisClient.get(cacheKey);
      if (cached) return cached;
    } catch (err) {
      logger.warn('Redis get verification cache failed.', {
        errorMessage: err instanceof Error ? err.message : String(err)
      });
    }
  }
  return verifyCacheFallback.get(cacheKey);
}

/**
 * Lay du lieu tu summary cache.
 * @param cacheKey Key cua cache entry
 * @returns JSON string hoac null neu khong co
 */
async function getFromSummaryCache(cacheKey: string): Promise<string | null> {
  const redisClient = getRedisClientIfReady();
  if (redisClient) {
    try {
      const cached = await redisClient.get(cacheKey);
      if (cached) return cached;
    } catch (err) {
      logger.warn('Redis get summary cache failed.', {
        errorMessage: err instanceof Error ? err.message : String(err)
      });
    }
  }
  return summaryCacheFallback.get(cacheKey);
}

/**
 * Ghi du lieu vao cache (Redis hoac in-memory fallback).
 * @param cacheKey Key cua cache entry
 * @param json Du lieu JSON can luu
 */
async function setVerifyCache(cacheKey: string, json: string): Promise<void> {
  const redisClient = getRedisClientIfReady();
  if (redisClient) {
    try {
      await redisClient.set(cacheKey, json, { EX: cacheTimeToLiveSeconds });
      return;
    } catch (err) {
      logger.warn('Redis set verification cache failed.', {
        errorMessage: err instanceof Error ? err.message : String(err)
      });
    }
  }
  verifyCacheFallback.set(cacheKey, json, cacheTimeToLiveSeconds);
}

/**
 * Ghi du lieu vao summary cache.
 * @param cacheKey Key cua cache entry
 * @param json Du lieu JSON can luu
 */
async function setSummaryCache(cacheKey: string, json: string): Promise<void> {
  const redisClient = getRedisClientIfReady();
  if (redisClient) {
    try {
      await redisClient.set(cacheKey, json, { EX: cacheTimeToLiveSeconds });
      return;
    } catch (err) {
      logger.warn('Redis set summary cache failed.', {
        errorMessage: err instanceof Error ? err.message : String(err)
      });
    }
  }
  summaryCacheFallback.set(cacheKey, json, cacheTimeToLiveSeconds);
}

/**
 * Tinh tong so tien giai ngan tu danh sach disbursements.
 * @param disbursements Danh sach disbursements
 * @returns Tong so tien da giai ngan
 */
function calculateTotalDisbursed(
  disbursements: Array<{ amount: number; status: string }>
): number {
  return disbursements
    .filter(d => d.status === 'COMPLETED')
    .reduce((sum, d) => sum + d.amount, 0);
}

/**
 * Tinh ty le disbursed/raised theo basis points.
 * @param raised Tong so tien quyen gop
 * @param disbursed Tong so tien giai ngan
 * @returns Ty le bps hoac null neu raised = 0
 */
function calculateDisbursedRatioBps(
  raised: number,
  disbursed: number
): number | null {
  if (raised <= 0) return null;
  return Math.round((disbursed / raised) * 10000);
}

/**
 * Xac minh giao dich theo correlationId.
 * Tra ve thong tin nguon tien (PayOS), trang thai on-chain, va tong giai ngan lien quan.
 *
 * @param correlationId ID tuong quan cua giao dich (format: "deposit:{orderCode}" hoac "donation:{txHash}")
 * @returns Ket qua xac minh hoac null neu khong tim thay
 */
export async function verifyTransaction(
  correlationId: string
): Promise<VerificationResult | null> {
  const cacheKey = `${verifyCachePrefix}${correlationId}`;

  // Kiem tra cache truoc
  const cached = await getFromCache(cacheKey);
  if (cached) {
    logger.info('Verification cache hit.', { correlationId });
    const parsed = JSON.parse(cached) as VerificationResult;
    return { ...parsed, cached: true };
  }
  logger.info('Verification cache miss.', { correlationId });

  // Query tu unified_transactions
  const transaction = await findUnifiedTransactionByCorrelationId(correlationId);

  if (!transaction) {
    // Khong tim thay — tra ve ket qua not found
    const notFoundResult: VerificationResult = {
      found: false,
      correlationId,
      source: null,
      totalDisbursed: 0,
      disbursementCount: 0,
      disbursedRatioBps: null,
      cached: false,
      fallbackMode: false
    };

    // Khong cache ket qua not found — tranh cache poisoning
    return notFoundResult;
  }

  // Lay danh sach disbursements cua project de tinh tong giai ngan
  const disbursements = await findDisbursementsByProjectId(transaction.projectId);
  const totalDisbursed = calculateTotalDisbursed(disbursements);
  const disbursedRatioBps = calculateDisbursedRatioBps(
    transaction.amountVnd,
    totalDisbursed
  );

  // Build response
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
          txHash: maskWalletAddress(transaction.chainTxHash) ?? '***',
          blockNumber: transaction.chainBlockNumber,
          status: transaction.chainStatus as ChainStatus
        }
      : undefined,
    totalDisbursed,
    disbursementCount: disbursements.filter(d => d.status === 'COMPLETED').length,
    disbursedRatioBps,
    cached: false,
    fallbackMode: false
  };

  // Cache ket qua (khong cache PII — da mask o tren)
  try {
    await setVerifyCache(cacheKey, JSON.stringify(result));
  } catch (err) {
    logger.warn('Failed to cache verification result.', {
      errorMessage: err instanceof Error ? err.message : String(err)
    });
  }

  return result;
}

/**
 * Lay tong hop dong tien cua mot du an.
 * Bao gom tong quyen gop, tong giai ngan, so luong donor, va so giao dich.
 *
 * @param projectId ID cua du an
 * @returns Tong hop du an (tra ve zero values neu khong co du lieu)
 */
export async function getProjectSummary(
  projectId: string
): Promise<ProjectSummary> {
  const cacheKey = `${summaryCachePrefix}${projectId}`;

  // Kiem tra cache truoc
  const cached = await getFromSummaryCache(cacheKey);
  if (cached) {
    logger.info('Project summary cache hit.', { projectId });
    const parsed = JSON.parse(cached) as ProjectSummary;
    return { ...parsed, cached: true };
  }
  logger.info('Project summary cache miss.', { projectId });

  // Query tu unified_transactions de lay thong ke
  const summaryStats = await aggregateSummaryByProjectId(projectId);

  // Query disbursements de tinh tong giai ngan
  const disbursements = await findDisbursementsByProjectId(projectId);
  const totalDisbursed = calculateTotalDisbursed(disbursements);

  // Dem so donor unique — moi transaction = 1 donor
  const donorCount = summaryStats.totalTransactions;
  const transactionCount = summaryStats.totalTransactions;

  const remaining = Math.max(0, summaryStats.totalRaisedVnd - totalDisbursed);

  const result: ProjectSummary = {
    projectId,
    totalRaised: summaryStats.totalRaisedVnd,
    totalDisbursed,
    remaining,
    donorCount,
    transactionCount,
    disbursementCount: disbursements.filter(d => d.status === 'COMPLETED').length,
    disbursedAmounts: disbursements
      .filter(d => d.status === 'COMPLETED')
      .map(d => d.amount),
    cached: false,
    fallbackMode: false
  };

  // Cache ket qua
  try {
    await setSummaryCache(cacheKey, JSON.stringify(result));
  } catch (err) {
    logger.warn('Failed to cache project summary.', {
      errorMessage: err instanceof Error ? err.message : String(err)
    });
  }

  return result;
}

/**
 * Xoa cache khi co transaction moi duoc sync.
 * Su dung SCAN thay vi KEYS trong production de tranh block Redis.
 *
 * @param projectId ID cua du an (optional — neu khong co se xoa tat ca)
 */
export async function invalidateVerificationCache(projectId?: string): Promise<void> {
  const redisClient = getRedisClientIfReady();

  if (redisClient) {
    try {
      // Chi xoa summary cache cua project hien tai
      // Verify cache se bi expires tu dong qua TTL
      const patterns: string[] = [`${summaryCachePrefix}${projectId || '*'}`];

      for (const pattern of patterns) {
        const keyList: string[] = [];
        for await (const batch of redisClient.scanIterator({ MATCH: pattern, COUNT: 100 })) {
          keyList.push(...batch);
        }

        if (keyList.length > 0) {
          const delCommand = redisClient.del as (...keys: string[]) => Promise<number>;
          await delCommand(...keyList);
        }
      }

      logger.info('Verification cache invalidated.', { projectId });
    } catch (err) {
      logger.warn('Redis invalidate verification cache failed.', {
        errorMessage: err instanceof Error ? err.message : String(err)
      });
    }
  }

  // Clear in-memory fallback
  if (projectId) {
    summaryCacheFallback.clearAll();
  } else {
    verifyCacheFallback.clearAll();
    summaryCacheFallback.clearAll();
  }
}
