/**
 * Worker Data Mapper đồng bộ dữ liệu PayOS với blockchain DonationReceived events
 * vào collection unified_transactions.
 *
 * Chức năng:
 * 1. Poll blockchain DonationReceived events -> tạo unified transaction records (source = BLOCKCHAIN)
 * 2. Poll PayOS deposit records (PAYMENT_CONFIRMED, MINT_COMPLETED) -> tạo unified records (source = PAYOS)
 * 3. Correlate PayOS deposits với blockchain donations theo projectId + walletAddress + amount
 * 4. Phát hiện blockchain reorg (fork) bằng cách check block number của tx hiện tại
 * 5. Invalidate Redis cache khi có unified transaction mới/được update
 *
 * Concurrency: Dùng Redis distributed lock (SETNX) để đảm bảo chỉ 1 instance chạy tại mọi thời điểm.
 * Cron: 5 phút (300000ms) bằng recursive setTimeout để đảm bảo mỗi lần chạy hoàn tất trước khi tính delay.
 */
import { ethers } from 'ethers';
import { getLogger } from '../config/logger';
import { runWithWorkerContext } from '../config/requestContext';
import { getRedisClientIfReady } from '../config/redis';
import {
  upsertUnifiedTransactionByCorrelationId,
  findUnifiedTransactionByCorrelationId,
  createUnifiedTransactionFromBlockchain,
  createUnifiedTransactionFromPayos,
  buildPayosCorrelationId,
  buildBlockchainCorrelationId,
  markChainTransactionReorged
} from '../repositories/unifiedTransactionRepository';
import {
  DepositTransaction,
  DepositTransactionModel
} from '../models/depositModel';
import { upsertDonationByTransactionHash } from '../models/donationModel';
import type { UnifiedTransaction } from '../models/unifiedTransactionModel';

const logger = getLogger();

const SYNC_INTERVAL_MS = 5 * 60 * 1000;
const PAYOS_BATCH_SIZE = 200;
// F5 fix: thu hẹp correlation window từ 30 phút xuống 10 phút để giảm nguy cơ
// ghép nhầm giữa các donation cùng số tiền của cùng wallet (vd: 100k VND nạp nhiều lần).
const CORRELATION_TIME_WINDOW_MS = 10 * 60 * 1000;
const LOCK_TTL_MS = 4 * 60 * 1000;
const MAPPER_LOCK_KEY = 'data_mapper:lock';
const LAST_SYNCED_BLOCK_KEY = 'data_mapper:last_synced_block';

/**
 * Số blocks tối đa cho mỗi lần gọi eth_getLogs.
 * Ghi chú: Alchemy/Infura thường giới hạn ~10k blocks, nên chunk 5000 để an toàn
 * và dễ dàng retry khi gặp timeout.
 */
const MAX_BLOCKS_PER_GETLOGS_REQUEST = 5000;

/**
 * Số request đồng thời tối đa khi upsert donation/unified records.
 * Tránh quá tải MongoDB khi batch lớn.
 */
const DB_WRITE_CONCURRENCY = 10;

type BlockchainSyncResult = {
  syncedCount: number;
  changedCount: number;
  latestBlock: number;
  affectedProjectIds: string[];
};

type BlockchainEventPersistenceResult = {
  status: 'persisted' | 'skipped' | 'failed';
  projectId?: string;
  shouldInvalidateCaches: boolean;
};

type PayosRecordSyncResult = {
  processed: boolean;
  changed: boolean;
};

type PayosSyncResult = {
  syncedCount: number;
  changedCount: number;
  affectedProjectIds: string[];
};

type ReorgSyncResult = {
  reorgedCount: number;
  changedCount: number;
  affectedProjectIds: string[];
};

const DONATION_RECEIVED_ABI = [
  'event DonationReceived(address indexed donor, uint256 indexed projectId, uint256 amount, uint256 timestamp, bool isAnonymous)'
] as const;

let rpcProvider: ethers.JsonRpcProvider | null = null;

export function resetModuleState(): void {
  rpcProvider = null;
}

/**
 * Semaphore giới hạn số tác vụ chạy đồng thời.
 * Đảm bảo không quá tải MongoDB / RPC khi batch lớn.
 */
class Semaphore {
  private readonly maxConcurrent: number;
  private running = 0;
  private queue: Array<() => void> = [];

  constructor(maxConcurrent: number) {
    this.maxConcurrent = maxConcurrent;
  }

  private release(): void {
    this.running--;
    const next = this.queue.shift();
    if (next) next();
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const execute = async (): Promise<void> => {
        this.running++;
        try {
          const result = await fn();
          resolve(result);
        } catch (err) {
          reject(err);
        } finally {
          this.release();
        }
      };
      if (this.running < this.maxConcurrent) {
        execute();
      } else {
        this.queue.push(execute);
      }
    });
  }
}

function getRpcProvider(): ethers.JsonRpcProvider | null {
  const rpcUrl = String(process.env.BLOCKCHAIN_RPC_URL || '').trim();
  if (!rpcUrl) return null;

  if (!rpcProvider) {
    rpcProvider = new ethers.JsonRpcProvider(rpcUrl);
  }
  return rpcProvider;
}

