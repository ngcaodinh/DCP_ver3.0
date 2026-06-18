import crypto from 'crypto';
import {
  UnifiedTransactionModel,
  UnifiedTransaction,
  UnifiedEventType,
  UnifiedChainStatus,
  UnifiedPayosStatus
} from '../models/unifiedTransactionModel';

/** Cac tham so truy van timeline voi cursor-based pagination. */
export type UnifiedTimelineQueryParams = {
  projectId?: string;
  walletAddress?: string;
  startDate?: Date;
  endDate?: Date;
};

/** Ket qua paginated cho unified timeline. */
export type UnifiedTimelineResult = {
  items: UnifiedTransaction[];
  nextCursor: string | null;
  totalCount: number;
};

/** Tao correlation ID tu order code PayOS. */
export function buildPayosCorrelationId(orderCode: string): string {
  return `deposit:${orderCode}`;
}

/** Tao correlation ID tu transaction hash blockchain. */
export function buildBlockchainCorrelationId(txHash: string): string {
  return `donation:${txHash.toLowerCase()}`;
}

/**
 * Ma hoa cursor tu timestamp va document ID.
 * Format: base64(timestampISO + "\x00" + utxId)
 * Su dung null char (\x00) lam separator vi khong xuat hien trong UUID hoac timestamp ISO.
 * Opake, stable, concurrent-write-safe.
 */
export function encodeCursor(timestamp: Date, documentId: string): string {
  return Buffer.from(`${timestamp.toISOString()}\x00${documentId}`).toString('base64');
}

/**
 * Giai ma cursor thanh timestamp va document ID.
 * Doc separator la null char (\x00) de tranh loi khi _id chua dau gach duoi.
 */
export function decodeCursor(
  cursor: string
): { timestamp: Date; documentId: string } | null {
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf-8');
    const separatorIndex = decoded.indexOf('\x00');
    if (separatorIndex === -1) return null;
    const timestampStr = decoded.slice(0, separatorIndex);
    const documentId = decoded.slice(separatorIndex + 1);
    const timestamp = new Date(timestampStr);
    if (isNaN(timestamp.getTime()) || !documentId) return null;
    return { timestamp, documentId };
  } catch {
    return null;
  }
}

/**
 * Lay danh sach unified transactions voi cursor-based pagination.
 * Sap xep theo eventTimestamp ASC, utxId ASC de hien thi timeline tang dan.
 * Cursor logic: $gt thay vi $lt vi sort ASC nghia la thoi gian tang dan.
 */
export async function findUnifiedTimeline(
  params: UnifiedTimelineQueryParams,
  pageSize: number,
  cursor?: string
): Promise<UnifiedTimelineResult> {
  const normalizedPageSize = Math.max(1, Math.min(50, Math.floor(pageSize)));
  const cursorData = cursor ? decodeCursor(cursor) : undefined;

  const filterQuery: Record<string, unknown> = {};

  if (params.projectId) filterQuery.projectId = params.projectId;
  if (params.walletAddress) filterQuery.walletAddress = params.walletAddress.toLowerCase();

  if (params.startDate || params.endDate) {
    filterQuery.eventTimestamp = {};
    if (params.startDate) {
      (filterQuery.eventTimestamp as Record<string, Date>)['$gte'] = params.startDate;
    }
    if (params.endDate) {
      (filterQuery.eventTimestamp as Record<string, Date>)['$lte'] = params.endDate;
    }
  }

  if (cursorData) {
    filterQuery.$or = [
      { eventTimestamp: { $gt: cursorData.timestamp } },
      {
        eventTimestamp: cursorData.timestamp,
        utxId: { $gt: cursorData.documentId }
      }
    ];
  }

  const items = await UnifiedTransactionModel.find(filterQuery)
    .sort({ eventTimestamp: 1, utxId: 1 })
    .limit(normalizedPageSize + 1)
    .lean<UnifiedTransaction[]>()
    .exec();

  let nextCursor: string | null = null;
  if (items.length > normalizedPageSize) {
    const lastItem = items[normalizedPageSize - 1];
    nextCursor = encodeCursor(lastItem.eventTimestamp, lastItem.utxId);
    items.pop();
  }

  return { items, nextCursor, totalCount: items.length };
}

/** Dem tong unified transactions theo filter. */
export async function countUnifiedTimeline(
  params: UnifiedTimelineQueryParams
): Promise<number> {
  const filterQuery: Record<string, unknown> = {};

  if (params.projectId) filterQuery.projectId = params.projectId;
  if (params.walletAddress) filterQuery.walletAddress = params.walletAddress.toLowerCase();

  if (params.startDate || params.endDate) {
    filterQuery.eventTimestamp = {};
    if (params.startDate) {
      (filterQuery.eventTimestamp as Record<string, Date>)['$gte'] = params.startDate;
    }
    if (params.endDate) {
      (filterQuery.eventTimestamp as Record<string, Date>)['$lte'] = params.endDate;
    }
  }

  return UnifiedTransactionModel.countDocuments(filterQuery).exec();
}

/**
 * Chen moi unified transaction record.
 * Idempotent: kiem tra ton tai truoc khi insert.
 */
