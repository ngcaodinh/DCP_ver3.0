/**
 * Service xay dung unified timeline — JOIN du lieu PayOS voi blockchain events
 * theo correlationId, tra ve chuoi su kien lien mach.
 *
 * Muc dich: phuc vu tang Unified Transparency Layer (Lane D) — D1.
 *
 * Pagination: cursor-based, cursor = base64(timestampISO + "_" + id)
 * Cache: Redis TTL 2 phut, key = `transparency:unified:{projectId}`
 */
import { getLogger } from '../config/logger';
import { getRedisClientIfReady } from '../config/redis';
import { createInMemoryCache } from '../utils/inMemoryCache';
import { DonationRecord } from '../models/donationModel';
import {
  encodeCursor,
  decodeCursor,
  findUnifiedTimeline
} from '../repositories/unifiedTransactionRepository';
import { findDonationsByProjectIdWithDateFilter } from '../repositories/donationRepository';

/** Regex kiem tra dinh dang dia chi vi Ethereum. */
const WALLET_REGEX = /^0x[a-fA-F0-9]{40}$/;

const logger = getLogger();

/**
 * CẢNH BÁO PII & BẢO MẬT CACHE:
 * ---------------------------------------------------------------------------
 * In-memory cache lưu trữ toàn bộ JSON response bao gồm:
 * - walletAddress: địa chỉ ví blockchain
 * - amountVnd: số tiền giao dịch
 * - payosOrderCode: mã đơn PayOS
 * - correlationId: ID tương quan giao dịch
 * 
 * Trong production, Redis LUÔN phải available và được ưu tiên sử dụng.
 * In-memory cache chỉ là FALLBACK khi Redis không khả dụng.
 * KHÔNG nên sử dụng in-memory cache như primary cache trong production
 * vì:
 * 1. Không có TTL hiệu quả khi server restart
 * 2. Không chia sẻ được giữa các instances (multi-instance deployment)
 * 3. Tăng memory usage khi scale horizontally
 * ---------------------------------------------------------------------------
 */

const unifiedCachePrefix = 'transparency:unified:';
const unifiedCacheTimeToLiveSeconds = 120;
const unifiedCacheFallback = createInMemoryCache<string>({ maxEntries: 500 });
const MAX_PAGE_SIZE = 50;

export type TimelineEvent = {
  eventId: string;
  correlationId: string;
  eventType: 'DEPOSIT' | 'DONATION' | 'DISBURSEMENT' | 'MINT';
  timestamp: string;
  chainBlockNumber: number | null;
  amountVnd: number;
  chainStatus: 'PENDING' | 'CONFIRMED' | 'FAILED' | 'REORGED';
  chainTxHash: string | null;
  payosStatus: string | null;
  payosOrderCode: string | null;
  walletAddress: string;
  projectId: string;
  source: 'payos' | 'blockchain' | 'mixed';
};

export type UnifiedTimelineResponse = {
  timeline: TimelineEvent[];
  nextCursor: string | null;
  cached: boolean;
  count: number;
  fallbackMode: boolean;
};

export type UnifiedTimelineQuery = {
  projectId?: string;
  walletAddress?: string;
  startDate?: string;
  endDate?: string;
  cursor?: string;
  limit?: number;
};

function buildCacheKey(query: UnifiedTimelineQuery, validatedWallet: string | undefined): string {
  const limit = Math.min(query.limit || MAX_PAGE_SIZE, MAX_PAGE_SIZE);
  return `${unifiedCachePrefix}${
    [
      query.projectId || 'all',
      validatedWallet || 'all',
      query.startDate || 'none',
      query.endDate || 'none',
      String(limit)
    ].join(':')
  }`;
}

async function getCache(cacheKey: string): Promise<string | null> {
  const redisClient = getRedisClientIfReady();
  if (redisClient) {
    try {
      const cached = await redisClient.get(cacheKey);
      if (cached) return cached;
    } catch (err) {
      logger.warn('Redis get unified timeline cache failed.', {
        errorMessage: err instanceof Error ? err.message : String(err)
      });
    }
  }
  return unifiedCacheFallback.get(cacheKey);
}

async function setCache(cacheKey: string, json: string): Promise<void> {
  const redisClient = getRedisClientIfReady();
  if (redisClient) {
    try {
      await redisClient.set(cacheKey, json, { EX: unifiedCacheTimeToLiveSeconds });
      return;
    } catch (err) {
      logger.warn('Redis set unified timeline cache failed.', {
        errorMessage: err instanceof Error ? err.message : String(err)
      });
    }
  }
  unifiedCacheFallback.set(cacheKey, json, unifiedCacheTimeToLiveSeconds);
}