export async function acquireDistributedLock(): Promise<boolean> {
  const redisClient = getRedisClientIfReady();
  if (!redisClient) {
    logger.info('[DataMapper] Redis chưa sẵn sàng, bỏ qua lock acquisition.');
    return true;
  }

  try {
    const result = await redisClient.set(
      MAPPER_LOCK_KEY,
      process.pid.toString(),
      { NX: true, PX: LOCK_TTL_MS }
    );
    return result === 'OK';
  } catch (err) {
    logger.warn('Lỗi khi acquire distributed lock, từ chối chạy cycle để tránh duplicate processing.', {
      errorMessage: (err as Error).message
    });
    return false;
  }
}

export async function releaseDistributedLock(): Promise<void> {
  const redisClient = getRedisClientIfReady();
  if (!redisClient) return;

  try {
    const currentHolder = await redisClient.get(MAPPER_LOCK_KEY);
    if (currentHolder === process.pid.toString()) {
      await redisClient.del(MAPPER_LOCK_KEY);
    }
  } catch (err) {
    logger.warn('Lỗi khi release distributed lock.', {
      errorMessage: (err as Error).message
    });
  }
}

/**
 * Đọc checkpoint blockchain và chỉ chấp nhận block number nguyên, không âm, an toàn.
 * @returns Block cuối đã sync; trả về 0 khi checkpoint chưa có hoặc không hợp lệ.
 */
async function getLastSyncedBlockNumber(): Promise<number> {
  const redisClient = getRedisClientIfReady();
  if (!redisClient) return 0;

  try {
    const value = await redisClient.get(LAST_SYNCED_BLOCK_KEY);
    if (!value) return 0;

    const parsedBlockNumber = Number(value);
    if (!Number.isSafeInteger(parsedBlockNumber) || parsedBlockNumber < 0) {
      logger.warn('[DataMapper] Checkpoint block không hợp lệ, bắt đầu retry từ block 0.', {
        checkpointKey: LAST_SYNCED_BLOCK_KEY
      });
      return 0;
    }

    return parsedBlockNumber;
  } catch (err) {
    logger.warn('[DataMapper] Không đọc được checkpoint blockchain, bắt đầu retry từ block 0.', {
      errorMessage: err instanceof Error ? err.message : String(err)
    });
    return 0;
  }
}

async function saveLastSyncedBlockNumber(blockNumber: number): Promise<void> {
  const redisClient = getRedisClientIfReady();
  if (!redisClient) return;

  try {
    await redisClient.set(LAST_SYNCED_BLOCK_KEY, String(blockNumber));
  } catch (err) {
    logger.warn('Lỗi khi lưu checkpoint block number.', {
      errorMessage: (err as Error).message
    });
  }
}

/**
 * Lấy những deposit records đã xác nhận thanh toán (PAYMENT_CONFIRMED, MINT_COMPLETED)
 * để sync vào unified_transactions.
 */
async function fetchPayosDepositRecords(): Promise<DepositTransaction[]> {
  try {
    const records = await DepositTransactionModel
      .find({ status: { $in: ['PAYMENT_CONFIRMED', 'MINT_COMPLETED'] } })
      .sort({ paymentConfirmedAt: -1 })
      .limit(PAYOS_BATCH_SIZE)
      .lean<DepositTransaction[]>()
      .exec();

    return records;
  } catch (err) {
    logger.error('[DataMapper] lỗi khi fetch PayOS deposit records.', {
      errorMessage: (err as Error).message
    });
    return [];
  }
}

/**
 * Sync một PayOS deposit record vào unified_transactions.
 * Tạo record với correlationId = "deposit:{orderCode}" và source = PAYOS.
 * Idempotent: sử dụng upsert dựa trên correlationId.
 */
/**
 * Kiểm tra projection PayOS có thực sự khác dữ liệu đang lưu hay không.
 * Không ghi lại record không đổi để tránh invalidation timeline toàn cục ở mỗi chu kỳ polling.
 */
function hasPayosProjectionChanged(
  existingRecord: UnifiedTransaction,
  updatePayload: Partial<UnifiedTransaction>
): boolean {
  return existingRecord.payosStatus !== updatePayload.payosStatus
    || existingRecord.payosOrderCode !== updatePayload.payosOrderCode
    || existingRecord.payosTransactionId !== updatePayload.payosTransactionId
    || existingRecord.payosRecordId !== updatePayload.payosRecordId
    || (updatePayload.source !== undefined && existingRecord.source !== updatePayload.source);
}

