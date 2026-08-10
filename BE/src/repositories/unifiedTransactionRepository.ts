import crypto from 'crypto';
import {
  UnifiedTransactionModel,
  UnifiedTransaction,
  UnifiedEventType,
  UnifiedChainStatus,
  UnifiedPayosStatus,
  isValidChainTxHash
} from '../models/unifiedTransactionModel';

/** Các tham số truy vấn timeline với cursor-based pagination. */
export type UnifiedTimelineQueryParams = {
  projectId?: string;
  walletAddress?: string;
  startDate?: Date;
  endDate?: Date;
};

/** Kết quả paginated cho unified timeline. */
export type UnifiedTimelineResult = {
  items: UnifiedTransaction[];
  nextCursor: string | null;
  totalCount: number;
};

/**
 * HMAC key sử dụng cho cursor signing.
 * Lấy từ env để có thể rotate mà không cần sửa code.
 * Trong production, key này được lưu trong secret manager (Vault/KMS).
 */
function getCursorHmacKey(): string {
  return String(process.env.UNIFIED_CURSOR_HMAC_KEY || '').trim()
    || String(process.env.JWT_SECRET || '').trim()
    || 'dcp-cursor-hmac-default-rotate-me';
}

/**
 * Tạo HMAC signature cho cursor.
 * Mục đích: defense-in-depth, ngăn attacker craft cursor tùy ý (F11).
 * @param input Chuỗi cần ký
 * @returns Hex digest 64 chars
 */
export function signCursorPayload(input: string): string {
  return crypto.createHmac('sha256', getCursorHmacKey()).update(input).digest('hex');
}

/** Tạo correlation ID từ order code PayOS. */
export function buildPayosCorrelationId(orderCode: string): string {
  return `deposit:${orderCode.toLowerCase()}`;
}

/** Tạo correlation ID từ transaction hash blockchain. */
export function buildBlockchainCorrelationId(txHash: string): string {
  return `donation:${txHash.toLowerCase()}`;
}

/**
 * Mã hóa cursor từ timestamp và document ID.
 * Format: base64(JSON {ts, id}) + "." + HMAC-SHA256(JSON)
 * HMAC signature đảm bảo client không thể craft cursor tùy ý để truy cập
 * trang khác (F11 fix - defense-in-depth). Verify signature trước khi giải mã.
 * Nếu HMAC không hợp lệ, decodeCursor trả về null để service fallback về trang đầu.
 */
export function encodeCursor(timestamp: Date, documentId: string): string {
  const payload = JSON.stringify({
    ts: timestamp.toISOString(),
    id: documentId
  });
  const encodedPayload = Buffer.from(payload).toString('base64url');
  const signature = signCursorPayload(encodedPayload);
  return `${encodedPayload}.${signature}`;
}

/**
 * Giải mã cursor và verify HMAC signature.
 * Trả về null nếu cursor không hợp lệ hoặc signature không khớp.
 */
export function decodeCursor(
  cursor: string
): { timestamp: Date; documentId: string } | null {
  try {
    const separatorIndex = cursor.lastIndexOf('.');
    if (separatorIndex === -1) return null;
    const encodedPayload = cursor.slice(0, separatorIndex);
    const providedSignature = cursor.slice(separatorIndex + 1);
    if (!encodedPayload || !providedSignature) return null;

    const expectedSignature = signCursorPayload(encodedPayload);
    // So sánh constant-time để tránh timing attack
    const providedBuffer = Buffer.from(providedSignature, 'utf-8');
    const expectedBuffer = Buffer.from(expectedSignature, 'utf-8');
    if (providedBuffer.length !== expectedBuffer.length) return null;
    if (!crypto.timingSafeEqual(providedBuffer, expectedBuffer)) return null;

    const decoded = Buffer.from(encodedPayload, 'base64url').toString('utf-8');
    const parsed = JSON.parse(decoded) as { ts?: string; id?: string };
    if (!parsed.ts || !parsed.id) return null;
    const timestamp = new Date(parsed.ts);
    if (isNaN(timestamp.getTime())) return null;
    return { timestamp, documentId: parsed.id };
  } catch {
    return null;
  }
}