function toTimelineEvent(doc: Record<string, unknown>): TimelineEvent {
  const rawSource = String(doc.source || '');
  let source: TimelineEvent['source'] = 'mixed';
  if (rawSource === 'BLOCKCHAIN') source = 'blockchain';
  else if (rawSource === 'PAYOS') source = 'payos';

  const chainStatus = String(doc.chainStatus || 'PENDING') as TimelineEvent['chainStatus'];
  const validStatuses: TimelineEvent['chainStatus'][] = ['PENDING', 'CONFIRMED', 'FAILED', 'REORGED'];
  const normalizedChainStatus = validStatuses.includes(chainStatus) ? chainStatus : 'PENDING';

  const tsRaw = doc.eventTimestamp as Date | string;
  const ts = tsRaw instanceof Date ? tsRaw.toISOString() : String(tsRaw);

  const amountVndRaw = doc.amountVnd;
  const amountVnd = amountVndRaw !== null && amountVndRaw !== undefined
    ? Number(amountVndRaw)
    : Number(doc.amount) || 0;

  return {
    eventId: String(doc.utxId || doc._id || ''),
    correlationId: String(doc.correlationId || ''),
    eventType: String(doc.eventType || 'DONATION') as TimelineEvent['eventType'],
    timestamp: ts,
    chainBlockNumber: doc.chainBlockNumber != null ? Number(doc.chainBlockNumber) : null,
    amountVnd,
    chainStatus: normalizedChainStatus,
    chainTxHash: doc.chainTxHash as string | null,
    payosStatus: doc.payosStatus as string | null,
    payosOrderCode: doc.payosOrderCode as string | null,
    walletAddress: String(doc.walletAddress || ''),
    projectId: String(doc.projectId || ''),
    source
  };
}

function blockchainDonationToEvent(donation: DonationRecord): TimelineEvent {
  const correlationId = donation.correlationId || `donation:${donation.transactionHash}`;
  return {
    eventId: `blockchain:${donation.transactionHash}`,
    correlationId,
    eventType: 'DONATION',
    timestamp: donation.timestamp.toISOString(),
    chainBlockNumber: donation.blockNumber,
    amountVnd: donation.amount,
    chainStatus: 'CONFIRMED',
    chainTxHash: donation.transactionHash,
    payosStatus: null,
    payosOrderCode: null,
    walletAddress: donation.donorAddress,
    projectId: donation.projectId,
    source: 'blockchain'
  };
}

async function fallbackFromBlockchain(query: UnifiedTimelineQuery, limit: number): Promise<TimelineEvent[]> {
  if (!query.projectId) return [];

  const donations = await findDonationsByProjectIdWithDateFilter(query.projectId, {
    startDate: query.startDate ? new Date(query.startDate) : undefined,
    endDate: query.endDate ? new Date(query.endDate) : undefined,
    walletAddress: query.walletAddress,
    limit: limit * 3
  });

  let events: TimelineEvent[] = donations
    .map(d => blockchainDonationToEventFromRepo(d));

  events.sort((a, b) => {
    const tA = new Date(a.timestamp).getTime();
    const tB = new Date(b.timestamp).getTime();
    if (tA !== tB) return tA - tB;
    return a.eventId.localeCompare(b.eventId);
  });

  let startIndex = 0;
  if (query.cursor) {
    const decoded = decodeCursor(query.cursor);
    if (decoded) {
      const cursorTime = decoded.timestamp.getTime();
      const found = events.findIndex(e => new Date(e.timestamp).getTime() > cursorTime);
      startIndex = found === -1 ? events.length : found;
    }
  }

  return events.slice(startIndex, startIndex + limit);
}

/**
 * Chuyen doi donation tu repository thanh TimelineEvent
 * @param donation Donation tu repository voi cac truong da duoc rename
 */
function blockchainDonationToEventFromRepo(donation: {
  _id: string;
  amount: number;
  timestamp: Date;
  walletAddress: string;
  txHash: string;
  projectId: string;
}): TimelineEvent {
  const correlationId = `donation:${donation.txHash}`;
  return {
    eventId: `blockchain:${donation.txHash}`,
    correlationId,
    eventType: 'DONATION',
    timestamp: donation.timestamp.toISOString(),
    chainBlockNumber: null,
    amountVnd: donation.amount,
    chainStatus: 'CONFIRMED',
    chainTxHash: donation.txHash,
    payosStatus: null,
    payosOrderCode: null,
    walletAddress: donation.walletAddress,
    projectId: donation.projectId,
    source: 'blockchain'
  };
}

/**
 * Ham chinh: xay dung unified timeline.
 * Thu tu:
 * 1. Doc tu cache (neu khong co cursor)
 * 2. Query tu unified_transactions collection (thong qua repository)
 * 3. Neu rong -> fallback query blockchain donations
 * 4. Tao nextCursor
 * 5. Cache result (neu khong co cursor)
 */