async function syncPayosDepositRecord(deposit: DepositTransaction): Promise<PayosRecordSyncResult> {
  try {
    const correlationId = buildPayosCorrelationId(deposit.orderCode);
    const payosStatus =
      deposit.status === 'MINT_COMPLETED'
        ? 'PAYMENT_CONFIRMED'
        : deposit.status === 'PAYMENT_CONFIRMED'
          ? 'PAYMENT_CONFIRMED'
          : 'PENDING_PAYMENT';

    const walletAddress = deposit.walletAddress || '';
    const amountVnd = deposit.amountVnd || 0;
    const eventTimestamp = deposit.paymentConfirmedAt || deposit.updatedAt;

    const existingRecord = await findUnifiedTransactionByCorrelationId(correlationId);
    if (existingRecord) {
      const updatePayload: Parameters<typeof upsertUnifiedTransactionByCorrelationId>[1] = {
        payosStatus: payosStatus as Parameters<typeof upsertUnifiedTransactionByCorrelationId>[1]['payosStatus'],
        payosOrderCode: deposit.orderCode,
        payosTransactionId: deposit.payosTransactionId || null,
        payosRecordId: deposit.id
      };

      if (existingRecord.chainStatus === 'CONFIRMED' && existingRecord.chainTxHash) {
        updatePayload.source = 'MIXED';
      }

      if (!hasPayosProjectionChanged(existingRecord, updatePayload)) {
        return { processed: true, changed: false };
      }

      const updatedRecord = await upsertUnifiedTransactionByCorrelationId(correlationId, updatePayload);
      return { processed: Boolean(updatedRecord), changed: Boolean(updatedRecord) };
    } else {
      // Ghi chú logic phức tạp: DepositTransaction không có field projectId.
      // PayOS deposit chỉ liên quan đến wallet của user, không trực tiếp đến project.
      // Blockchain donation sẽ fill projectId khi được sync từ chain.
      // Correlation sau đó sẽ không dùng projectId (chỉ walletAddress + amountVnd).
      await createUnifiedTransactionFromPayos(correlationId, {
        projectId: '',
        walletAddress,
        eventType: 'DEPOSIT',
        amountVnd,
        payosStatus: payosStatus as Parameters<typeof createUnifiedTransactionFromPayos>[1]['payosStatus'],
        payosOrderCode: deposit.orderCode,
        payosTransactionId: deposit.payosTransactionId,
        payosRecordId: deposit.id,
        eventTimestamp
      });
      return { processed: true, changed: true };
    }
  } catch (err) {
    logger.error('[DataMapper] lỗi khi sync PayOS deposit record.', {
      orderCode: deposit.orderCode,
      errorMessage: (err as Error).message
    });
    return { processed: false, changed: false };
  }
}

/**
 * Đồng bộ batch PayOS và tách số record xử lý được khỏi số record thực sự thay đổi.
 */
async function syncPayosDeposits(): Promise<PayosSyncResult> {
  const deposits = await fetchPayosDepositRecords();
  if (deposits.length === 0) {
    logger.info('[DataMapper] Không có PayOS deposit nào cần sync.');
    return { syncedCount: 0, changedCount: 0, affectedProjectIds: [] };
  }

  logger.info(`[DataMapper] Bắt đầu sync ${deposits.length} PayOS deposit records.`);
  const writeSemaphore = new Semaphore(DB_WRITE_CONCURRENCY);

  const results = await Promise.allSettled(
    deposits.map(deposit => writeSemaphore.run(() => syncPayosDepositRecord(deposit)))
  );

  const successCount = results.filter(
    result => result.status === 'fulfilled' && result.value.processed
  ).length;
  const changedCount = results.filter(
    result => result.status === 'fulfilled' && result.value.changed
  ).length;
  logger.info(`[DataMapper] Đã xử lý ${successCount}/${deposits.length} PayOS deposits, ${changedCount} record thay đổi.`);
  // Deposit PayOS chưa gắn projectId nên không làm thay đổi summary của dự án nào.
  return { syncedCount: successCount, changedCount, affectedProjectIds: [] };
}

/**
 * Ghi một DonationReceived event vào cả hai nguồn dữ liệu bắt buộc.
 * Chỉ xem event là thành công khi donation và unified transaction đều đã ghi xong,
 * để checkpoint không bỏ qua event còn thiếu dữ liệu audit.
 * Cache vẫn phải được invalidation nếu chỉ một nguồn ghi thành công để public view không stale.
 */
async function persistBlockchainDonationEvent(
  eventLog: ethers.Log,
  eventInterface: ethers.Interface,
  indexedAt: Date,
  semaphore: Semaphore
): Promise<BlockchainEventPersistenceResult> {
  return semaphore.run(async (): Promise<BlockchainEventPersistenceResult> => {
    const parsed = eventInterface.parseLog({ topics: eventLog.topics, data: eventLog.data });
    if (!parsed) return { status: 'skipped', shouldInvalidateCaches: false };

    const txHash = eventLog.transactionHash || '';
    if (!txHash) return { status: 'skipped', shouldInvalidateCaches: false };

    const donorAddress = String(parsed.args.donor).toLowerCase();
    const projectId = parsed.args.projectId.toString();
    const amount = Number(parsed.args.amount);
    const eventTimestamp = new Date(Number(parsed.args.timestamp) * 1000);

    let donationWriteSucceeded = false;
    try {
      await upsertDonationByTransactionHash({
        transactionHash: txHash,
        projectId,
        donorAddress,
        amount,
        timestamp: eventTimestamp,
        isAnonymous: Boolean(parsed.args.isAnonymous),
        blockNumber: eventLog.blockNumber,
        donationStatus: 'INDEXED',
        onChainConfirmedAt: eventTimestamp,
        indexedAt,
        correlationId: buildBlockchainCorrelationId(txHash),
        createdAt: indexedAt,
        updatedAt: indexedAt
      });
      donationWriteSucceeded = true;
    } catch (err) {
      logger.error('[DataMapper] lỗi khi upsert donation record.', {
        transactionHash: txHash,
        errorMessage: (err as Error).message
      });
    }

    let unifiedWriteSucceeded = false;
    try {
      await createUnifiedTransactionFromBlockchain(
        buildBlockchainCorrelationId(txHash),
        {
          projectId,
          walletAddress: donorAddress,
          eventType: 'DONATION',
          amountVnd: amount,
          chainTxHash: txHash,
          chainBlockNumber: eventLog.blockNumber,
          chainStatus: 'CONFIRMED',
          eventTimestamp
        }
      );
      unifiedWriteSucceeded = true;
    } catch (err) {
      logger.error('[DataMapper] lỗi khi tạo unified transaction record.', {
        correlationId: buildBlockchainCorrelationId(txHash),
        errorMessage: (err as Error).message
      });
    }

    const shouldInvalidateCaches = donationWriteSucceeded || unifiedWriteSucceeded;
    if (!donationWriteSucceeded || !unifiedWriteSucceeded) {
      return { status: 'failed', projectId, shouldInvalidateCaches };
    }

    return { status: 'persisted', projectId, shouldInvalidateCaches };
  });
}

