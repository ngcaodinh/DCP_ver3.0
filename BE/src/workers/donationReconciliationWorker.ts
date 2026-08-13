/**
 * Worker reconciliation kiểm tra và khôi phục các donation bị kẹt trong pipeline.
 * Chạy mỗi 15 phút để phát hiện các UserOperation đã sponsor nhưng chưa index on-chain.
 *
 * Nhiệm vụ:
 * - Tìm các session có audit record đã tạo (PAYMASTER_REQUESTED) nhưng chưa có onChainTxHash
 * - Tìm các session ACTIVE có donationCount===0 nhưng không có audit nào (orphaned)
 *   — đây là case PayOS đã mint token vào ví nhưng trình duyệt crash trước khi user donate
 * - Check ERC-20 CharityToken balance của guest wallet trên chain
 * - Set hasPendingDonation = true nếu balance > 0 để frontend hiển thị auto-resume modal
 * - Không gửi email — chỉ set flag cho frontend polling
 *
 * Concurrency: Dùng Redis distributed lock (SETNX) để đảm bảo chỉ 1 instance chạy tại mỗi thời điểm.
 * Environment: Validate CHARITY_TOKEN_CONTRACT_ADDRESS (EIP-55) và BLOCKCHAIN_RPC_URL (HTTP(S))
 *   trước khi khởi động worker.
 */
import { ethers } from 'ethers';
import { getLogger } from '../config/logger';
import { runWithWorkerContext } from '../config/requestContext';
import { getRedisClientIfReady } from '../config/redis';
import {
  findUnindexedAudits,
  findAuditsBySessionId
} from '../repositories/anonymousDonationAuditRepository';
import {
  findGuestWalletSessionById,
  updateGuestWalletSession,
  findGuestWalletSessionsByIds,
  findOrphanedActiveSessions
} from '../repositories/guestWalletSessionRepository';

const logger = getLogger();

/**
 * Khoảng thời gian giữa các lần chạy worker (15 phút).
 */
const RECONCILIATION_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Số bản ghi tối đa xử lý mỗi lần chạy.
 * Giới hạn batch để tránh quá tải RPC và MongoDB.
 */
const BATCH_SIZE = 100;

/**
 * Số request đồng thời tối đa đến RPC provider.
 * Giới hạn để tránh rate limit từ blockchain RPC provider.
 */
const RPC_CONCURRENCY = 10;

/**
 * ABI tối thiểu cho ERC-20 balanceOf.
 */
const ERC20_BALANCE_OF_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }]
  }
] as const;

/**
 * Ngưỡng balance tối thiểu (wei) để coi là "có tiền" và set flag pending donation.
 * Balance phải lớn hơn 0.
 */
const MIN_BALANCE_THRESHOLD = BigInt(1);

/**
 * TTL cho distributed lock (14 phút = 840 giây).
 * Đặt ngắn hơn RECONCILIATION_INTERVAL_MS (15 phút) để lock được giải phóng
 * kịp thời nếu instance crash.
 */
const LOCK_TTL_MS = 14 * 60 * 1000;

/**
 * Redis key cho distributed lock.
 */
const RECONCILIATION_LOCK_KEY = 'donation_reconciliation:lock';

/**
 * RPC provider dùng chung cho toàn bộ worker lifecycle.
 * Khởi tạo 1 lần duy nhất — tránh tạo instance mới mỗi lần gọi balance.
 */
export let rpcProvider: ethers.JsonRpcProvider | null = null;

/**
 * Địa chỉ ERC-20 CharityToken contract để check token balance.
 */
export let charityTokenAddress: string | null = null;

/**
 * Reset trạng thái module-level giữa các test runs.
 * Cần gọi sau mỗi test để tránh singleton state leak.
 */
export function resetModuleState(): void {
  rpcProvider = null;
  charityTokenAddress = null;
}