export async function buildUnifiedTimeline(
  query: UnifiedTimelineQuery
): Promise<UnifiedTimelineResponse> {
  const limit = Math.min(query.limit || MAX_PAGE_SIZE, MAX_PAGE_SIZE);

  // Kiem tra dinh dang dia chi vi truoc khi query
  let validatedWalletAddress = query.walletAddress;
  if (query.walletAddress && !WALLET_REGEX.test(query.walletAddress)) {
    logger.warn('Invalid wallet address format, skipping filter.', {
      walletAddress: `${query.walletAddress.substring(0, 6)}...[REDACTED]`
    });
    validatedWalletAddress = undefined;
  }

  const cacheKey = buildCacheKey(query, validatedWalletAddress);

  if (!query.cursor) {
    const cached = await getCache(cacheKey);
    if (cached) {
      logger.info('Unified timeline cache hit.', { projectId: query.projectId });
      const parsed = JSON.parse(cached) as UnifiedTimelineResponse;
      return { ...parsed, cached: true };
    }
    logger.info('Unified timeline cache miss.', { projectId: query.projectId });
  }

  // Chuyen doi query params sang dinh dang cua repository (Date objects)
  const repoParams = {
    projectId: query.projectId,
    walletAddress: validatedWalletAddress,
    startDate: query.startDate ? new Date(query.startDate) : undefined,
    endDate: query.endDate ? new Date(query.endDate) : undefined
  };

  const repoResult = await findUnifiedTimeline(repoParams, limit, query.cursor);

  let events: TimelineEvent[];
  let isFallbackMode = false;
  if (repoResult.items.length > 0) {
    events = repoResult.items.map(item => toTimelineEvent(item as unknown as Record<string, unknown>));
  } else {
    logger.info('Unified collection empty, using fallback.', {
      projectId: query.projectId,
      walletAddress: validatedWalletAddress
        ? `${validatedWalletAddress.substring(0, 6)}...[REDACTED]`
        : undefined
    });
    events = await fallbackFromBlockchain(query, limit);
    isFallbackMode = true;
  }

  let nextCursor: string | null = null;
  if (events.length === limit) {
    const last = events[events.length - 1];
    nextCursor = encodeCursor(new Date(last.timestamp), last.eventId);
  }

  const response: UnifiedTimelineResponse = {
    timeline: events,
    nextCursor,
    cached: false,
    count: events.length,
    fallbackMode: isFallbackMode
  };

  if (!query.cursor) {
    try {
      await setCache(cacheKey, JSON.stringify(response));
    } catch (err) {
      logger.warn('Failed to cache unified timeline response.', {
        errorMessage: err instanceof Error ? err.message : String(err)
      });
    }
  }

  return response;
}

/**
 * Xoa cache khi co transaction moi duoc sync.
 * 
 * LUU Y: Han che su dung SCAN thay vi KEYS trong production.
 * - KEYS pattern la O(N) va BLOCK Redis trong qua trinh scan - NGUY HIEM cho production.
 * - SCAN la iterator-based, chi tra ve 1 tap nho keys moi lan goi, khong block Redis.
 * - Tradeoff: SCAN co the miss keys neu co write race nhung nhanh chong hon
 *   trong truong hop binh thuong.
 * - In production, neu Redis co nhieu keys (>10k), bat buoc phai dung SCAN.
 * - Do cache invalidation la low-frequency (chi khi sync transaction moi), 
 *   KEYS van duoc su dung nhung voi warning nay de developer awareness.
 */
export async function invalidateUnifiedTimelineCache(projectId?: string): Promise<void> {
  const redisClient = getRedisClientIfReady();

  if (redisClient) {
    try {
      const pattern = projectId
        ? `${unifiedCachePrefix}${projectId}:*`
        : `${unifiedCachePrefix}*`;
      
      // Su dung SCAN iterator thay vi scanStream (da bi loai bo khoi redis@5.12.0)
      // COUNT = 100 nghia la lay 100 keys moi vong lap, balance giua toc do va performance
      const keyList: string[] = [];
      for await (const batch of redisClient.scanIterator({ MATCH: pattern, COUNT: 100 })) {
        keyList.push(...batch);
      }

      if (keyList.length > 0) {
        // redis@5 del accepts multiple keys but types don't reflect this - use spread assertion
        const delCommand = redisClient.del as (...keys: string[]) => Promise<number>;
        await delCommand(...keyList);
        logger.info('Unified timeline cache invalidated via Redis SCAN.', { 
          projectId
        });
      }
    } catch (err) {
      logger.warn('Redis invalidate unified timeline cache failed.', {
        errorMessage: err instanceof Error ? err.message : String(err)
      });
    }
  }

  unifiedCacheFallback.clearAll();
}

/** Alias cho ten function duoc dung boi controller */
export function getUnifiedTimeline(
  params: {
    projectId?: string;
    walletAddress?: string;
    startDate?: string;
    endDate?: string;
  },
  pageSize: number,
  cursor?: string
) {
  return buildUnifiedTimeline({ ...params, limit: pageSize, cursor });
}

/** Group events theo correlationId de show connected flow */
export function groupTimelineByCorrelation(events: TimelineEvent[]): Map<string, TimelineEvent[]> {
  const grouped = new Map<string, TimelineEvent[]>();
  for (const event of events) {
    const existing = grouped.get(event.correlationId) || [];
    existing.push(event);
    grouped.set(event.correlationId, existing);
  }
  return grouped;
}