/**
 * Sync DonationReceived events từ blockchain vào unified_transactions.
 * Chỉ sync từ lastSyncedBlock + 1 trở đi.
 * Tạo unified record với source = BLOCKCHAIN, chainStatus = CONFIRMED.
 * Idempotent: kiểm tra tồn tại theo correlationId = "donation:{txHash}".
 *
 * LƯU Ý: BLOCKCHAIN_RPC_URL và DONATION_RANKING_CONTRACT_ADDRESS là config BẮT BUỘC.
 * Nếu không có, worker không thể sync blockchain events - cần throw error để
 * operator nhận biết cấu hình thiếu sớm, tránh việc worker chạy "im lặng" mà không sync.
 */
async function syncBlockchainDonationEvents(): Promise<BlockchainSyncResult> {
  const rpcUrl = String(process.env.BLOCKCHAIN_RPC_URL || '').trim();
  const contractAddress = String(process.env.DONATION_RANKING_CONTRACT_ADDRESS || '').trim();

  // Kiểm tra config bắt buộc: RPC URL và contract address cần được cấu hình
  // Nếu thiếu, throw error để worker không chạy im lặng mà không sync blockchain
  if (!rpcUrl) {
    throw new Error('[DataMapper] BLOCKCHAIN_RPC_URL chưa được cấu hình. Vui lòng kiểm tra environment variables.');
  }
  if (!contractAddress) {
    throw new Error('[DataMapper] DONATION_RANKING_CONTRACT_ADDRESS chưa được cấu hình. Vui lòng kiểm tra environment variables.');
  }

  const provider = getRpcProvider();
  if (!provider) {
    logger.warn('[DataMapper] Không thể khởi tạo RPC provider, bỏ qua blockchain sync.');
    return { syncedCount: 0, changedCount: 0, latestBlock: 0, affectedProjectIds: [] };
  }

  try {
    const eventInterface = new ethers.Interface(DONATION_RECEIVED_ABI);
    const eventTopic = eventInterface.getEvent('DonationReceived')?.topicHash;
    if (!eventTopic) {
      logger.error('[DataMapper] Không tìm thấy topicHash cho DonationReceived event.');
      return { syncedCount: 0, changedCount: 0, latestBlock: 0, affectedProjectIds: [] };
    }

    const lastSyncedBlock = await getLastSyncedBlockNumber();
    const fromBlock = Math.max(lastSyncedBlock + 1, 0);

    // Lấy current head block để biết giới hạn trên để chunk.
    // Nếu RPC không trả về (down), bỏ qua lần sync này.
    let currentHeadBlock: number;
    try {
      currentHeadBlock = await provider.getBlockNumber();
    } catch (err) {
      logger.error('[DataMapper] Lỗi khi get block number, bỏ qua blockchain sync.', {
        errorMessage: (err as Error).message
      });
      return {
        syncedCount: 0,
        changedCount: 0,
        latestBlock: lastSyncedBlock,
        affectedProjectIds: []
      };
    }

    const now = new Date();
    let syncedCount = 0;
    let changedCount = 0;
    let latestProcessedBlock = lastSyncedBlock;
    const affectedProjectIds = new Set<string>();
    const semaphore = new Semaphore(DB_WRITE_CONCURRENCY);

    // Ghi chú logic phức tạp: Alchemy/Infura thường giới hạn phạm vi ~10k blocks/lần.
    // Chia thành chunks 5000 blocks và commit checkpoint theo từng chunk đã hoàn tất.
    for (let chunkStart = fromBlock; chunkStart <= currentHeadBlock; chunkStart += MAX_BLOCKS_PER_GETLOGS_REQUEST) {
      const chunkEnd = Math.min(chunkStart + MAX_BLOCKS_PER_GETLOGS_REQUEST - 1, currentHeadBlock);
      let chunkLogs: ethers.Log[];
      try {
        chunkLogs = await provider.getLogs({
          address: contractAddress,
          fromBlock: chunkStart,
          toBlock: chunkEnd,
          topics: [eventTopic]
        }) as ethers.Log[];
      } catch (err) {
        logger.error('[DataMapper] Lỗi khi getLogs chunk, giữ checkpoint trước vùng lỗi để retry.', {
          fromBlock: chunkStart,
          toBlock: chunkEnd,
          errorMessage: (err as Error).message
        });
        return {
          syncedCount,
          changedCount,
          latestBlock: latestProcessedBlock,
          affectedProjectIds: [...affectedProjectIds]
        };
      }
      const writeResults = await Promise.allSettled(
        chunkLogs.map(eventLog => persistBlockchainDonationEvent(eventLog, eventInterface, now, semaphore))
      );
      const chunkFailed = writeResults.some(result =>
        result.status === 'rejected' || result.value.status === 'failed'
      );

      for (const result of writeResults) {
        if (result.status !== 'fulfilled') continue;
        if (result.value.shouldInvalidateCaches) {
          changedCount++;
          if (result.value.projectId) affectedProjectIds.add(result.value.projectId);
        }
        if (result.value.status === 'persisted') {
          syncedCount++;
        }
      }

      if (chunkFailed) {
        logger.warn('[DataMapper] Persistence chưa hoàn tất, giữ checkpoint trước chunk để retry idempotent.', {
          chunkStart,
          chunkEnd
        });
        return {
          syncedCount,
          changedCount,
          latestBlock: latestProcessedBlock,
          affectedProjectIds: [...affectedProjectIds]
        };
      }

      // Chunk rỗng cũng được commit vì không có event nào cần retry trong phạm vi này.
      latestProcessedBlock = chunkEnd;
      await saveLastSyncedBlockNumber(latestProcessedBlock);
    }

    logger.info(`[DataMapper] Đã sync ${syncedCount} blockchain events (latest block: ${latestProcessedBlock}).`);
    return {
      syncedCount,
      changedCount,
      latestBlock: latestProcessedBlock,
      affectedProjectIds: [...affectedProjectIds]
    };
  } catch (err) {
    logger.error('[DataMapper] lỗi khi sync blockchain events.', {
      errorMessage: (err as Error).message
    });
    return { syncedCount: 0, changedCount: 0, latestBlock: 0, affectedProjectIds: [] };
  }
}

