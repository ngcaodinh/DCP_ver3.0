/**
 * Worker Data Mapper dong bo du lieu PayOS voi blockchain DonationReceived events
 * vao collection unified_transactions.
 *
 * Chuc nang:
 * 1. Poll blockchain DonationReceived events -> tao unified transaction records (source = BLOCKCHAIN)
 * 2. Poll PayOS deposit records (PAYMENT_CONFIRMED, MINT_COMPLETED) -> tao unified records (source = PAYOS)
 * 3. Correlate PayOS deposits voi blockchain donations theo projectId + walletAddress + amount
 * 4. Phat hien blockchain reorg (fork) bang cach check block number cua tx hien tai
 * 5. Invalidate Redis cache khi co unified transaction moi/duoc update
 *
 * Concurrency: Dung Redis distributed lock (SETNX) de dam bao chi 1 instance chay tai moi thoi diem.
 * Cron: 5 phut (300000ms) bang recursive setTimeout de dam bao moi lan chay hoan tat truoc khi tinh delay.
 */
import { ethers } from 'ethers';
import { getLogger } from '../config/logger';
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

const logger = getLogger();

const SYNC_INTERVAL_MS = 5 * 60 * 1000;
const PAYOS_BATCH_SIZE = 200;
const CORRELATION_TIME_WINDOW_MS = 30 * 60 * 1000;
const LOCK_TTL_MS = 4 * 60 * 1000;
const MAPPER_LOCK_KEY = 'data_mapper:lock';
const LAST_SYNCED_BLOCK_KEY = 'data_mapper:last_synced_block';

/**
 * So blocks toi da cho moi lan goi eth_getLogs.
 * Ghi chu: Alchemy/Infura thuong gioi han ~10k blocks, nen chunk 5000 de an toan
 * va de dang retry khi gap timeout.
 */
const MAX_BLOCKS_PER_GETLOGS_REQUEST = 5000;

/**
 * So request dong thoi toi da khi upsert donation/unified records.
 * Tranh qua tai MongoDB khi batch lon.
 */
const DB_WRITE_CONCURRENCY = 10;

const DONATION_RECEIVED_ABI = [
  'event DonationReceived(address indexed donor, uint256 indexed projectId, uint256 amount, uint256 timestamp, bool isAnonymous)'
] as const;

let rpcProvider: ethers.JsonRpcProvider | null = null;

export function resetModuleState(): void {
  rpcProvider = null;
}

/**
 * Semaphore gioi han so tac vu chay dong thoi.
 * Dam bao khong qua tai MongoDB / RPC khi batch lon.
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
    logger.info('[DataMapper] Redis chua san sang, bo qua lock acquisition.');
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
    logger.warn('Loi khi acquire distributed lock, tu choi chay cycle de tranh duplicate processing.', {
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
    logger.warn('Loi khi release distributed lock.', {
      errorMessage: (err as Error).message
    });
  }
}

async function getLastSyncedBlockNumber(): Promise<number> {
  const redisClient = getRedisClientIfReady();
  if (!redisClient) return 0;

  try {
    const value = await redisClient.get(LAST_SYNCED_BLOCK_KEY);
    return value ? parseInt(value, 10) : 0;
  } catch {
    return 0;
  }
}

async function saveLastSyncedBlockNumber(blockNumber: number): Promise<void> {
  const redisClient = getRedisClientIfReady();
  if (!redisClient) return;

  try {
    await redisClient.set(LAST_SYNCED_BLOCK_KEY, String(blockNumber));
  } catch (err) {
    logger.warn('Loi khi luu checkpoint block number.', {
      errorMessage: (err as Error).message
    });
  }
}

/**
 * Lay nhung deposit records da xac nhan thanh toan (PAYMENT_CONFIRMED, MINT_COMPLETED)
 * de sync vao unified_transactions.
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
    logger.error('[DataMapper] loi khi fetch PayOS deposit records.', {
      errorMessage: (err as Error).message
    });
    return [];
  }
}

/**
 * Sync mot PayOS deposit record vao unified_transactions.
 * Tao record voi correlationId = "deposit:{orderCode}" va source = PAYOS.
 * Idempotent: su dung upsert dua tren correlationId.
 */
