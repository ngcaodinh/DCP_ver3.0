/**
 * Service xây dựng unified timeline — JOIN dữ liệu PayOS với blockchain events
 * theo correlationId, trả về chuỗi sự kiện liền mạch.
 *
 * Mục đích: phục vụ tầng Unified Transparency Layer (Lane D) — D1.
 *
 * Pagination: cursor-based, cursor = base64(timestampISO + "_" + id)
 * Cache: Redis TTL 2 phút, key = `transparency:unified:{projectId}`
 */
import { getLogger } from '../config/logger';
import { getRedisClientIfReady } from '../config/redis';
import { createInMemoryCache } from '../utils/inMemoryCache';
import { signCachePayload, verifyCachePayload } from '../utils/cacheIntegrity';
import {
  encodeCursor,
  decodeCursor,
  findUnifiedTimeline
} from '../repositories/unifiedTransactionRepository';
import { findDonationsByProjectIdWithDateFilter } from '../repositories/donationRepository';

/** Regex kiểm tra định dạng địa chỉ ví Ethereum. */
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
 *
 * F2 fix: Toàn bộ payload cache được ký HMAC để đảm bảo integrity.
 * Nếu Redis bị xâm nhập hoặc in-memory bị dump, attacker không thể sửa payload
 * mà không phá HMAC secret.
 * ---------------------------------------------------------------------------
 */

const unifiedCachePrefix = 'transparency:unified:';
const unifiedCacheTimeToLiveSeconds = 120;
const unifiedCacheFallback = createInMemoryCache<string>({ maxEntries: 500 });
const MAX_PAGE_SIZE = 50;

/** Escape ký tự glob của Redis để projectId không thể mở rộng phạm vi SCAN. */
function escapeRedisScanPattern(value: string): string {
  return value.replace(/[\\*?\[\]]/g, '\\$&');
}