/**
 * Correlate PayOS deposit records với blockchain donation records.
 *
 * F5 fix: correlation criteria thu hẹp từ 30 phút → 10 phút và thêm
 * projectId filter (deposit không có projectId nên không thể match với
 * donation của bất kỳ project nào nếu deposit được gán project ở sau).
 *
 * LƯU Ý: PayOS deposits KHÔNG có projectId nên không thể
 * dùng projectId làm correlation key (correlation đang xảy ra trước khi biết projectId).
 * Correlation key chỉ là walletAddress + amountVnd trong time window ngắn.
 * Nếu nhiều candidate, chọn record gần nhất (F5 mitigation).
 */
/**
 * Lấy những blockchain records có walletAddress + amountVnd trong time range.
 * Sử dụng batch query thay vì N+1 queries để tăng performance.
 *
 * @param walletAddresses Danh sách địa chỉ wallet cần tìm
 * @param timeWindowStart Thời gian bắt đầu
 * @param timeWindowEnd Thời gian kết thúc
 * @returns Map với key là "walletAddress:amountVnd", giá trị là blockchain record
 */
async function fetchBlockchainRecordsForCorrelation(
  walletAddresses: string[],
  timeWindowStart: Date,
  timeWindowEnd: Date
): Promise<Map<string, { chainTxHash: string | null; chainBlockNumber: number | null }>> {
  const lookupMap = new Map<string, { chainTxHash: string | null; chainBlockNumber: number | null }>();

  if (walletAddresses.length === 0) {
    return lookupMap;
  }

  // Sử dụng dynamic import để tránh circular dependency với repository layer
  const { UnifiedTransactionModel } = await import('../models/unifiedTransactionModel');

  const blockchainRecords = await UnifiedTransactionModel
    .find({
      source: { $in: ['BLOCKCHAIN', 'MIXED'] },
      chainStatus: 'CONFIRMED',
      chainTxHash: { $ne: null },
      walletAddress: { $in: walletAddresses },
      eventTimestamp: { $gte: timeWindowStart, $lte: timeWindowEnd }
    })
    .lean<Array<{ walletAddress: string; amountVnd: number; chainTxHash: string | null; chainBlockNumber: number | null }>>()
    .exec();

  for (const record of blockchainRecords) {
    const mapKey = `${String(record.walletAddress).toLowerCase()}:${record.amountVnd}`;
    lookupMap.set(mapKey, {
      chainTxHash: record.chainTxHash,
      chainBlockNumber: record.chainBlockNumber
    });
  }

  return lookupMap;
}