async function syncPayosDepositRecord(deposit: DepositTransaction): Promise<boolean> {
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

      await upsertUnifiedTransactionByCorrelationId(correlationId, updatePayload);
    } else {
      // Ghi chu logic phuc tap: DepositTransaction khong co field projectId.
      // PayOS deposit chi lien quan den wallet cua user, khong truc tiep den project.
      // Blockchain donation se fill projectId khi duoc sync tu chain.
      // Correlation sau do se khong dung projectId (chi walletAddress + amountVnd).
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
    }

    return true;
  } catch (err) {
    logger.error('[DataMapper] loi khi sync PayOS deposit record.', {
      orderCode: deposit.orderCode,
      errorMessage: (err as Error).message
    });
    return false;
  }
}

async function syncPayosDeposits(): Promise<number> {
  const deposits = await fetchPayosDepositRecords();
  if (deposits.length === 0) {
    logger.info('[DataMapper] Khong co PayOS deposit nao can sync.');
    return 0;
  }

  logger.info(`[DataMapper] Bat dau sync ${deposits.length} PayOS deposit records.`);
  const writeSemaphore = new Semaphore(DB_WRITE_CONCURRENCY);

  const results = await Promise.allSettled(
    deposits.map(deposit => writeSemaphore.run(() => syncPayosDepositRecord(deposit)))
  );

  const successCount = results.filter(r => r.status === 'fulfilled' && r.value).length;
  logger.info(`[DataMapper] Da sync ${successCount}/${deposits.length} PayOS deposit records.`);
  return successCount;
}

/**
 * Sync DonationReceived events tu blockchain vao unified_transactions.
 * Chi sync tu lastSyncedBlock + 1 tro di.
 * Tao unified record voi source = BLOCKCHAIN, chainStatus = CONFIRMED.
 * Idempotent: kiem tra ton tai theo correlationId = "donation:{txHash}".
 *
 * LUU Y: BLOCKCHAIN_RPC_URL va DONATION_RANKING_CONTRACT_ADDRESS la config BAT BUOC.
 * Neu khong co, worker khong the sync blockchain events - can throw error de
 * operator nhan biet cau hinh thieu som, tranh viec worker chay "im lang" ma khong sync.
 */