export async function insertUnifiedTransaction(
  record: Omit<UnifiedTransaction, 'createdAt' | 'updatedAt'>
): Promise<UnifiedTransaction> {
  const existing = await UnifiedTransactionModel.findOne({
    correlationId: record.correlationId
  }).lean<UnifiedTransaction>().exec();

  if (existing) {
    return existing as UnifiedTransaction;
  }

  const createdRecord = await UnifiedTransactionModel.create(record);
  return createdRecord.toObject() as UnifiedTransaction;
}

/**
 * Cap nhat unified transaction theo correlationId.
 * Idempotent: an toan khi worker chay lai sau crash.
 */
export async function upsertUnifiedTransactionByCorrelationId(
  correlationId: string,
  chainUpdate: Partial<UnifiedTransaction>
): Promise<UnifiedTransaction | null> {
  const updatedRecord = await UnifiedTransactionModel.findOneAndUpdate(
    { correlationId },
    { $set: chainUpdate },
    { returnDocument: 'after' }
  )
    .lean<UnifiedTransaction>()
    .exec();

  return (updatedRecord as UnifiedTransaction) || null;
}

/** Tao unified transaction record moi cho blockchain event. */
export async function createUnifiedTransactionFromBlockchain(
  correlationId: string,
  data: {
    projectId: string;
    walletAddress: string;
    eventType: UnifiedEventType;
    amountVnd: number;
    chainTxHash: string;
    chainBlockNumber: number;
    chainStatus?: UnifiedChainStatus;
    eventTimestamp: Date;
  }
): Promise<UnifiedTransaction> {
  const record: Omit<UnifiedTransaction, 'createdAt' | 'updatedAt'> = {
    utxId: crypto.randomUUID(),
    correlationId,
    projectId: data.projectId,
    walletAddress: data.walletAddress,
    eventType: data.eventType,
    amountVnd: data.amountVnd,
    eventTimestamp: data.eventTimestamp,
    source: 'BLOCKCHAIN',
    chainStatus: data.chainStatus ?? 'CONFIRMED',
    chainTxHash: data.chainTxHash,
    chainBlockNumber: data.chainBlockNumber,
    payosStatus: null,
    payosOrderCode: null,
    payosTransactionId: null,
    payosRecordId: null,
    blockchainRecordId: data.chainTxHash
  };

  return insertUnifiedTransaction(record);
}

/** Tao unified transaction record moi cho PayOS deposit. */
export async function createUnifiedTransactionFromPayos(
  correlationId: string,
  data: {
    projectId: string;
    walletAddress: string;
    eventType: UnifiedEventType;
    amountVnd: number;
    payosStatus: UnifiedPayosStatus;
    payosOrderCode: string;
    payosTransactionId?: string | null;
    payosRecordId?: string | null;
    eventTimestamp: Date;
  }
): Promise<UnifiedTransaction> {
  const record: Omit<UnifiedTransaction, 'createdAt' | 'updatedAt'> = {
    utxId: crypto.randomUUID(),
    correlationId,
    projectId: data.projectId,
    walletAddress: data.walletAddress,
    eventType: data.eventType,
    amountVnd: data.amountVnd,
    eventTimestamp: data.eventTimestamp,
    source: 'PAYOS',
    chainStatus: 'PENDING',
    chainTxHash: null,
    chainBlockNumber: null,
    payosStatus: data.payosStatus,
    payosOrderCode: data.payosOrderCode,
    payosTransactionId: data.payosTransactionId ?? null,
    payosRecordId: data.payosRecordId ?? null,
    blockchainRecordId: null
  };

  return insertUnifiedTransaction(record);
}

/** Tim unified transaction theo correlationId. */
export async function findUnifiedTransactionByCorrelationId(
  correlationId: string
): Promise<UnifiedTransaction | null> {
  const result = await UnifiedTransactionModel.findOne({ correlationId })
    .lean<UnifiedTransaction>()
    .exec();
  return (result as UnifiedTransaction) || null;
}

/** Cap nhat trang thai chain khi phat hien blockchain fork/reorg. */
export async function markChainTransactionReorged(
  chainTxHash: string
): Promise<number> {
  const result = await UnifiedTransactionModel.updateMany(
    { chainTxHash, chainStatus: { $ne: 'REORGED' } },
    { $set: { chainStatus: 'REORGED' } }
  ).exec();

  return result.modifiedCount;
}

/** Lay tong so duong tien theo projectId. */
export async function aggregateSummaryByProjectId(
  projectId: string
): Promise<{ totalRaisedVnd: number; totalTransactions: number }> {
  const aggregateResult = await UnifiedTransactionModel.aggregate<{
    totalRaisedVnd: number;
    totalTransactions: number;
  }>([
    { $match: { projectId } },
    {
      $group: {
        _id: null,
        totalRaisedVnd: { $sum: '$amountVnd' },
        totalTransactions: { $sum: 1 }
      }
    }
  ])
    .hint({ projectId: 1, eventTimestamp: 1 })
    .exec();

  if (!aggregateResult.length) {
    return { totalRaisedVnd: 0, totalTransactions: 0 };
  }

  return {
    totalRaisedVnd: aggregateResult[0].totalRaisedVnd,
    totalTransactions: aggregateResult[0].totalTransactions
  };
}