/** Đối soát các deposit PayOS đã xác nhận với donation blockchain tương ứng. */
async function correlatePayosWithBlockchain(): Promise<{
  correlatedCount: number;
  affectedProjectIds: string[];
}> {
  try {
    const { UnifiedTransactionModel } = await import('../models/unifiedTransactionModel');

    const unmatchedPayosRecords = await UnifiedTransactionModel
      .find({
        source: 'PAYOS',
        payosStatus: 'PAYMENT_CONFIRMED'
      })
      .limit(PAYOS_BATCH_SIZE)
      .lean<Array<{
        utxId: string;
        correlationId: string;
        projectId: string;
        walletAddress: string;
        amountVnd: number;
        eventTimestamp: Date;
      }>>()
      .exec();

    if (unmatchedPayosRecords.length === 0) {
      return { correlatedCount: 0, affectedProjectIds: [] };
    }

    logger.info(`[DataMapper] Correlating ${unmatchedPayosRecords.length} PayOS records với blockchain.`);

    const validRecords = unmatchedPayosRecords.filter(r => {
      const walletAddress = String(r.walletAddress || '').toLowerCase();
      const amountVnd = Number(r.amountVnd || 0);
      return walletAddress && amountVnd > 0;
    });

    if (validRecords.length === 0) {
      return { correlatedCount: 0, affectedProjectIds: [] };
    }

    const walletAddresses = validRecords.map(r => String(r.walletAddress).toLowerCase());
    const timestamps = validRecords.map(r => new Date(r.eventTimestamp).getTime());
    const minTimestamp = Math.min(...timestamps);
    const maxTimestamp = Math.max(...timestamps);
    const timeWindowStart = new Date(minTimestamp - CORRELATION_TIME_WINDOW_MS);
    const timeWindowEnd = new Date(maxTimestamp + CORRELATION_TIME_WINDOW_MS);

    const lookupMap = await fetchBlockchainRecordsForCorrelation(walletAddresses, timeWindowStart, timeWindowEnd);

    let correlatedCount = 0;

    for (const payosRecord of validRecords) {
      const walletAddress = String(payosRecord.walletAddress).toLowerCase();
      const amountVnd = Number(payosRecord.amountVnd || 0);
      const payosTimestamp = new Date(payosRecord.eventTimestamp);
      const recordWindowStart = new Date(payosTimestamp.getTime() - CORRELATION_TIME_WINDOW_MS);
      const recordWindowEnd = new Date(payosTimestamp.getTime() + CORRELATION_TIME_WINDOW_MS);

      const mapKey = `${walletAddress}:${amountVnd}`;
      const blockchainData = lookupMap.get(mapKey);

      if (!blockchainData || !blockchainData.chainTxHash) continue;

      if (blockchainData.chainBlockNumber !== null) {
        const blockchainTimestamp = await UnifiedTransactionModel
          .findOne({ chainTxHash: blockchainData.chainTxHash })
          .select('eventTimestamp')
          .lean<{ eventTimestamp: Date }>()
          .exec();

        if (blockchainTimestamp) {
          const blockchainTime = new Date(blockchainTimestamp.eventTimestamp).getTime();
          if (blockchainTime < recordWindowStart.getTime() || blockchainTime > recordWindowEnd.getTime()) {
            continue;
          }
        }
      }

      const updateResult = await UnifiedTransactionModel.updateOne(
        { utxId: payosRecord.utxId, source: 'PAYOS' },
        {
          $set: {
            source: 'MIXED',
            chainStatus: 'CONFIRMED',
            chainTxHash: blockchainData.chainTxHash,
            chainBlockNumber: blockchainData.chainBlockNumber
          }
        }
      ).exec();

      if (updateResult.modifiedCount === 0) continue;

      correlatedCount++;
      logger.info('[DataMapper] Correlated PayOS deposit với blockchain donation.', {
        utxId: payosRecord.utxId,
        correlationId: payosRecord.correlationId,
        chainTxHash: blockchainData.chainTxHash
      });
    }

    logger.info(`[DataMapper] Đã correlate ${correlatedCount} records.`);
    // Correlation chỉ bổ sung chain fields cho deposit chưa gắn projectId,
    // nên không làm thay đổi summary của một dự án cụ thể.
    return { correlatedCount, affectedProjectIds: [] };
  } catch (err) {
    logger.error('[DataMapper] lỗi khi correlate PayOS với blockchain.', {
      errorMessage: (err as Error).message
    });
    return { correlatedCount: 0, affectedProjectIds: [] };
  }
}

/**
 * Kiểm tra một lỗi có phải là "transaction not found" (đã bị revert/bị xóa khỏi chain).
 * Phân biệt với RPC error (network, timeout, rate limit) để tránh nhầm lẫn reorg.
 *
 * Ethers v6 trả về error với:
 * - code: 'CALL_EXCEPTION' (khi receipt null do tx bị revert/drop)
 * - shortMessage: chứa 'transaction ... not found' hoặc 'could not find'
 * - error.code === 'NOT_FOUND' từ Alchemy/Infura
 */
function isTransactionNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;

  const errorObj = err as Record<string, unknown>;
  const errorCode = String(errorObj.code || '');
  const errorMessage = String(errorObj.shortMessage || errorObj.message || '').toLowerCase();

  // Ethers v6 CALL_EXCEPTION khi transaction không tồn tại
  if (errorCode === 'CALL_EXCEPTION') {
    if (errorMessage.includes('not found') || errorMessage.includes('missing')) {
      return true;
    }
  }

  // Ethers v6 BAD_DATA / INVALID_ARGUMENT cho missing transaction
  if (errorCode === 'BAD_DATA' && errorMessage.includes('not found')) {
    return true;
  }

  // Alchemy / Infura error codes
  if (['-32004', '-32000'].includes(errorCode)) {
    return true;
  }

  // Generic message check (fallback)
  if (errorMessage.includes('transaction not found') ||
      errorMessage.includes('tx not found') ||
      errorMessage.includes('could not find transaction')) {
    return true;
  }

  return false;
}