/**
 * Hàm lấy địa chỉ CharityToken contract.
 * @returns Địa chỉ contract hoặc chuỗi rỗng nếu chưa cấu hình
 */
function getCharityTokenAddress(): string {
  if (charityTokenAddress === null) {
    charityTokenAddress = String(process.env.CHARITY_TOKEN_CONTRACT_ADDRESS || '').trim();
  }
  return charityTokenAddress;
}

/**
 * Hàm lấy hoặc khởi tạo RPC provider singleton.
 * @returns Provider instance hoặc null nếu chưa có RPC_URL
 */
function getRpcProvider(): ethers.JsonRpcProvider | null {
  const rpcUrl = getBlockchainRpcUrl();
  if (!rpcUrl) {
    return null;
  }
  if (!rpcProvider) {
    rpcProvider = new ethers.JsonRpcProvider(rpcUrl);
  }
  return rpcProvider;
}

/**
 * Địa chỉ RPC để đọc on-chain balance.
 */
function getBlockchainRpcUrl(): string {
  return String(process.env.BLOCKCHAIN_RPC_URL || '').trim();
}

/**
 * Hàm extract message từ error object.
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
 * Hàm validate EIP-55 checksum cho địa chỉ EVM.
 * Địa chỉ hợp lệ phải có checksum đúng theo EIP-55 standard.
 *
 * @param address - Địa chỉ EVM cần validate
 * @returns true nếu checksum hợp lệ
 */
function isValidEip55Address(address: string): boolean {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return false;
  }
  try {
    return address === ethers.getAddress(address);
  } catch {
    return false;
  }
}

/**
 * Hàm validate URL cho RPC endpoint.
 * Chỉ chấp nhận HTTP và HTTPS protocols.
 *
 * @param url - URL cần validate
 * @returns true nếu là HTTP(S) URL hợp lệ
 */
function isValidHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Hàm validate các biến môi trường bắt buộc cho worker.
 * Kiểm tra tại startup để fail early thay vì crash giữa chừng.
 *
 * @returns true nếu tất cả env vars hợp lệ, false nếu có lỗi
 */
export function validateWorkerEnvironment(): boolean {
  const contractAddress = String(process.env.CHARITY_TOKEN_CONTRACT_ADDRESS || '').trim();
  const rpcUrl = String(process.env.BLOCKCHAIN_RPC_URL || '').trim();

  if (!contractAddress) {
    logger.error(
      '[DonationReconciliation] CHARITY_TOKEN_CONTRACT_ADDRESS chưa được cấu hình. Worker không khởi động.'
    );
    return false;
  }

  if (!isValidEip55Address(contractAddress)) {
    logger.error(
      '[DonationReconciliation] CHARITY_TOKEN_CONTRACT_ADDRESS không phải là địa chỉ EIP-55 hợp lệ. Giá trị hiện tại: ' + contractAddress
    );
    return false;
  }

  if (!rpcUrl) {
    logger.error(
      '[DonationReconciliation] BLOCKCHAIN_RPC_URL chưa được cấu hình. Worker không khởi động.'
    );
    return false;
  }

  if (!isValidHttpUrl(rpcUrl)) {
    logger.error(
      '[DonationReconciliation] BLOCKCHAIN_RPC_URL phải là HTTP(S) URL hợp lệ. Giá trị hiện tại: ' + rpcUrl
    );
    return false;
  }

  return true;
}

/**
 * Hàm thử acquire distributed lock bằng Redis SETNX.
 * Dùng SET với NX option để đảm bảo atomic set-if-not-exists.
 *
 * @returns true nếu lock acquired thành công, false nếu lock đã được held bởi instance khác
 */