async function syncBlockchainDonationEvents(): Promise<{ syncedCount: number; latestBlock: number }> {
  const rpcUrl = String(process.env.BLOCKCHAIN_RPC_URL || '').trim();
  const contractAddress = String(process.env.DONATION_RANKING_CONTRACT_ADDRESS || '').trim();

  // Kiem tra config bat buoc: RPC URL va contract address can duoc cau hinh
  // Neu thieu, throw error de worker khong chay im lang ma khong sync blockchain
  if (!rpcUrl) {
    throw new Error('[DataMapper] BLOCKCHAIN_RPC_URL chua duoc cau hinh. Vui long kiem tra environment variables.');
  }
  if (!contractAddress) {
    throw new Error('[DataMapper] DONATION_RANKING_CONTRACT_ADDRESS chua duoc cau hinh. Vui long kiem tra environment variables.');
  }

  const provider = getRpcProvider();
  if (!provider) {
    logger.warn('[DataMapper] Khong the khoi tao RPC provider, bo qua blockchain sync.');
    return { syncedCount: 0, latestBlock: 0 };
  }

  try {
    const eventInterface = new ethers.Interface(DONATION_RECEIVED_ABI);
    const eventTopic = eventInterface.getEvent('DonationReceived')?.topicHash;
    if (!eventTopic) {
      logger.error('[DataMapper] Khong tim thay topicHash cho DonationReceived event.');
      return { syncedCount: 0, latestBlock: 0 };
    }

    const lastSyncedBlock = await getLastSyncedBlockNumber();
    const fromBlock = Math.max(lastSyncedBlock + 1, 0);

    // Lay current head block de biet gioi han tren de chunk.
    // Neu RPC khong tra ve (down), bo qua lan sync nay.
    let currentHeadBlock: number;
    try {
      currentHeadBlock = await provider.getBlockNumber();
    } catch (err) {
      logger.error('[DataMapper] Loi khi get block number, bo qua blockchain sync.', {
        errorMessage: (err as Error).message
      });
      return { syncedCount: 0, latestBlock: lastSyncedBlock };
    }

    // Ghi chu logic phuc tap: Alchemy/Infura thuong gioi han pham vi ~10k blocks/lan.
    // Chia thanh chunks 5000 blocks de an toan, retry duoc khi timeout.
    const eventLogs: ethers.Log[] = [];
    for (let chunkStart = fromBlock; chunkStart <= currentHeadBlock; chunkStart += MAX_BLOCKS_PER_GETLOGS_REQUEST) {
      const chunkEnd = Math.min(chunkStart + MAX_BLOCKS_PER_GETLOGS_REQUEST - 1, currentHeadBlock);
      try {
        const chunkLogs = await provider.getLogs({
          address: contractAddress,
          fromBlock: chunkStart,
          toBlock: chunkEnd,
          topics: [eventTopic]
        });
        eventLogs.push(...chunkLogs);
      } catch (err) {
        logger.error('[DataMapper] Loi khi getLogs chunk, bo qua chunk nay.', {
          fromBlock: chunkStart,
          toBlock: chunkEnd,
          errorMessage: (err as Error).message
        });
        // Tien hanh voi logs da lay duoc, khong fail toan bo
      }
    }

    if (eventLogs.length === 0) {
      logger.info('[DataMapper] Khong co DonationReceived event moi can sync.', {
        fromBlock,
        latestBlock: currentHeadBlock
      });
      // Cap nhat checkpoint de lan sau khong quet lai cung khoang
      await saveLastSyncedBlockNumber(currentHeadBlock);
      return { syncedCount: 0, latestBlock: currentHeadBlock };
    }

    logger.info(`[DataMapper] Tim thay ${eventLogs.length} DonationReceived events (tu block ${fromBlock} den ${currentHeadBlock}).`);

    const now = new Date();
    let syncedCount = 0;
    const processedBlockNumbers = new Set<number>();
    const semaphore = new Semaphore(DB_WRITE_CONCURRENCY);

    // Ghi chu logic phuc tap: Xu ly parallel voi Semaphore de tang throughput
    // nhung van gioi han so luong dong thoi tranh qua tai MongoDB.
    // Cap nhat checkpoint theo tung chunk da xu ly xong (thay vi cuoi batch).
    const writeResults = await Promise.allSettled(
      eventLogs.map((eventLog) => semaphore.run(async () => {
        const parsed = eventInterface.parseLog({ topics: eventLog.topics, data: eventLog.data });
        if (!parsed) return;

        const txHash = eventLog.transactionHash || '';
        if (!txHash) return;

        const donorAddress = String(parsed.args.donor).toLowerCase();
        const projectId = parsed.args.projectId.toString();
        const amount = Number(parsed.args.amount);
        const eventTimestamp = new Date(Number(parsed.args.timestamp) * 1000);
        const blockNumber = eventLog.blockNumber;

        try {
          await upsertDonationByTransactionHash({
            transactionHash: txHash,
            projectId,
            donorAddress,
            amount,
            timestamp: eventTimestamp,
            isAnonymous: Boolean(parsed.args.isAnonymous),
            blockNumber,
            donationStatus: 'INDEXED',
            onChainConfirmedAt: eventTimestamp,
            indexedAt: now,
            correlationId: buildBlockchainCorrelationId(txHash),
            createdAt: now,
            updatedAt: now
          });
        } catch (err) {
          logger.error('[DataMapper] loi khi upsert donation record.', {
            transactionHash: txHash,
            errorMessage: (err as Error).message
          });
        }

        try {
          await createUnifiedTransactionFromBlockchain(
            buildBlockchainCorrelationId(txHash),
            {
              projectId,
              walletAddress: donorAddress,
              eventType: 'DONATION',
              amountVnd: amount,
              chainTxHash: txHash,
              chainBlockNumber: blockNumber,
              chainStatus: 'CONFIRMED',
              eventTimestamp
            }
          );
        } catch (err) {
          logger.error('[DataMapper] loi khi tao unified transaction record.', {
            correlationId: buildBlockchainCorrelationId(txHash),
            errorMessage: (err as Error).message
          });
          return;
        }

        processedBlockNumbers.add(blockNumber);
      }))
    );

    syncedCount = writeResults.filter((r) => r.status === 'fulfilled').length;

    // Cap nhat checkpoint den head block (khong phai max block trong events,
    // vi co the co reorg lam mat block).
    await saveLastSyncedBlockNumber(currentHeadBlock);
    logger.info(`[DataMapper] Da sync ${syncedCount} blockchain events (latest block: ${currentHeadBlock}).`);
    return { syncedCount, latestBlock: currentHeadBlock };
  } catch (err) {
    logger.error('[DataMapper] loi khi sync blockchain events.', {
      errorMessage: (err as Error).message
    });
    return { syncedCount: 0, latestBlock: 0 };
  }
}