export type TimelineEvent = {
  eventId: string;
  correlationId: string;
  eventType: 'DEPOSIT' | 'DONATION' | 'DISBURSEMENT' | 'MINT' | 'UNKNOWN';
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

/**
 * Tạo cache key từ query và wallet đã canonicalize (lowercase).
 * Cần phải nhận canonicalWallet (lowercase) để đảm bảo key đồng nhất
 * giữa các request cùng một ví (F1 fix).
 */
function buildCacheKey(query: UnifiedTimelineQuery, canonicalWallet: string | undefined): string {
  const limit = Math.min(query.limit || MAX_PAGE_SIZE, MAX_PAGE_SIZE);
  return `${unifiedCachePrefix}${
    [
      query.projectId || 'all',
      canonicalWallet || 'all',
      query.startDate || 'none',
      query.endDate || 'none',
      String(limit)
    ].join(':')
  }`;
}

/**
 * Đọc payload đã ký HMAC từ cache. Trả về UnifiedTimelineResponse nếu signature hợp lệ.
 * F2 fix: verify HMAC trước khi parse JSON để ngăn attacker inject payload giả.
 * Nếu signature không hợp lệ, return null (cache miss an toàn).
 */
async function getCache(cacheKey: string): Promise<string | null> {
  const redisClient = getRedisClientIfReady();
  let signed: string | null = null;
  if (redisClient) {
    try {
      signed = await redisClient.get(cacheKey);
    } catch (err) {
      logger.warn('Redis get unified timeline cache failed.', {
        errorMessage: err instanceof Error ? err.message : String(err)
      });
    }
  }
  if (!signed) {
    signed = unifiedCacheFallback.get(cacheKey);
  }
  if (!signed) return null;

  const verifiedPayload = verifyCachePayload(signed, cacheKey);
  if (verifiedPayload === null) {
    // Payload bị tamper hoặc ký không hợp lệ — xóa khỏi cache để tránh retry liên tục
    logger.warn('Unified timeline cache HMAC verification failed, dropping entry.', { cacheKey });
    try {
      if (redisClient) await redisClient.del(cacheKey);
    } catch {
      // Bỏ qua nếu Redis lỗi
    }
    unifiedCacheFallback.deleteByKey(cacheKey);
    return null;
  }
  return verifiedPayload;
}

/**
 * Ghi payload vào cache với HMAC signature (F2 fix).
 * Signature được tính trên payload JSON, sau đó lưu dạng "payload.signature".
 */
async function setCache(cacheKey: string, json: string): Promise<void> {
  const signed = signCachePayload(json, cacheKey);
  const redisClient = getRedisClientIfReady();
  if (redisClient) {
    try {
      await redisClient.set(cacheKey, signed, { EX: unifiedCacheTimeToLiveSeconds });
      return;
    } catch (err) {
      logger.warn('Redis set unified timeline cache failed.', {
        errorMessage: err instanceof Error ? err.message : String(err)
      });
    }
  }
  unifiedCacheFallback.set(cacheKey, signed, unifiedCacheTimeToLiveSeconds);
}

/**
 * Chuyển đổi document từ unified_transactions thành TimelineEvent.
 *
 * F12 fix: thay vì fallback âm thầm sang DONATION khi eventType không hợp lệ
 * (gây sai lệch tổng tiền quyên góp), chúng ta tách thành type 'UNKNOWN'
 * để có thể lọc ra khỏi aggregate summary ngoài giao diện.
 *
 * Nếu chainStatus không hợp lệ, mặc định về 'PENDING' (an toàn, không ảnh hưởng tiền).
 */
function toTimelineEvent(doc: Record<string, unknown>): TimelineEvent {
  const rawSource = String(doc.source || '');
  let source: TimelineEvent['source'] = 'mixed';
  if (rawSource === 'BLOCKCHAIN') source = 'blockchain';
  else if (rawSource === 'PAYOS') source = 'payos';

  const chainStatus = String(doc.chainStatus || 'PENDING') as TimelineEvent['chainStatus'];
  const validChainStatuses: TimelineEvent['chainStatus'][] = ['PENDING', 'CONFIRMED', 'FAILED', 'REORGED'];
  const normalizedChainStatus = validChainStatuses.includes(chainStatus) ? chainStatus : 'PENDING';

  // F12 fix: nếu eventType không hợp lệ, dùng 'UNKNOWN' thay vì 'DONATION' để không
  // làm sai lệch aggregate. Caller (UI/aggregate) có thể lọc ra type UNKNOWN.
  const rawEventType = String(doc.eventType || '');
  const validEventTypes: TimelineEvent['eventType'][] = ['DEPOSIT', 'DONATION', 'DISBURSEMENT', 'MINT'];
  const normalizedEventType: TimelineEvent['eventType']
    = (validEventTypes as string[]).includes(rawEventType)
      ? rawEventType as TimelineEvent['eventType']
      : 'UNKNOWN' as unknown as TimelineEvent['eventType'];

  const tsRaw = doc.eventTimestamp as Date | string;
  const ts = tsRaw instanceof Date ? tsRaw.toISOString() : String(tsRaw);

  const amountVndRaw = doc.amountVnd;
  const amountVnd = amountVndRaw !== null && amountVndRaw !== undefined
    ? Number(amountVndRaw)
    : Number(doc.amount) || 0;

  return {
    eventId: String(doc.utxId || doc._id || ''),
    correlationId: String(doc.correlationId || ''),
    eventType: normalizedEventType,
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

async function fallbackFromBlockchain(query: UnifiedTimelineQuery, limit: number): Promise<TimelineEvent[]> {
  if (!query.projectId) return [];

  const donations = await findDonationsByProjectIdWithDateFilter(query.projectId, {
    startDate: query.startDate ? new Date(query.startDate) : undefined,
    endDate: query.endDate ? new Date(query.endDate) : undefined,
    walletAddress: query.walletAddress ? query.walletAddress.toLowerCase() : undefined,
    limit: limit * 3
  });

  const events: TimelineEvent[] = donations
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
      // Dùng đủ hai phần của keyset cursor để không bỏ sót event trùng timestamp.
      const found = events.findIndex(event => {
        const eventTime = new Date(event.timestamp).getTime();
        return eventTime > cursorTime
          || (eventTime === cursorTime && event.eventId > decoded.documentId);
      });
      startIndex = found === -1 ? events.length : found;
    }
  }

  return events.slice(startIndex, startIndex + limit);
}

/**
 * Chuyển đổi donation từ repository thành TimelineEvent
 * @param donation Donation từ repository với các trường đã được rename
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
 * Hàm chính: xây dựng unified timeline.
 * Thứ tự:
 * 1. Validate và canonicalize input (walletAddress → lowercase)
 * 2. Đọc từ cache (nếu không có cursor)
 * 3. Query từ unified_transactions collection (thông qua repository)
 * 4. Nếu rỗng -> fallback query blockchain donations
 * 5. Tạo nextCursor
 * 6. Cache result (nếu không có cursor)
 *
 * F1 fix: walletAddress được canonicalize về lowercase TẠI SERVICE (sau regex validation).
 * Đây là điểm duy nhất để canonicalize, repository không tự lowercase.
 *
 * F8 fix: phân biệt "không có data" (fallback mode) vs "query error" (throw).
 * Nếu findUnifiedTimeline throw → log + propagate error để controller trả 500
 * (trước đây: silent fail-open có thể gây data divergence).
 */
export async function buildUnifiedTimeline(
  query: UnifiedTimelineQuery
): Promise<UnifiedTimelineResponse> {
  const limit = Math.min(query.limit || MAX_PAGE_SIZE, MAX_PAGE_SIZE);

  // F1 fix: canonicalize walletAddress SAU regex validation
  // (service là điểm duy nhất chịu trách nhiệm chuẩn hóa, repo không tự lowercase).
  let canonicalWalletAddress = query.walletAddress;
  if (query.walletAddress) {
    if (WALLET_REGEX.test(query.walletAddress)) {
      canonicalWalletAddress = query.walletAddress.toLowerCase();
    } else {
      logger.warn('Invalid wallet address format, skipping filter.', {
        walletAddress: `${query.walletAddress.substring(0, 6)}...[REDACTED]`
      });
      canonicalWalletAddress = undefined;
    }
  }

  const cacheKey = buildCacheKey(query, canonicalWalletAddress);

  if (!query.cursor) {
    const cached = await getCache(cacheKey);
    if (cached) {
      logger.info('Unified timeline cache hit.', { projectId: query.projectId });
      const parsed = JSON.parse(cached) as UnifiedTimelineResponse;
      return { ...parsed, cached: true };
    }
    logger.info('Unified timeline cache miss.', { projectId: query.projectId });
  }

  // Chuyển đổi query params sang định dạng của repository (Date objects)
  const repoParams = {
    projectId: query.projectId,
    walletAddress: canonicalWalletAddress,
    startDate: query.startDate ? new Date(query.startDate) : undefined,
    endDate: query.endDate ? new Date(query.endDate) : undefined
  };

  // F8 fix: phân biệt "query error" vs "no data".
  // Nếu repo throw → log error, propagate để controller trả 500.
  // Nếu repo trả rỗng → fallback blockchain (có thể có data ngay lập tức).
  let repoResult;
  try {
    repoResult = await findUnifiedTimeline(repoParams, limit, query.cursor);
  } catch (err) {
    logger.error('Unified timeline repository query failed.', {
      errorMessage: err instanceof Error ? err.message : String(err),
      projectId: query.projectId
    });
    throw err;
  }

  let events: TimelineEvent[];
  let isFallbackMode = false;
  if (repoResult.items.length > 0) {
    events = repoResult.items.map(item => toTimelineEvent(item as unknown as Record<string, unknown>));
  } else {
    logger.info('Unified collection empty, using fallback.', {
      projectId: query.projectId,
      walletAddress: canonicalWalletAddress
        ? `${canonicalWalletAddress.substring(0, 6)}...[REDACTED]`
        : undefined
    });
    events = await fallbackFromBlockchain(query, limit);
    isFallbackMode = true;
  }

  // F13 fix: nextCursor phải dùng correlationId hoặc utxId để nhận diện item, không phải eventId
  // Vì eventId từ blockchain fallback có format 'blockchain:${txHash}' không phải utxId.
  // Sử dụng correlationId để backward-compatible với cả hai nhánh (unified + fallback).
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
 * Xóa cache khi có transaction mới được sync.
 *
 * Khi biết projectId, chỉ xóa các key thuộc project đó; khi không biết phạm vi,
 * mới xóa toàn bộ namespace để bảo đảm không giữ dữ liệu cũ.
 *
 * LƯU Ý: Hạn chế sử dụng SCAN thay vì KEYS trong production.
 * - KEYS pattern là O(N) và BLOCK Redis trong quá trình scan - NGUY HIỂM cho production.
 * - SCAN là iterator-based, chỉ trả về 1 tập nhỏ keys mỗi lần gọi, không block Redis.
 * - Tradeoff: SCAN có thể miss keys nếu có write race nhưng nhanh chóng hơn
 *   trong trường hợp bình thường.
 * - In production, nếu Redis có nhiều keys (>10k), bắt buộc phải dùng SCAN.
 * Khi có projectId, xóa các key của project đó và namespace `all` cùng lúc.
 */
export async function invalidateUnifiedTimelineCache(projectId?: string): Promise<void> {
  const redisClient = getRedisClientIfReady();
  const normalizedProjectId = projectId?.trim();
  // Query không có projectId dùng namespace `all`, nên phải xóa cùng lúc với
  // namespace project cụ thể để timeline tổng hợp không giữ dữ liệu cũ.
  const patternList = normalizedProjectId
    ? Array.from(new Set([
        `${unifiedCachePrefix}${escapeRedisScanPattern(normalizedProjectId)}:*`,
        `${unifiedCachePrefix}all:*`
      ]))
    : [`${unifiedCachePrefix}*`];

  if (redisClient) {
    try {
      // Sử dụng SCAN iterator thay vì scanStream (đã bị loại bỏ khỏi redis@5.12.0)
      // COUNT = 100 nghĩa là lấy 100 keys mỗi vòng lặp, balance giữa tốc độ và performance
      const keySet = new Set<string>();
      for (const pattern of patternList) {
        for await (const batch of redisClient.scanIterator({ MATCH: pattern, COUNT: 100 })) {
          for (const key of batch) keySet.add(String(key));
        }
      }
      const keyList = [...keySet];

      if (keyList.length > 0) {
        // redis@5 del accepts multiple keys but types don't reflect this - use spread assertion
        const delCommand = redisClient.del as (...keys: string[]) => Promise<number>;
        await delCommand(...keyList);
        logger.info('Unified timeline cache invalidated via Redis SCAN.', {
          projectId: normalizedProjectId,
          keysDeleted: keyList.length
        });
      }
    } catch (err) {
      logger.warn('Redis invalidate unified timeline cache failed.', {
        errorMessage: err instanceof Error ? err.message : String(err)
      });
    }
  }

  if (normalizedProjectId) {
    unifiedCacheFallback.deleteByPrefix(`${unifiedCachePrefix}${normalizedProjectId}:`);
    unifiedCacheFallback.deleteByPrefix(`${unifiedCachePrefix}all:`);
  } else {
    unifiedCacheFallback.clearAll();
  }
}

/** Alias cho tên function được dùng bởi controller */
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

/** Group events theo correlationId để show connected flow */
export function groupTimelineByCorrelation(events: TimelineEvent[]): Map<string, TimelineEvent[]> {
  const grouped = new Map<string, TimelineEvent[]>();
  for (const event of events) {
    const existing = grouped.get(event.correlationId) || [];
    existing.push(event);
    grouped.set(event.correlationId, existing);
  }
  return grouped;
}