export async function acquireDistributedLock(): Promise<boolean> {
  const redisClient = getRedisClientIfReady();
  if (!redisClient) {
    logger.info('[DonationReconciliation] Redis chưa sẵn sàng, bỏ qua lock acquisition.');
    return true;
  }

  try {
    const result = await redisClient.set(
      RECONCILIATION_LOCK_KEY,
      process.pid.toString(),
      {
        NX: true,
        PX: LOCK_TTL_MS
      }
    );
    if (result === 'OK') {
      logger.info('[DonationReconciliation] Distributed lock acquired.');
      return true;
    }
    logger.info('[DonationReconciliation] Distributed lock đã được held bởi instance khác, bỏ qua run này.');
    return false;
  } catch (error) {
    logger.warn('[DonationReconciliation] Lỗi khi acquire distributed lock.', {
      errorMessage: extractErrorMessage(error)
    });
    return true;
  }
}

/**
 * Hàm giải phóng distributed lock.
 * Chỉ giải phóng nếu lock được hold bởi process hiện tại (tránh release lock của instance khác).
 */
export async function releaseDistributedLock(): Promise<void> {
  const redisClient = getRedisClientIfReady();
  if (!redisClient) {
    return;
  }

  try {
    const currentHolder = await redisClient.get(RECONCILIATION_LOCK_KEY);
    if (currentHolder === process.pid.toString()) {
      await redisClient.del(RECONCILIATION_LOCK_KEY);
      logger.info('[DonationReconciliation] Distributed lock released.');
    }
  } catch (error) {
    logger.warn('[DonationReconciliation] Lỗi khi release distributed lock.', {
      errorMessage: extractErrorMessage(error)
    });
  }
}

/**
 * Hàm lấy số dư CharityToken ERC-20 của một ví trên chain.
 * Kiểm tra ERC-20 balance thay vì ETH balance để tránh false positive
 * (user có ETH nhưng chưa có token donation).
 *
 * @param walletAddress - Địa chỉ ví EVM cần kiểm tra
 * @returns Số dư token (wei) hoặc null nếu lỗi
 */
export async function getTokenBalance(walletAddress: string): Promise<bigint | null> {
  const provider = getRpcProvider();
  if (!provider) {
    logger.warn('[DonationReconciliation] BLOCKCHAIN_RPC_URL chưa được cấu hình.');
    return null;
  }

  const tokenAddress = getCharityTokenAddress();
  if (!tokenAddress) {
    logger.warn('[DonationReconciliation] CHARITY_TOKEN_CONTRACT_ADDRESS chưa được cấu hình.');
    return null;
  }

  try {
    const tokenContract = new ethers.Contract(tokenAddress, ERC20_BALANCE_OF_ABI, provider);
    const balance = await tokenContract.balanceOf(walletAddress) as bigint;
    return balance;
  } catch (error) {
    logger.error('[DonationReconciliation] Lỗi khi đọc ERC-20 balance on-chain.', {
      errorMessage: extractErrorMessage(error),
      walletAddress,
      charityTokenAddress: tokenAddress
    });
    return null;
  }
}

/**
 * Hàm kiểm tra và xử lý một session bị kẹt.
 * Logic:
 * 1. Nếu có audit records: kiểm tra xem có unindexed donation không → check on-chain balance
 * 2. Nếu không có audit records (orphaned session): check balance trực tiếp
 * 3. Nếu balance > 0 → set hasPendingDonation = true
 *
 * @param sessionId - ID của phiên guest wallet
 * @param session - Dữ liệu session đã fetch sẵn (tránh re-query)
 * @param audits - Danh sách audit records đã pre-fetch, undefined = chưa query (orphaned path)
 * @returns true nếu đã set flag pending donation
 */