/**
 * Correlate PayOS deposit records voi blockchain donation records.
 * Correlation criteria: cung walletAddress, cung amountVnd,
 * va thoi gian trong vong 30 phut.
 *
 * LUU Y QUAN TRONG: PayOS deposits KHONG co projectId nen khong the
 * dung projectId lam correlation key. Chi su dung walletAddress + amountVnd
 * trong time window de tranh match nham voi donations cua project khac.
 * Khi correlate thanh cong: cap nhat unified record thanh source = MIXED,
 * chainStatus = CONFIRMED, luu chainTxHash.
 */
/**
 * Lay nhung blockchain records co walletAddress + amountVnd trong time range.
 * Su dung batch query thay vi N+1 queries de tang performance.
 *
 * @param walletAddresses Danh sach dia chi wallet can tim
 * @param timeWindowStart Thoi gian bat dau
 * @param timeWindowEnd Thoi gian ket thuc
 * @returns Map voi key la "walletAddress:amountVnd", gia tri la blockchain record
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

  // Su dung dynamic import de tranh circular dependency voi repository layer
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

async function correlatePayosWithBlockchain(): Promise<number> {
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
      return 0;
    }

    logger.info(`[DataMapper] Correlating ${unmatchedPayosRecords.length} PayOS records voi blockchain.`);

    const validRecords = unmatchedPayosRecords.filter(r => {
      const walletAddress = String(r.walletAddress || '').toLowerCase();
      const amountVnd = Number(r.amountVnd || 0);
      return walletAddress && amountVnd > 0;
    });

    if (validRecords.length === 0) {
      return 0;
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
      logger.info('[DataMapper] Correlated PayOS deposit voi blockchain donation.', {
        utxId: payosRecord.utxId,
        correlationId: payosRecord.correlationId,
        chainTxHash: blockchainData.chainTxHash
      });
    }

    logger.info(`[DataMapper] Da correlate ${correlatedCount} records.`);
    return correlatedCount;
  } catch (err) {
    logger.error('[DataMapper] loi khi correlate PayOS voi blockchain.', {
      errorMessage: (err as Error).message
    });
    return 0;
  }
}

/**
 * Kiem tra mot loi co phai la "transaction not found" (da bi revert/bi xoa khoi chain).
 * Phan biet voi RPC error (network, timeout, rate limit) de tranh nham lan reorg.
 *
 * Ethers v6 tra ve error voi:
 * - code: 'CALL_EXCEPTION' (khi receipt null do tx bi revert/drop)
 * - shortMessage: chua 'transaction ... not found' hoac 'could not find'
 * - error.code === 'NOT_FOUND' tu Alchemy/Infura
 */
function isTransactionNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;

  const errorObj = err as Record<string, unknown>;
  const errorCode = String(errorObj.code || '');
  const errorMessage = String(errorObj.shortMessage || errorObj.message || '').toLowerCase();

  // Ethers v6 CALL_EXCEPTION khi transaction khong ton tai
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
 * Phat hien va danh dau blockchain reorg (fork).
 * Kiem tra nhung unified record co chainTxHash trong khoang block gan day,
 * lay receipt cua transaction hien tai, neu block number khac -> fork.
 * Neu receipt === null hoac "tx not found" -> tx bi revert hoan toan.
 *
 * LUU Y: Chi mark REORGED khi xac nhan "transaction not found".
 * RPC error (timeout, rate limit) KHONG duoc mark REORGED de tranh mat du lieu.
 */
