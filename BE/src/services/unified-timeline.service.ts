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
  UnifiedTransactionModel
} from '../models/unifiedTransactionModel';
import {
  encodeCursor,
  decodeCursor
} from '../repositories/unifiedTransactionRepository';

const logger = getLogger();

const unifiedCachePrefix = 'transparency:unified:';
const unifiedCacheTimeToLiveSeconds = 120;
const unifiedCacheFallback = createInMemoryCache<string>();
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
};

export type UnifiedTimelineQuery = {
  projectId?: string;
  walletAddress?: string;
  startDate?: string;
  endDate?: string;
  cursor?: string;
  limit?: number;
};

function buildCacheKey(query: UnifiedTimelineQuery): string {
  const limit = Math.min(query.limit || MAX_PAGE_SIZE, MAX_PAGE_SIZE);
  return `${unifiedCachePrefix}${
    [
      query.projectId || 'all',
      query.walletAddress || 'all',
      query.startDate || 'none',
      query.endDate || 'none',
      query.cursor || 'none',
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
    chainBlockNumber: null,
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

async function queryFromUnified(query: UnifiedTimelineQuery, limit: number): Promise<Record<string, unknown>[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const filter: Record<string, any> = {};

  if (query.projectId) filter.projectId = query.projectId;
  if (query.walletAddress) filter.walletAddress = query.walletAddress.toLowerCase();

  if (query.startDate || query.endDate) {
    filter.eventTimestamp = {};
    if (query.startDate) {
      (filter.eventTimestamp as Record<string, Date>)['$gte'] = new Date(query.startDate);
    }
    if (query.endDate) {
      (filter.eventTimestamp as Record<string, Date>)['$lte'] = new Date(query.endDate);
    }
  }

  if (query.cursor) {
    const decoded = decodeCursor(query.cursor);
    if (decoded) {
      // Sort ASC (1) -> page tiep theo can records MOI HON (timestamp lon hon)
      filter.$and = [
        filter.eventTimestamp ? { eventTimestamp: filter.eventTimestamp } : {},
        {
          $or: [
            { eventTimestamp: { $gt: decoded.timestamp } },
            {
              eventTimestamp: decoded.timestamp,
              utxId: { $gt: decoded.documentId }
            }
          ]
        }
      ];
      delete filter.eventTimestamp;
    }
  }

  return UnifiedTransactionModel.find(filter)
    .sort({ eventTimestamp: 1, utxId: 1 })
    .limit(limit)
    .lean<Record<string, unknown>[]>()
    .exec();
}

async function fallbackFromBlockchain(query: UnifiedTimelineQuery, limit: number): Promise<TimelineEvent[]> {
  if (!query.projectId) return [];

  const { findDonationsByProjectId } = await import('../models/donationModel');
  const donations = await findDonationsByProjectId(query.projectId, 1000);

  let events: TimelineEvent[] = donations
    .filter(d => {
      if (query.walletAddress && d.donorAddress.toLowerCase() !== query.walletAddress.toLowerCase()) return false;
      if (query.startDate && new Date(d.timestamp) < new Date(query.startDate)) return false;
      if (query.endDate && new Date(d.timestamp) > new Date(query.endDate)) return false;
      return true;
    })
    .map(d => blockchainDonationToEvent(d));

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
 * Ham chinh: xay dung unified timeline.
 * Thu tu:
 * 1. Doc tu cache (neu khong co cursor)
 * 2. Query tu unified_transactions collection
 * 3. Neu rong -> fallback query blockchain donations
 * 4. Tao nextCursor
 * 5. Cache result (neu khong co cursor)
 */
export async function buildUnifiedTimeline(
  query: UnifiedTimelineQuery
): Promise<UnifiedTimelineResponse> {
  const limit = Math.min(query.limit || MAX_PAGE_SIZE, MAX_PAGE_SIZE);
  const cacheKey = buildCacheKey(query);

  if (!query.cursor) {
    const cached = await getCache(cacheKey);
    if (cached) {
      logger.info('Unified timeline cache hit.', { projectId: query.projectId });
      const parsed = JSON.parse(cached) as UnifiedTimelineResponse;
      return { ...parsed, cached: true };
    }
    logger.info('Unified timeline cache miss.', { projectId: query.projectId });
  }

  const unifiedDocs = await queryFromUnified(query, limit);

  let events: TimelineEvent[];
  if (unifiedDocs.length > 0) {
    events = unifiedDocs.map(doc => toTimelineEvent(doc));
  } else {
    logger.info('Unified collection empty, using fallback.', { projectId: query.projectId });
    events = await fallbackFromBlockchain(query, limit);
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
    count: events.length
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
 */
export async function invalidateUnifiedTimelineCache(projectId?: string): Promise<void> {
  const redisClient = getRedisClientIfReady();

  if (redisClient) {
    try {
      const pattern = projectId
        ? `${unifiedCachePrefix}${projectId}:*`
        : `${unifiedCachePrefix}*`;
      const keyList = await redisClient.keys(pattern);
      if (keyList.length > 0) {
        await redisClient.del(keyList);
        logger.info('Unified timeline cache invalidated via Redis.', { projectId });
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