export async function reconcileSession(
  sessionId: string,
  session: Awaited<ReturnType<typeof findGuestWalletSessionById>>,
  audits?: Awaited<ReturnType<typeof findAuditsBySessionId>>
): Promise<boolean> {
  if (!session) {
    logger.info('[DonationReconciliation] Session không tìm thấy trong DB.', { sessionId });
    return false;
  }

  if (session.status !== 'ACTIVE') {
    return false;
  }

  // Bỏ qua nếu đã được gắn cờ pending — tránh gọi RPC và update DB lặp lại mỗi 15 phút
  // khi user chưa mở lại trình duyệt để resume donation.
  if (session.hasPendingDonation) {
    return false;
  }

  // Orphaned path: session ACTIVE nhưng chưa có audit nào (PayOS đã nạp tiền nhưng
  // trình duyệt crash trước khi user bấm Donate → AnonymousDonationAudit chưa được tạo).
  // Caller đã pre-populate audits = [] cho nhóm orphaned (line 482) để bypass DB query.
  // Nullish coalescing ?? đảm bảo: orphaned (audits=[]) → dùng trực tiếp [], không query lại;
  // non-orphaned chưa pre-fetched (audits=undefined) → fallback sang DB query (fix N+1).
  const auditRecords = audits ?? await findAuditsBySessionId(sessionId);

  const hasUnindexedDonation = auditRecords.length > 0 && auditRecords.some(
    audit => audit.onChainTxHash === null && audit.paymasterSponsoredGas
  );

  // Merge condition: orphaned (no audits) OR unindexed donation → check balance
  if (auditRecords.length === 0 || hasUnindexedDonation) {
    const balance = await getTokenBalance(session.walletAddress);
    if (balance !== null && balance > MIN_BALANCE_THRESHOLD) {
      await updateGuestWalletSession(sessionId, {
        hasPendingDonation: true,
        updatedAt: new Date()
      });

      logger.info('[DonationReconciliation] Session có pending donation. Flag đã được set.', {
        sessionId
      });
      return true;
    }
  }

  return false;
}

/**
 * Lớp semaphore để giới hạn số tác vụ chạy đồng thời.
 * Thay thế processWithConcurrencyLimit cũ (vòng for+await không đảm bảo concurrency).
 * Sử dụng: tạo instance với concurrency limit, gọi run() cho mỗi item.
 */
export class Semaphore {
  private readonly maxConcurrent: number;
  private running = 0;
  private queue: Array<() => void> = [];

  constructor(maxConcurrent: number) {
    this.maxConcurrent = maxConcurrent;
  }