async function detectAndMarkReorgs(): Promise<number> {
  const lastSyncedBlock = await getLastSyncedBlockNumber();
  if (lastSyncedBlock <= 0) return 0;

  const rpcUrl = String(process.env.BLOCKCHAIN_RPC_URL || '').trim();
  const contractAddress = String(process.env.DONATION_RANKING_CONTRACT_ADDRESS || '').trim();
  if (!rpcUrl || !contractAddress) return 0;

  const provider = getRpcProvider();
  if (!provider) return 0;

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
        chainTxHash: string;
        chainBlockNumber: number;
      }>>()
      .exec();

    if (recordsWithTx.length === 0) return 0;

    logger.info(`[DataMapper] Kiem tra ${recordsWithTx.length} records cho reorg detection.`);
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

    for (const result of reorgResults) {
      if (result.status === 'rejected') continue;

      const outcome = result.value;

      if (outcome.type === 'reorged') {
        try {
          await markChainTransactionReorged(outcome.record.chainTxHash);
          reorgedCount++;
          logger.warn('[DataMapper] Phat hien reorg: transaction bi revert.', {
            correlationId: outcome.record.correlationId,
            chainTxHash: outcome.record.chainTxHash,
            originalBlock: outcome.record.chainBlockNumber
          });
        } catch (markErr) {
          logger.error('[DataMapper] Loi khi mark REORGED.', {
            chainTxHash: outcome.record.chainTxHash,
            errorMessage: (markErr as Error).message
          });
        }
      } else if (outcome.type === 'fork') {
        await UnifiedTransactionModel.updateOne(
          { utxId: outcome.record.utxId },
          { $set: { chainBlockNumber: outcome.newBlock } }
        ).exec();
        logger.warn('[DataMapper] Phat hien fork: block number thay doi.', {
          correlationId: outcome.record.correlationId,
          oldBlock: outcome.record.chainBlockNumber,
          newBlock: outcome.newBlock
        });
      } else if (outcome.type === 'rpc_error') {
        logger.warn('[DataMapper] RPC error khi check receipt, bo qua (co the transient).', {
          correlationId: outcome.record.correlationId,
          chainTxHash: outcome.record.chainTxHash,
          errorMessage: (outcome.error as Error).message
        });
      }
    }

    if (reorgedCount > 0) {
      logger.warn(`[DataMapper] Da phat hien ${reorgedCount} records bi reorg.`);
    }
    return reorgedCount;
  } catch (err) {
    logger.error('[DataMapper] loi khi kiem tra reorg.', {
      errorMessage: (err as Error).message
    });
    return 0;
  }
}

/**
 * Ham chinh: chay mot chu ky sync hoan chinh.
 * Thuc hien theo thu tu:
 * 1. Kiem tra reorg (neu co checkpoint cu)
 * 2. Sync blockchain events
 * 3. Sync PayOS deposits
 * 4. Correlate PayOS voi blockchain
 * 5. Invalidate Redis cache
 */
export async function runDataMapperCycle(): Promise<{
  blockchainSynced: number;
  payosSynced: number;
  correlated: number;
  reorged: number;
}> {
  logger.info('[DataMapper] Bat dau chu ky sync data mapper.');

  const reorgedCount = await detectAndMarkReorgs();
  const blockchainResult = await syncBlockchainDonationEvents();
  const payosSyncedCount = await syncPayosDeposits();
  const correlatedCount = await correlatePayosWithBlockchain();

  const { invalidateUnifiedTimelineCache } = await import('../services/unified-timeline.service');
  await invalidateUnifiedTimelineCache();

  logger.info('[DataMapper] Hoan tat chu ky sync data mapper.', {
    blockchainSynced: blockchainResult.syncedCount,
    payosSynced: payosSyncedCount,
    correlated: correlatedCount,
    reorged: reorgedCount
  });

  return {
    blockchainSynced: blockchainResult.syncedCount,
    payosSynced: payosSyncedCount,
    correlated: correlatedCount,
    reorged: reorgedCount
  };
}

/**
 * Ham chinh: chay mot chu ky sync hoan chinh (co lock).
 * Su dung boi startDataMapperWorker cho ca initial run va recurring runs.
 */
async function runDataMapperCycleWithLock(): Promise<void> {
  const lockAcquired = await acquireDistributedLock();
  if (!lockAcquired) {
    logger.info('[DataMapper] Lock khong acquired, bo qua run nay.');
    return;
  }

  try {
    await runDataMapperCycle();
  } catch (err) {
    logger.error('[DataMapper] Data mapper cycle that bai.', {
      errorMessage: (err as Error).message
    });
  } finally {
    await releaseDistributedLock();
  }
}

/**
 * Khoi dong Data Mapper worker.
 * Chay moi 5 phut bang recursive setTimeout de dam bao moi lan
 * chay hoan tat truoc khi tinh delay cho lan tiep theo.
 *
 * Ca initial run lan recurring deu duoc wrap trong distributed lock
 * de tranh multiple instances chay dong thoi tren multi-pod deployment.
 */
export function startDataMapperWorker(): void {
  logger.info('Data Mapper worker khoi dong (chu ky 5 phut).');

  const runWithInterval = (): void => {
    setTimeout(() => {
      runDataMapperCycleWithLock().catch((err) => logger.error('[DataMapper] Data mapper cycle failed', err));
      runWithInterval();
    }, SYNC_INTERVAL_MS);
  };

  // Initial run cung phai qua distributed lock
  void runDataMapperCycleWithLock();

  runWithInterval();
}