/**
 * Lấy danh sách unified transactions với cursor-based pagination.
 * Sắp xếp theo eventTimestamp ASC, utxId ASC để hiển thị timeline tăng dần.
 * Cursor logic: $gt thay vì $lt vì sort ASC nghĩa là thời gian tăng dần.
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
  // F1 fix: caller (service layer) chịu trách nhiệm chuẩn hóa walletAddress về lowercase.
  // Repository không tự lowercase để giữ boundary rõ ràng, tránh cache key và filter
  // bị lệch nhau nếu service sửa đổi logic canonicalization.
  if (params.walletAddress) filterQuery.walletAddress = params.walletAddress;

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

/** Đếm tổng unified transactions theo filter. */
export async function countUnifiedTimeline(
  params: UnifiedTimelineQueryParams
): Promise<number> {
  const filterQuery: Record<string, unknown> = {};

  if (params.projectId) filterQuery.projectId = params.projectId;
  if (params.walletAddress) filterQuery.walletAddress = params.walletAddress;

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
 * Chèn mới unified transaction record (idempotent).
 * Nếu correlationId đã tồn tại, trả về record hiện có.
 * Sử dụng findOneAndUpdate với upsert để tránh race condition TOCTOU
 * (Time-Of-Check-Time-Of-Use) khi nhiều workers chạy đồng thời.
 */
export async function insertUnifiedTransaction(
  record: Omit<UnifiedTransaction, 'createdAt' | 'updatedAt'>
): Promise<UnifiedTransaction> {
  const updatedRecord = await UnifiedTransactionModel.findOneAndUpdate(
    { correlationId: record.correlationId },
    { $setOnInsert: record },
    { upsert: true, returnDocument: 'after' }
  )
    .lean<UnifiedTransaction>()
    .exec();

  return (updatedRecord as UnifiedTransaction) || record as UnifiedTransaction;
}

/**
 * Cập nhật unified transaction theo correlationId.
 * Idempotent: an toàn khi worker chạy lại sau crash.
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

/**
 * Tạo unified transaction record mới cho blockchain event.
 * Validate txHash format trước khi insert để đảm bảo tính toàn vẹn.
 */
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
  if (!isValidChainTxHash(data.chainTxHash)) {
    throw new Error('Invalid chainTxHash format: must be a valid Ethereum transaction hash');
  }

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

/**
 * Tạo unified transaction record mới cho PayOS deposit.
 *
 * F4 fix: PayOS deposit KHÔNG gắn liền với project cụ thể — deposit thuộc về
 * user wallet, donation mới thuộc về project. Để tránh việc deposit "biến mất"
 * khỏi aggregateSummaryByProjectId (vì projectId rỗng không match), chúng ta:
 *   1. Chấp nhận `projectId` optional (mặc định '' cho deposit không gắn project)
 *   2. Schema relax required: true → validator ràng buộc chỉ chấp nhận string
 *      (cho phép empty string để tương thích ngược với data cũ)
 *   3. aggregateSummaryByProjectId chỉ đếm những record có projectId khác rỗng
 *
 * Boundary: service/repository insert deposit với projectId='' → aggregate
 * theo projectId thật sẽ không tính deposit (cố ý). Nếu sau muốn tính deposit
 * theo project (sau correlation), cần query theo walletAddress+amount thay vì projectId.
 */
export async function createUnifiedTransactionFromPayos(
  correlationId: string,
  data: {
    projectId?: string;
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
    projectId: data.projectId ?? '',
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

/** Tìm unified transaction theo correlationId. */
export async function findUnifiedTransactionByCorrelationId(
  correlationId: string
): Promise<UnifiedTransaction | null> {
  // F16 fix: chuẩn hóa lowercase để caller truyền mixed-case vẫn tìm thấy
  // (các build*CorrelationId đã tự lowercase ở đầu, nhưng caller có thể
  // truyền trực tiếp từ log/legacy path)
  const normalizedCorrelationId = String(correlationId || '').toLowerCase();
  const result = await UnifiedTransactionModel.findOne({ correlationId: normalizedCorrelationId })
    .lean<UnifiedTransaction>()
    .exec();
  return (result as UnifiedTransaction) || null;
}

/** Cập nhật trạng thái chain khi phát hiện blockchain fork/reorg. */
export async function markChainTransactionReorged(
  chainTxHash: string
): Promise<number> {
  const result = await UnifiedTransactionModel.updateMany(
    { chainTxHash, chainStatus: { $ne: 'REORGED' } },
    { $set: { chainStatus: 'REORGED' } }
  ).exec();

  return result.modifiedCount;
}

/**
 * Lấy tổng số dòng tiền theo projectId.
 *
 * F6 fix: sử dụng hint khớp với compound index { projectId: 1, eventTimestamp: 1, utxId: 1 }
 * (sau khi thêm index theo F3). Hint chỉ gọi index prefix { projectId: 1 } có thể
 * khiến Mongo phải sort in-memory nếu không có eventTimestamp trong index được chọn.
 * Thêm hint đầy đủ để Mongo planner chắc chắn đi theo IXSCAN và sort theo index.
 *
 * LƯU Ý: aggregate không thực hiện sort theo eventTimestamp (chỉ $group),
 * nên chỉ cần hint { projectId: 1 } là đủ cho $match. Tuy nhiên, sử dụng
 * compound hint { projectId: 1, eventTimestamp: 1, utxId: 1 } giữ tính nhất quán
 * với F3 và cho phép Mongo dùng sort theo index nếu sau này thêm $sort vào pipeline.
 */
export async function aggregateSummaryByProjectId(
  projectId: string
): Promise<{
  totalRaisedVnd: number;
  totalTransactions: number;
  uniqueDonorCount: number;
  excludedReorgedVnd: number;
  excludedReorgedCount: number;
}> {
  // F4 fix: chỉ tính các record có projectId thật (không phải deposit chưa correlate)
  // Deposit có projectId='' sẽ không được tính vào tổng tiền của dự án.
  // Sau khi correlation với blockchain donation, record deposit được cập nhật
  // thành source='MIXED' nhưng projectId vẫn giữ rỗng (chỉ blockchain donation mới có projectId).
  // Giao dịch bị revert trên blockchain không phải tiền thật, nhưng vẫn phải đếm được
  // để kiểm toán đối chiếu phần chênh lệch giữa dữ liệu gốc và tổng công khai.
  const aggregateResult = await UnifiedTransactionModel.aggregate<{
    totalRaisedVnd: number;
    totalTransactions: number;
    uniqueDonorCount: number;
    excludedReorgedVnd: number;
    excludedReorgedCount: number;
  }>([
    { $match: { projectId: { $eq: projectId, $ne: '' }, eventType: 'DONATION' } },
    {
      $group: {
        _id: null,
        totalRaisedVnd: {
          $sum: {
            $cond: [
              { $not: [{ $in: ['$chainStatus', ['REORGED', 'FAILED']] }] },
              '$amountVnd',
              0
            ]
          }
        },
        totalTransactions: {
          $sum: {
            $cond: [
              { $not: [{ $in: ['$chainStatus', ['REORGED', 'FAILED']] }] },
              1,
              0
            ]
          }
        },
        uniqueDonors: {
          $addToSet: {
            $cond: [
              { $not: [{ $in: ['$chainStatus', ['REORGED', 'FAILED']] }] },
              { $toLower: { $ifNull: ['$walletAddress', ''] } },
              ''
            ]
          }
        },
        excludedReorgedVnd: {
          $sum: {
            $cond: [
              { $eq: ['$chainStatus', 'REORGED'] },
              '$amountVnd',
              0
            ]
          }
        },
        excludedReorgedCount: {
          $sum: {
            $cond: [
              { $eq: ['$chainStatus', 'REORGED'] },
              1,
              0
            ]
          }
        }
      }
    },
    {
      $project: {
        _id: 0,
        totalRaisedVnd: 1,
        totalTransactions: 1,
        uniqueDonorCount: {
          $size: { $setDifference: ['$uniqueDonors', ['']] }
        },
        excludedReorgedVnd: 1,
        excludedReorgedCount: 1
      }
    }
  ])
    .hint({ projectId: 1, eventTimestamp: 1, utxId: 1 })
    .exec();

  if (!aggregateResult.length) {
    return {
      totalRaisedVnd: 0,
      totalTransactions: 0,
      uniqueDonorCount: 0,
      excludedReorgedVnd: 0,
      excludedReorgedCount: 0
    };
  }

  return {
    totalRaisedVnd: aggregateResult[0]?.totalRaisedVnd ?? 0,
    totalTransactions: aggregateResult[0]?.totalTransactions ?? 0,
    uniqueDonorCount: aggregateResult[0]?.uniqueDonorCount ?? 0,
    excludedReorgedVnd: aggregateResult[0]?.excludedReorgedVnd ?? 0,
    excludedReorgedCount: aggregateResult[0]?.excludedReorgedCount ?? 0
  };
}