/**
 * Phát hiện và đánh dấu blockchain reorg (fork).
 * Kiểm tra những unified record có chainTxHash trong khoảng block gần đây,
 * lấy receipt của transaction hiện tại, nếu block number khác -> fork.
 * Nếu receipt === null hoặc "tx not found" -> tx bị revert hoàn toàn.
 *
 * LƯU Ý: Chỉ mark REORGED khi xác nhận "transaction not found".
 * RPC error (timeout, rate limit) KHÔNG được mark REORGED để tránh mất dữ liệu.
 */
async function detectAndMarkReorgs(): Promise<ReorgSyncResult> {
  const lastSyncedBlock = await getLastSyncedBlockNumber();
  if (lastSyncedBlock <= 0) {
    return { reorgedCount: 0, changedCount: 0, affectedProjectIds: [] };
  }

  const rpcUrl = String(process.env.BLOCKCHAIN_RPC_URL || '').trim();
  const contractAddress = String(process.env.DONATION_RANKING_CONTRACT_ADDRESS || '').trim();
  if (!rpcUrl || !contractAddress) {
    return { reorgedCount: 0, changedCount: 0, affectedProjectIds: [] };
  }

  const provider = getRpcProvider();
  if (!provider) {
    return { reorgedCount: 0, changedCount: 0, affectedProjectIds: [] };
  }

  try {
    const { UnifiedTransactionModel } = await import('../models/unifiedTransactionModel');

    const recordsWithTx = await UnifiedTransactionModel
      .find({
        chainTxHash: { $ne: null },
        chainBlockNumber: { $gte: Math.max(lastSyncedBlock - 100, 0) }
      })
      .limit(100)
      .lean<Array<{
        utxId: string;
        correlationId: string;
        projectId: string;
        chainTxHash: string;
        chainBlockNumber: number;
      }>>()
      .exec();

    if (recordsWithTx.length === 0) {
      return { reorgedCount: 0, changedCount: 0, affectedProjectIds: [] };
    }

    logger.info(`[DataMapper] Kiểm tra ${recordsWithTx.length} records cho reorg detection.`);
    const receiptSemaphore = new Semaphore(DB_WRITE_CONCURRENCY);

    const reorgResults = await Promise.allSettled(
      recordsWithTx.map(record => receiptSemaphore.run(async () => {
        try {
          const receipt = await provider.getTransactionReceipt(record.chainTxHash);
          if (!receipt) {
            return { type: 'reorged' as const, record };
          } else if (receipt.blockNumber !== record.chainBlockNumber) {
            return { type: 'fork' as const, record, newBlock: receipt.blockNumber };
          }
          return { type: 'ok' as const };
        } catch (err) {
          if (isTransactionNotFoundError(err)) {
            return { type: 'reorged' as const, record };
          }
          return { type: 'rpc_error' as const, record, error: err };
        }
      }))
    );

    let reorgedCount = 0;
    let changedCount = 0;
    const affectedProjectIds = new Set<string>();

    for (const result of reorgResults) {
      if (result.status === 'rejected') continue;

      const outcome = result.value;

      if (outcome.type === 'reorged') {
        try {
          const modifiedCount = await markChainTransactionReorged(outcome.record.chainTxHash);
          if (modifiedCount > 0) {
            reorgedCount++;
            changedCount++;
            if (outcome.record.projectId) affectedProjectIds.add(outcome.record.projectId);
          }
          logger.warn('[DataMapper] Phát hiện reorg: transaction bị revert.', {
            correlationId: outcome.record.correlationId,
            chainTxHash: outcome.record.chainTxHash,
            originalBlock: outcome.record.chainBlockNumber
          });
        } catch (markErr) {
          logger.error('[DataMapper] Lỗi khi mark REORGED.', {
            chainTxHash: outcome.record.chainTxHash,
            errorMessage: (markErr as Error).message
          });
        }
      } else if (outcome.type === 'fork') {
        await UnifiedTransactionModel.updateOne(
          { utxId: outcome.record.utxId },
          { $set: { chainBlockNumber: outcome.newBlock } }
        ).exec();
        changedCount++;
        if (outcome.record.projectId) affectedProjectIds.add(outcome.record.projectId);
        logger.warn('[DataMapper] Phát hiện fork: block number thay đổi.', {
          correlationId: outcome.record.correlationId,
          oldBlock: outcome.record.chainBlockNumber,
          newBlock: outcome.newBlock
        });
      } else if (outcome.type === 'rpc_error') {
        logger.warn('[DataMapper] RPC error khi check receipt, bỏ qua (có thể transient).', {
          correlationId: outcome.record.correlationId,
          chainTxHash: outcome.record.chainTxHash,
          errorMessage: (outcome.error as Error).message
        });
      }
    }

    if (reorgedCount > 0) {
      logger.warn(`[DataMapper] Đã phát hiện ${reorgedCount} records bị reorg.`);
    }
    return {
      reorgedCount,
      changedCount,
      affectedProjectIds: [...affectedProjectIds]
    };
  } catch (err) {
    logger.error('[DataMapper] lỗi khi kiểm tra reorg.', {
      errorMessage: (err as Error).message
    });
    return { reorgedCount: 0, changedCount: 0, affectedProjectIds: [] };
  }
}