  private release(): void {
    this.running--;
    const next = this.queue.shift();
    if (next) {
      next();
    }
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const execute = async (): Promise<void> => {
        this.running++;
        try {
          const result = await fn();
          resolve(result);
        } catch (error) {
          reject(error);
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

/**
 * Hàm chạy reconciliation cho tất cả unindexed sessions và orphaned sessions.
 * Mỗi 15 phút, worker:
 * 1. Tìm các audit records chưa được index → check balance tương ứng
 * 2. Tìm các session ACTIVE không có audit nào (orphaned) → check balance
 *
 * @returns Số session đã được set flag pending donation
 */
async function runReconciliationCycle(): Promise<number> {
  logger.info('[DonationReconciliation] Bắt đầu reconciliation worker.');

  // =========================================================
  // Path 1: Sessions có audit records chưa index
  // =========================================================
  const unindexedAudits = await findUnindexedAudits(BATCH_SIZE);
  const sessionIdsFromAudits = Array.from(new Set(unindexedAudits.map(a => a.sessionId)));

  // Batch fetch sessions từ audit sessionIds — tránh N+1 trong reconcileSession
  const sessionsFromAudits = await findGuestWalletSessionsByIds(sessionIdsFromAudits);
  const sessionMap = new Map(sessionsFromAudits.map(s => [s.sessionId, s]));

  // Build audit map: sessionId → audits[]
  const auditMap = new Map<string, typeof unindexedAudits>();
  for (const audit of unindexedAudits) {
    if (!auditMap.has(audit.sessionId)) {
      auditMap.set(audit.sessionId, []);
    }
    auditMap.get(audit.sessionId)!.push(audit);
  }

  if (sessionIdsFromAudits.length) {
    logger.info(`[DonationReconciliation] Tìm thấy ${sessionIdsFromAudits.length} sessions từ unindexed audits.`);
  }

  // =========================================================
  // Path 2: Orphaned sessions (không có audit record)
  // =========================================================
  const orphanedSessions = await findOrphanedActiveSessions();
  if (orphanedSessions.length) {
    logger.info(`[DonationReconciliation] Tìm thấy ${orphanedSessions.length} orphaned sessions cần kiểm tra.`);
  }

  // =========================================================
  // Deduplicate: loại bỏ orphaned sessions đã nằm trong sessionIdsFromAudits
  // =========================================================
  const seenSessionIds = new Set(sessionIdsFromAudits);
  const uniqueOrphaned = orphanedSessions.filter(s => !seenSessionIds.has(s.sessionId));

  // =========================================================
  // Xử lý tất cả sessions với Semaphore giới hạn RPC concurrency
  // =========================================================
  const allSessions = [
    ...sessionIdsFromAudits.map(id => ({
      sessionId: id,
      session: sessionMap.get(id) ?? null,
      audits: auditMap.get(id) ?? []
    })),
    ...uniqueOrphaned.map(s => ({
      sessionId: s.sessionId,
      session: s,
      audits: [] as Awaited<ReturnType<typeof findAuditsBySessionId>>
    }))
  ];

  const semaphore = new Semaphore(RPC_CONCURRENCY);
  const tasks = allSessions.map(item => () =>
    semaphore.run(async () => {
      try {
        return await reconcileSession(item.sessionId, item.session, item.audits);
      } catch (error) {
        logger.error('[DonationReconciliation] Lỗi khi reconcile session.', {
          sessionId: item.sessionId,
          errorMessage: extractErrorMessage(error)
        });
        return false;
      }
    })
  );

  const results = await Promise.all(tasks.map(task => task()));

  const flaggedCount = results.filter(Boolean).length;
  logger.info(`[DonationReconciliation] Hoàn tất reconciliation. Đã flag ${flaggedCount} sessions có pending donation.`);
  return flaggedCount;
}

/**
 * Chạy một lần reconciliation trong correlation scope riêng của worker.
 * @returns Số session đã được set flag pending donation.
 */
export async function runReconciliation(): Promise<number> {
  return runWithWorkerContext('donation-reconciliation', () => runReconciliationCycle());
}

/**
 * Hàm khởi động donation reconciliation worker.
 * Chạy mỗi 15 phút bằng recursive setTimeout để đảm bảo mỗi lần
 * chạy hoàn tất trước khi tính delay cho lần tiếp theo.
 *
 * Multi-instance safety: Dùng Redis distributed lock (SETNX) để đảm bảo
 * chỉ 1 instance chạy reconciliation tại mỗi thời điểm.
 */
export function startDonationReconciliationWorker(): void {
  // Validate environment variables trước khi khởi động
  if (!validateWorkerEnvironment()) {
    logger.error('[DonationReconciliation] Worker không khởi động do lỗi cấu hình môi trường.');
    return;
  }

  logger.info('Donation reconciliation worker khởi động (chạy mỗi 15 phút).');

  const runWithInterval = (): void => {
    setTimeout(() => {
      // Bao phủ cả lock và reconciliation để mọi log của scheduled run có cùng correlation ID.
      void runWithWorkerContext('donation-reconciliation', async () => {
        // Thử acquire distributed lock trước khi chạy reconciliation
        const lockAcquired = await acquireDistributedLock();
        if (!lockAcquired) {
          logger.info('[DonationReconciliation] Lock không acquired, bỏ qua run này.');
        } else {
          try {
            await runReconciliationCycle();
          } catch (error) {
            logger.error('[DonationReconciliation] Reconciliation worker thất bại.', {
              errorMessage: extractErrorMessage(error)
            });
          } finally {
            await releaseDistributedLock();
          }
        }

        runWithInterval();
      });
    }, RECONCILIATION_INTERVAL_MS);
  };

  runWithInterval();
}