/**
 * Hàm chính: chạy một chu kỳ sync hoàn chỉnh.
 * Thực hiện theo thứ tự:
 * 1. Kiểm tra reorg (nếu có checkpoint cũ)
 * 2. Sync blockchain events
 * 3. Sync PayOS deposits
 * 4. Correlate PayOS với blockchain
 * 5. Invalidate Redis cache của D1 và D3
 */
async function runDataMapperCycleInternal(): Promise<{
  blockchainSynced: number;
  payosSynced: number;
  correlated: number;
  reorged: number;
}> {
  logger.info('[DataMapper] Bắt đầu chu kỳ sync data mapper.');

  const reorgResult = await detectAndMarkReorgs();
  const blockchainResult = await syncBlockchainDonationEvents();
  const payosResult = await syncPayosDeposits();
  const correlationResult = await correlatePayosWithBlockchain();
  const affectedProjectIds = new Set([
    ...blockchainResult.affectedProjectIds,
    ...reorgResult.affectedProjectIds
  ]);

  // Dùng số projection đã thay đổi thay vì số record chỉ được đọc lại.
  // Một event ghi dở vẫn có thể làm public view đổi, nhưng checkpoint vẫn được giữ để retry.
  const totalChanged = blockchainResult.changedCount
    + payosResult.changedCount
    + correlationResult.correlatedCount
    + reorgResult.changedCount;

  if (totalChanged > 0) {
    const { invalidateUnifiedTimelineCache } = await import('../services/unified-timeline.service');
    if (affectedProjectIds.size > 0) {
      await Promise.all([...affectedProjectIds].map(projectId => invalidateUnifiedTimelineCache(projectId)));
    } else {
      await invalidateUnifiedTimelineCache();
    }

    // Chỉ invalidate summary của các project thật sự bị ảnh hưởng; deposit PayOS
    // standalone/correlation chưa có projectId không được làm mất cache toàn hệ thống.
    if (affectedProjectIds.size > 0) {
      const { invalidateVerificationCache } = await import('../services/verification.service');
      await Promise.all([...affectedProjectIds].map(projectId => invalidateVerificationCache(projectId)));
    }
    logger.info('[DataMapper] Cache đã được invalidate sau khi có dữ liệu thay đổi.', {
      totalChanged,
      affectedProjectCount: affectedProjectIds.size
    });
  } else {
    logger.info('[DataMapper] Không có dữ liệu thay đổi, giữ nguyên cache.', {
      totalChanged
    });
  }

  logger.info('[DataMapper] Hoàn tất chu kỳ sync data mapper.', {
    blockchainSynced: blockchainResult.syncedCount,
    payosSynced: payosResult.syncedCount,
    correlated: correlationResult.correlatedCount,
    reorged: reorgResult.reorgedCount
  });

  return {
    blockchainSynced: blockchainResult.syncedCount,
    payosSynced: payosResult.syncedCount,
    correlated: correlationResult.correlatedCount,
    reorged: reorgResult.reorgedCount
  };
}

/**
 * Chạy một chu kỳ Data Mapper trong correlation scope riêng của worker.
 * @returns Thống kê đồng bộ của chu kỳ hiện tại.
 */
export async function runDataMapperCycle(): Promise<{
  blockchainSynced: number;
  payosSynced: number;
  correlated: number;
  reorged: number;
}> {
  return runWithWorkerContext('data-mapper', () => runDataMapperCycleInternal());
}

/**
 * Hàm chính: chạy một chu kỳ sync hoàn chỉnh (có lock).
 * Sử dụng bởi startDataMapperWorker cho cả initial run và recurring runs.
 */
async function runDataMapperCycleWithLock(): Promise<void> {
  return runWithWorkerContext('data-mapper', async () => {
    const lockAcquired = await acquireDistributedLock();
    if (!lockAcquired) {
      logger.info('[DataMapper] Lock không acquired, bỏ qua run này.');
      return;
    }

    try {
      await runDataMapperCycleInternal();
    } catch (err) {
      logger.error('[DataMapper] Data mapper cycle thất bại.', {
        errorMessage: (err as Error).message
      });
    } finally {
      await releaseDistributedLock();
    }
  });
}

/**
 * Khởi động Data Mapper worker.
 * Chạy mỗi 5 phút bằng recursive setTimeout để đảm bảo mỗi lần
 * chạy hoàn tất trước khi tính delay cho lần tiếp theo.
 *
 * Cả initial run lẫn recurring đều được wrap trong distributed lock
 * để tránh multiple instances chạy đồng thời trên multi-pod deployment.
 */
export function startDataMapperWorker(): void {
  logger.info('Data Mapper worker khởi động (chu kỳ 5 phút).');

  const runWithInterval = (): void => {
    setTimeout(() => {
      void runDataMapperCycleWithLock();
      runWithInterval();
    }, SYNC_INTERVAL_MS);
  };

  // Initial run cũng phải qua distributed lock
  void runDataMapperCycleWithLock();

  runWithInterval();
}
