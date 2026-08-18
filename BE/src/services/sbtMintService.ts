/**
 * [I-A3] TECH DEBT: File chứa 5 distinct responsibilities cần tách theo SRP.
 *
 * Migration plan (thực hiện trong future PR riêng):
 * 1. Tạo BE/src/services/sbtMintRequest.service.ts
 *    - Di chuyển: createSbtMintRequest, CreateSbtMintRequestInput type
 *    - Export: createSbtMintRequest, CreateSbtMintRequestInput
 *
 * 2. Tạo BE/src/services/sbtMintExecution.service.ts
 *    - Di chuyển: executeSbtMint, parseSbtMintedTokenId, validateBeneficiaryAddress,
 *      normalizeBeneficiaryAddress, _writableContract, getWritableContract, resetWritableContractForTest
 *    - Import: sbtMintRequest.service, sbtMintQueue, impactSbtMetadataModel
 *    - Export: executeSbtMint, resetWritableContractForTest
 *
 * 3. Tạo BE/src/services/sbtMintFailure.service.ts
 *    - Di chuyển: handleSbtMintFailure, SBT_MINT_MAX_ATTEMPTS, SBT_MINT_RETRY_DELAYS_MS
 *    - Import: sbtMintQueue, sbtMintDlqModel, impactSbtMetadataModel
 *    - Export: handleSbtMintFailure, SBT_MINT_MAX_ATTEMPTS, SBT_MINT_RETRY_DELAYS_MS
 *
 * 4. Tạo BE/src/services/sbtMintRerun.service.ts
 *    - Di chuyển: rerunSbtMintJob
 *    - Import: sbtMintQueue, impactSbtMetadataModel
 *    - Export: rerunSbtMintJob
 *
 * 5. Tạo BE/src/services/sbtMintRecovery.service.ts
 *    - Di chuyển: recoverStuckSbtMints, findImpactSbtNeedingRecovery
 *    - Import: sbtMintQueue, impactSbtMetadataModel
 *    - Export: recoverStuckSbtMints, findImpactSbtNeedingRecovery
 *
 * 6. BE/src/services/sbtMintService.ts trở thành barrel export file:
 *    - Re-export tất cả exports từ 5 service files
 *    - Import và re-export: extractErrorMessage (từ utils)
 *    - Tạm thời keep nguyên để tránh breaking change trong single PR
 */
import { randomUUID } from 'crypto';
import { ethers } from 'ethers';
import { SBT_MINT_CONFIRMATION_BLOCKS } from '../constants/sbtMint';
import { getLogger } from '../config/logger';
import { ApplicationError } from '../utils/applicationError';
import { extractErrorMessage } from '../utils/extractErrorMessage';
import { sanitizeProviderError } from '../utils/sanitizeProviderError';
import * as eventLoggerService from './event-logger.service';

// Re-export để giữ backward compatibility cho tests và các module đang import
export { extractErrorMessage };
import {
  createImpactSbtMetadata,
  findImpactSbtMetadataByMintRequestId,
  claimImpactSbtForSubmission,
  reserveImpactSbtSubmissionNonce,
  markImpactSbtAsSubmitted,
  markImpactSbtAsConfirmed,
  markImpactSbtAsFailed,
  releaseExpiredSbtSubmissionWithoutNonce,
  markImpactSbtAsDlq,
  resetImpactSbtForReRun,
  type ImpactSbtMetadataRecord
} from '../models/impactSbtMetadataModel';
import {
  createSbtMintDlqEntry,
  markSbtMintDlqAsRecovered,
  findSbtMintDlqByMintRequestId,
  markSbtMintDlqRerunStarted,
  markSbtMintDlqRerunFailed
} from '../models/sbtMintDlqModel';
import {
  getWritableImpactSbtContract,
  getReadOnlyImpactSbtProvider,
  getImpactSbtMintSignerAddress
} from '../config/sbtContract';
import { reserveNextSbtMintNonce } from '../models/sbtMintNonceModel';
import {
  sbtEvents,
  type SbtMintedEventPayload,
  type SbtMintFailedEventPayload,
  type SbtMintDlqEventPayload
} from '../events/sbtEvents';
import {
  enqueueSbtMint,
  countPendingSbtMintJobsByRequestId,
  removePendingSbtMintJobsByRequestId,
  SBT_MINT_RETRY_DELAYS_MS,
  SBT_MINT_MAX_ATTEMPTS
} from '../queues/sbtMintQueue';
import { findImpactSbtNeedingRecovery } from '../models/impactSbtMetadataModel';
import { invalidateSbtGalleryTotalCache } from './sbtMetadataCacheService';
import { recordAdminAuditLog } from './audit-log.service';
import type { AuditRequestContext } from '../utils/auditRequestContext';
import { runMongoTransaction } from '../utils/mongoTransaction';
import { createAdminActionOutbox } from '../models/adminActionOutboxModel';
import { runAdminActionOutboxOnce } from '../workers/adminActionOutboxWorker';
import { recordBlockchainTransaction } from '../utils/blockchainMetrics';


/**
 * Số block confirmations dùng chung được đọc từ constants để mint và status update có cùng semantics.
 */
const logger = getLogger();

// Cache ethers.Interface cho SBTMinted event — tránh tạo mới mỗi lần parse logs.
// Hot path: chạy cho mỗi attempt mint, nên cache là critical cho performance.
const SBT_MINTED_EVENT_IFACE = new ethers.Interface([
  'event SBTMinted(address indexed to, uint256 indexed tokenId, string tokenURI_)'
]);

const SBT_MINT_RECEIPT_WAIT_TIMEOUT_MS = 60_000;
const SBT_SUBMISSION_LEASE_MS = 120_000;

/** Lỗi persistence sau broadcast không được retry vì retry có thể tạo transaction thứ hai. */
export class SbtSubmissionPersistenceError extends Error {
  public readonly doNotRetry = true;

  constructor(message: string) {
    super(message);
    this.name = 'SbtSubmissionPersistenceError';
  }
}

/** Chờ receipt có timeout để worker slot được giải phóng; reconciler tiếp tục theo dõi tx hash. */
async function waitForReceiptWithTimeout(
  txResponse: ethers.TransactionResponse,
  confirmations: number
): Promise<ethers.TransactionReceipt | null> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<null>(resolve => {
    timeoutHandle = setTimeout(() => resolve(null), SBT_MINT_RECEIPT_WAIT_TIMEOUT_MS);
  });
  try {
    return await Promise.race([txResponse.wait(confirmations), timeoutPromise]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

// ============================================================
// SECTION 1: Mint Request Creation (createSbtMintRequest)
// ============================================================

/**
 * Tham số tạo mint request khi Oracle verify thành công.
 * Mục đích: chuẩn hóa input từ oracle.verified event → DB record + queue job.
 */
export type CreateSbtMintRequestInput = {
  verificationId: string;
  projectId: string;
  organizationId: string;
  beneficiaryAddress: string;
  projectIdNumeric: number;
  milestone: number;
  beneficiaryCount: number;
  gpsCoordinates: string;
  imageCid: string;
  tokenUri: string;
};

/** Bảo đảm record cũ vẫn có job runnable sau khi event hoặc lần ghi trạng thái trước đó bị mất. */
async function ensureExistingSbtMintDispatch(
  record: ImpactSbtMetadataRecord
): Promise<{ jobId: string | number | undefined; enqueued: boolean }> {
  if (record.status !== 'PENDING' && record.status !== 'FAILED') {
    return { jobId: undefined, enqueued: false };
  }

  const pendingJobCount = await countPendingSbtMintJobsByRequestId(record.mintRequestId);
  if (pendingJobCount > 0) {
    return { jobId: undefined, enqueued: true };
  }

  if (record.status === 'FAILED' && record.attemptNumber >= SBT_MINT_MAX_ATTEMPTS) {
    return { jobId: undefined, enqueued: false };
  }

  const currentAttempt = Number.isFinite(record.attemptNumber) ? record.attemptNumber : 0;
  const nextAttempt = record.status === 'PENDING'
    ? Math.max(1, currentAttempt)
    : Math.min(currentAttempt + 1, SBT_MINT_MAX_ATTEMPTS);
  return enqueueSbtMint(
    {
      mintRequestId: record.mintRequestId,
      sbtId: record.sbtId,
      attemptNumber: nextAttempt,
      enqueuedBy: 'oracle_event'
    },
    { priority: 5 }
  );
}

/**
 * Validate địa chỉ EVM — throws nếu không hợp lệ.
 * Dùng cho input validation ở service boundary.
 */
function validateBeneficiaryAddress(address: string): void {
  if (!ethers.isAddress(address)) {
    throw new Error(`Địa chỉ beneficiary không hợp lệ: ${address}`);
  }
}

/**
 * Chuẩn hóa địa chỉ EVM về checksum address để lưu vào DB.
 * ethers.getAddress() trả về checksum address (mixed case theo EIP-55).
 * Lưu ý: Khi so sánh địa chỉ, nên dùng .toLowerCase() để tránh case-sensitivity issues.
 * Contract/frontend sẽ tự normalize khi cần.
 */
function normalizeBeneficiaryAddress(address: string): string {
  validateBeneficiaryAddress(address);
  return ethers.getAddress(address);
}

/**
 * Hàm tạo mint request mới khi Oracle verified thành công.
 *
 * Flow idempotent:
 * 1. Thử upsert metadata với verificationId (atomic — tránh race condition)
 * 2. Nếu verificationId đã tồn tại → trả về existing record (duplicate)
 * 3. Nếu chưa có → tạo metadata PENDING + enqueue job
 *
 * Hàm này được gọi từ oracle event handler trong sbtMintWorker.startSbtMintWorker.
 * KHÔNG gọi trực tiếp từ API — task C3 (Oracle→SBT Trigger API) sẽ wrap với auth.
 *
 * [IMPORTANT #19 fix] Dùng atomic upsert trong createImpactSbtMetadata thay vì
 * find-then-create (race window). Không cần try-catch duplicate key nữa.
 *
 * @returns Metadata record đã tạo (hoặc existing nếu duplicate) + jobId nếu enqueue thành công
 */
export async function createSbtMintRequest(
  input: CreateSbtMintRequestInput
): Promise<{ record: ImpactSbtMetadataRecord; jobId: string | number | undefined; enqueued: boolean; duplicate: boolean }> {
  const normalizedBeneficiary = normalizeBeneficiaryAddress(input.beneficiaryAddress);
  const mintRequestId = `SBT-MINT-${randomUUID()}`;
  const sbtId = `SBT-${randomUUID()}`;

  const recordInput: Omit<ImpactSbtMetadataRecord, 'createdAt' | 'updatedAt'> = {
    sbtId,
    mintRequestId,
    verificationId: input.verificationId,
    projectId: input.projectId,
    organizationId: input.organizationId,
    beneficiaryAddress: normalizedBeneficiary,
    projectIdNumeric: input.projectIdNumeric,
    milestone: input.milestone,
    beneficiaryCount: input.beneficiaryCount,
    gpsCoordinates: input.gpsCoordinates,
    imageCid: input.imageCid,
    tokenUri: input.tokenUri,
    status: 'PENDING',
    attemptNumber: 0,
    lastErrorMessage: null,
    onChainTokenId: null,
    transactionHash: null,
    transactionNonce: null,
    submissionLeaseOwner: null,
    submissionLeaseExpiresAt: null,
    blockNumber: null,
    confirmedAt: null,
    submittedAt: null,
    dlqAt: null,
    reRunCount: 0,
    lastReRunBy: null,
    lastReRunAt: null
  };

  // [IMPORTANT #19 fix] Atomic upsert — không có race window nữa
  // createImpactSbtMetadata dùng findOneAndUpdate với upsert: true
  const record = await createImpactSbtMetadata(recordInput);

  // Kiểm tra duplicate: nếu returned record có sbtId khác với sbtId vừa generate,
  // có nghĩa là đã có record tồn tại (upsert không insert)
  if (record.sbtId !== sbtId) {
    const dispatchResult = await ensureExistingSbtMintDispatch(record);
    // Duplicate vẫn phải đảm bảo dispatch; nếu job cũ đã mất, enqueue lại theo idempotency key.
    logger.info('SBT mint request đã tồn tại cho verification này — bỏ qua duplicate (atomic upsert).', {
      mintRequestId: record.mintRequestId,
      sbtId: record.sbtId,
      verificationId: input.verificationId,
      status: record.status,
      enqueued: dispatchResult.enqueued
    });
    return {
      record,
      jobId: dispatchResult.jobId,
      enqueued: dispatchResult.enqueued,
      duplicate: true
    };
  }

  // New record created successfully — proceed with enqueue

  // Enqueue job attempt đầu tiên
  const enqueueResult = await enqueueSbtMint(
    {
      mintRequestId,
      sbtId,
      attemptNumber: 1,
      enqueuedBy: 'oracle_event'
    },
    { priority: 5 } // Priority thấp = chạy sớm
  );

  if (!enqueueResult.enqueued) {
    logger.warn('SBT mint job không enqueue được — sẽ được cron recovery pick up sau 15p.', {
      mintRequestId,
      sbtId
    });
  }

  logger.info('SBT mint request đã tạo và enqueue job.', {
    mintRequestId,
    sbtId,
    projectId: input.projectId,
    beneficiaryAddress: normalizedBeneficiary,
    attemptNumber: 1,
    enqueued: enqueueResult.enqueued,
    jobId: enqueueResult.jobId
  });

  return { record, jobId: enqueueResult.jobId, enqueued: enqueueResult.enqueued, duplicate: false };
}

// ============================================================
// SECTION 2: Mint Execution (executeSbtMint, parseSbtMintedTokenId)
// ============================================================

// Contract instance — tạo 1 lần, reuse cho tất cả executeSbtMint calls.
// ethers.Contract với signer không hold persistent connection,
// chỉ hold provider reference. Việc tạo 1 instance tránh overhead mỗi call.
let _writableContract: ethers.Contract | null = null;

function getWritableContract(): ethers.Contract {
  if (!_writableContract) {
    _writableContract = getWritableImpactSbtContract();
  }
  return _writableContract;
}

/**
 * Reset cached contract instance — dùng trong test để tránh stale mock.
 * KHÔNG gọi trong production code.
 */
export function resetWritableContractForTest(): void {
  _writableContract = null;
}

/**
 * Helper: trả về số nhỏ hơn trong hai BigInt.
 * Dùng cho gas limit cap (BLOCKER #3).
 */
function minBigInt(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

/**
 * Kiểm tra DLQ status sau khi mint confirm (fire-and-forget).
 * Nếu record từng vào DLQ, đánh dấu RECOVERED.
 */
async function checkSbtMintDlqStatus(mintRequestId: string): Promise<void> {
  const dlqEntry = await findSbtMintDlqByMintRequestId(mintRequestId);
  if (dlqEntry && dlqEntry.status === 'OPEN') {
    await markSbtMintDlqAsRecovered(mintRequestId, {
      recoveredBy: 'system_auto_recovery',
      recoveredAt: new Date()
    });
  }
}

/**
 * Hàm thực thi 1 attempt mint SBT on-chain.
 * Được gọi bởi sbtMintWorker.processSbtMintJob.
 *
 * Flow:
 * 1. Load metadata — nếu không tồn tại hoặc đã CONFIRMED → return early
 * 2. Kiểm tra idempotency — nếu đã có job active cho mintRequestId này → skip
 * 3. Tạo ethers contract, gọi mint() với params từ metadata
 * 4. Chờ receipt (1 confirm), parse SBTMinted event để lấy tokenId
 * 5. Update metadata → CONFIRMED + emit sbt.minted event
 *
 * Nếu lỗi:
 * - Revert/timeout/RPC error → throw để Bull retry logic xử lý
 * - Lỗi không retry được (invalid address, etc.) → throw AppError để worker moveToDLQ
 */
export async function executeSbtMint(
  mintRequestId: string,
  attemptNumber: number
): Promise<{
  onChainTokenId: number | null;
  transactionHash: string | null;
  blockNumber: number | null;
  status: 'CONFIRMED' | 'SUBMITTED' | 'FAILED' | 'DLQ';
}> {
  const record = await findImpactSbtMetadataByMintRequestId(mintRequestId);
  if (!record) {
    throw new Error(`Không tìm thấy metadata cho mintRequestId=${mintRequestId}`);
  }

  // Idempotency: nếu đã CONFIRMED thì không cần mint lại
  if (record.status === 'CONFIRMED' && record.onChainTokenId !== null) {
    logger.info('SBT đã CONFIRMED trước đó — bỏ qua mint().', {
      mintRequestId,
      sbtId: record.sbtId,
      onChainTokenId: record.onChainTokenId
    });
    return {
      onChainTokenId: record.onChainTokenId,
      transactionHash: record.transactionHash,
      blockNumber: record.blockNumber,
      status: 'CONFIRMED'
    };
  }

  // [I3 fix] Bỏ check getActiveSbtMintJobByRequestId vì job hiện tại ĐANG chạy
  // sẽ tự phát hiện chính nó trong queue.getActive() → false positive, skip mọi mint.
  // Idempotency đã đảm bảo bởi 3 lớp:
  //   1. CONFIRMED early-return (ở trên)
  //   2. createSbtMintRequest check verificationId unique
  //   3. markImpactSbtAsSubmitted với status filter PENDING|FAILED (DB-level guard)
  // Nếu thật sự có race giữa 2 jobs retry cùng mintRequestId, transaction on-chain
  // sẽ revert vì duplicate nonce/SUBMITTED state — Bull sẽ retry và lần sau skip nhờ CONFIRMED check.

  const leaseOwner = randomUUID();
  const claimedRecord = await claimImpactSbtForSubmission(mintRequestId, {
    attemptNumber,
    leaseOwner,
    leaseExpiresAt: new Date(Date.now() + SBT_SUBMISSION_LEASE_MS)
  });
  if (!claimedRecord) {
    const latestRecord = await findImpactSbtMetadataByMintRequestId(mintRequestId);
    if (latestRecord?.status === 'CONFIRMED' && latestRecord.onChainTokenId !== null) {
      return {
        onChainTokenId: latestRecord.onChainTokenId,
        transactionHash: latestRecord.transactionHash,
        blockNumber: latestRecord.blockNumber,
        status: 'CONFIRMED'
      };
    }
    // Worker khác đang giữ lease hoặc đã broadcast; tuyệt đối không gọi mint() lần hai.
    return {
      onChainTokenId: null,
      transactionHash: latestRecord?.transactionHash ?? null,
      blockNumber: latestRecord?.blockNumber ?? null,
      status: 'SUBMITTED'
    };
  }

  const contract = getWritableContract();
  const provider = getReadOnlyImpactSbtProvider();
  const signerAddress = getImpactSbtMintSignerAddress();
  const chainPendingNonce = await provider.getTransactionCount(signerAddress, 'pending');
  const transactionNonce = await reserveNextSbtMintNonce(signerAddress, chainPendingNonce);
  const nonceReservation = await reserveImpactSbtSubmissionNonce(
    mintRequestId,
    leaseOwner,
    transactionNonce
  );
  if (!nonceReservation) {
    throw new SbtSubmissionPersistenceError(
      `Không ghi được nonce reservation cho mintRequestId=${mintRequestId}; dừng để reconciler xử lý.`
    );
  }

  // Ghi chú logic phức tạp: bước gọi contract có thể fail vì nhiều lý do:
  // - gas estimation fail (contract paused, thiếu ORACLE_ROLE)
  // - RPC timeout, network issue
  // - revert (EmptyTokenURI, InvalidAddress khi address=0)
  // Tất cả đều throw — worker sẽ dựa vào attemptNumber để quyết định retry hay DLQ.
  logger.info('Bắt đầu gọi mint() on-chain.', {
    mintRequestId,
    sbtId: record.sbtId,
    beneficiaryAddress: record.beneficiaryAddress,
    projectIdNumeric: record.projectIdNumeric,
    milestone: record.milestone,
    imageCid: record.imageCid,
    attemptNumber
  });

  // Estimate gas trước khi gửi tx để set gas limit phù hợp
  const estimatedGas = await contract.mint.estimateGas(
    record.beneficiaryAddress,
    record.projectIdNumeric,
    record.milestone,
    record.beneficiaryCount,
    record.gpsCoordinates,
    record.imageCid,
    record.tokenUri
  );
  // Giới hạn gas ở mức 3x estimated + buffer cố định để tránh runaway trong trường hợp contract upgraded
  // [I-A3] Hard cap 500_000 gas để tránh accidentally burn gas khi contract bị buggy
  const GAS_LIMIT_MULTIPLIER = 3n;
  const MAX_GAS_LIMIT = BigInt(500_000);
  const gasLimit = minBigInt((BigInt(estimatedGas) * GAS_LIMIT_MULTIPLIER) + BigInt(100_000), MAX_GAS_LIMIT);

  const txResponse = await contract.mint(
    record.beneficiaryAddress,
    record.projectIdNumeric,
    record.milestone,
    record.beneficiaryCount,
    record.gpsCoordinates,
    record.imageCid,
    record.tokenUri,
    { gasLimit, nonce: transactionNonce }
  );

  // ethers v6 ContractFunction trả về transaction response với .hash + .wait()
  const txHash = txResponse.hash as string;
  const submittedAt = new Date();

  // [I-A4] Anti-tampering: kiểm tra submittedAt không phải future date
  validateSubmittedAtNotFuture(submittedAt);

  // Cập nhật SUBMITTED trước khi chờ receipt — an toàn nếu worker crash sau bước này
  const submittedRecord = await markImpactSbtAsSubmitted(mintRequestId, {
    transactionHash: txHash,
    transactionNonce,
    attemptNumber,
    submittedAt,
    leaseOwner
  });
  if (!submittedRecord) {
    throw new SbtSubmissionPersistenceError(
      `Không ghi được tx hash sau broadcast cho mintRequestId=${mintRequestId}; dừng retry để tránh double-mint.`
    );
  }

  logger.info('Đã submit tx mint SBT — đang chờ confirm.', {
    mintRequestId,
    sbtId: record.sbtId,
    transactionHash: txHash,
    attemptNumber
  });

  // [I-A4] Dùng SBT_MINT_CONFIRMATION_BLOCKS từ env (default 2) cho giao dịch tài chính
  const receipt = await waitForReceiptWithTimeout(txResponse, SBT_MINT_CONFIRMATION_BLOCKS);

  if (!receipt) {
    logger.warn('Tx mint SBT chưa có receipt trong timeout; reconciler sẽ tiếp tục theo dõi.', {
      mintRequestId,
      transactionHash: txHash,
      timeoutMs: SBT_MINT_RECEIPT_WAIT_TIMEOUT_MS
    });
    return {
      onChainTokenId: null,
      transactionHash: txHash,
      blockNumber: null,
      status: 'SUBMITTED'
    };
  }

  recordBlockchainTransaction({
    operation: 'mint_sbt',
    receipt,
    startedAtMs: submittedAt.getTime()
  });

  if (receipt.status !== 1) {
    // Tx đã được mine nhưng revert
    throw new Error(`Tx mint SBT revert on-chain (hash=${txHash}, status=${receipt.status}).`);
  }

  // Parse SBTMinted event từ receipt logs để lấy tokenId chính xác
  const onChainTokenId = parseSbtMintedTokenId(receipt.logs, record.sbtId);
  const blockNumber = receipt.blockNumber;
  const confirmedAt = new Date();

  const confirmedRecord = await markImpactSbtAsConfirmed(mintRequestId, {
    onChainTokenId,
    blockNumber,
    confirmedAt
  });

  // Mint CONFIRMED thay đổi total gallery; cache được invalidate theo project và toàn cục.
  try {
    await invalidateSbtGalleryTotalCache(record.projectId);
  } catch (error) {
    logger.warn('Invalidate total gallery SBT tháº¥t báº¡i sau khi mint confirm.', {
      mintRequestId,
      errorMessage: sanitizeProviderError(error) ?? 'UNKNOWN_ERROR'
    });
  }

  if (!confirmedRecord) {
    const latestRecord = await findImpactSbtMetadataByMintRequestId(mintRequestId);
    if (latestRecord?.status === 'CONFIRMED') {
      return {
        onChainTokenId: latestRecord.onChainTokenId,
        transactionHash: latestRecord.transactionHash,
        blockNumber: latestRecord.blockNumber,
        status: 'CONFIRMED'
      };
    }
    throw new SbtSubmissionPersistenceError(
      `Không ghi được confirmation cho mintRequestId=${mintRequestId}; reconciler sẽ retry reconcile.`
    );
  }

  // Chỉ phát event sau khi trạng thái CONFIRMED đã được ghi bền vững, tránh thông báo mint thành công giả.
  const eventPayload: SbtMintedEventPayload = {
    sbtId: record.sbtId,
    mintRequestId,
    projectId: record.projectId,
    organizationId: record.organizationId,
    beneficiaryAddress: record.beneficiaryAddress,
    onChainTokenId,
    transactionHash: txHash,
    blockNumber,
    imageCid: record.imageCid,
    tokenUri: record.tokenUri,
    milestone: record.milestone,
    beneficiaryCount: record.beneficiaryCount,
    mintedAt: confirmedAt
  };
  sbtEvents.emit('sbt.minted', eventPayload);
  eventLoggerService.logEvent({
    eventType: 'SBT_MINTED',
    projectId: eventPayload.projectId,
    organizationId: eventPayload.organizationId,
    walletAddress: eventPayload.beneficiaryAddress,
    timestamp: eventPayload.mintedAt,
    payload: {
      tokenId: eventPayload.onChainTokenId,
      milestone: eventPayload.milestone,
      beneficiaryCount: eventPayload.beneficiaryCount,
      sbtId: eventPayload.sbtId,
      transactionHash: eventPayload.transactionHash
    }
  });

  // Fire-and-forget: kiểm tra DLQ sau khi mint confirm mà không block response.
  // Nếu DLQ check fail, cron job 15 phút sẽ cover.
  setImmediate(() => {
    checkSbtMintDlqStatus(mintRequestId).catch((error: unknown) => logger.warn('DLQ status check thất bại sau mint.', {
      mintRequestId,
      errorMessage: sanitizeProviderError(error) ?? 'UNKNOWN_ERROR'
    }));
  });

  logger.info('Mint SBT thành công.', {
    mintRequestId,
    sbtId: record.sbtId,
    onChainTokenId,
    transactionHash: txHash,
    blockNumber,
    attemptNumber
  });

  return {
    onChainTokenId,
    transactionHash: txHash,
    blockNumber,
    status: 'CONFIRMED'
  };
}

/**
 * Anti-tampering: kiểm tra submittedAt không phải future date.
 * Clock drift hoặc malicious tampering có thể đặt submittedAt vào tương lai.
 * Nếu phát hiện → throw để worker không bị mislead bởi stuck transaction check.
 */
function validateSubmittedAtNotFuture(submittedAt: Date): void {
  const now = Date.now();
  const submittedMs = submittedAt.getTime();
  // Cho phép drift tối đa 30 giây (để cover RPC node clock drift)
  const DRIFT_TOLERANCE_MS = 30_000;
  if (submittedMs > now + DRIFT_TOLERANCE_MS) {
    throw new Error(`submittedAt nằm trong tương lai (drift=${submittedMs - now}ms) — có thể bị tampering.`);
  }
}

/**
 * Parse SBTMinted event từ receipt logs để lấy tokenId on-chain.
 * Mục đích: contract ImpactSBT emit SBTMinted(to, tokenId, tokenURI_) trong mint().
 * tokenId được assign bởi contract (_sbtIdCounter++), nên phải parse từ event
 * thay vì tin tưởng vào return value (ethers v6 vẫn decode được return value,
 * nhưng parse event là canonical và đáng tin cậy hơn cho audit).
 *
 * Export để test được — Production code chỉ gọi qua executeSbtMint.
 */
export function parseSbtMintedTokenId(logs: readonly ethers.Log[], sbtIdForLog: string): number {
  for (const logEntry of logs) {
    try {
      const parsed = SBT_MINTED_EVENT_IFACE.parseLog(logEntry);
      if (parsed && parsed.name === 'SBTMinted') {
        // tokenId là arg[1] theo thứ tự: to, tokenId, tokenURI_
        const tokenIdBigInt = parsed.args[1] as bigint;
        const tokenId = Number(tokenIdBigInt);
        if (Number.isSafeInteger(tokenId) && tokenId >= 0) {
          return tokenId;
        }
        logger.warn('SBTMinted event có tokenId không hợp lệ — fallback về 0.', {
          sbtId: sbtIdForLog,
          tokenIdRaw: tokenIdBigInt.toString()
        });
        return 0;
      }
    } catch {
      // log không phải SBTMinted → skip
    }
  }

  // Không tìm thấy event — throw để worker biết tx có vấn đề
  throw new Error(`Không tìm thấy SBTMinted event trong receipt logs (sbtId=${sbtIdForLog}).`);
}

// ============================================================
// SECTION 3: Mint Failure & Retry (handleSbtMintFailure)
// ============================================================

/**
 * Hàm xử lý khi attempt mint thất bại.
 * Mục đích: quyết định retry (re-enqueue với delay backoff) hay chuyển DLQ.
 *
 * - attemptNumber < SBT_MINT_MAX_ATTEMPTS → re-enqueue với delay từ SBT_MINT_RETRY_DELAYS_MS
 * - attemptNumber >= SBT_MINT_MAX_ATTEMPTS → chuyển DLQ + emit sbt.mint-dlq event
 */
export async function handleSbtMintFailure(
  mintRequestId: string,
  attemptNumber: number,
  errorMessage: string
): Promise<{ willRetry: boolean; movedToDlq: boolean; nextDelayMs: number | null }> {
  const safeErrorMessage = sanitizeProviderError(errorMessage) ?? 'UNKNOWN_ERROR';
  const record = await findImpactSbtMetadataByMintRequestId(mintRequestId);
  if (!record) {
    logger.warn('handleSbtMintFailure: không tìm thấy record, bỏ qua.', { mintRequestId });
    return { willRetry: false, movedToDlq: false, nextDelayMs: null };
  }

  // Atomic transition là barrier chống hai reconciler cùng phát retry/event cho một failure.
  const failedRecord = await markImpactSbtAsFailed(mintRequestId, {
    attemptNumber,
    errorMessage: safeErrorMessage
  });
  if (!failedRecord) {
    logger.info('SBT mint failure đã được xử lý bởi worker/reconciler khác — bỏ qua side effect trùng.', {
      mintRequestId,
      attemptNumber
    });
    return { willRetry: false, movedToDlq: false, nextDelayMs: null };
  }

  // Emit sbt.mint-failed event cho notification service (không bắt buộc — chỉ alert nếu nhiều fail liên tiếp)
  sbtEvents.emit('sbt.mint-failed', {
    sbtId: record.sbtId,
    mintRequestId,
    projectId: record.projectId,
    organizationId: record.organizationId,
    attemptNumber,
    errorMessage: safeErrorMessage,
    failedAt: new Date()
  } satisfies SbtMintFailedEventPayload);
  eventLoggerService.logEvent({
    eventType: 'SBT_MINT_FAILED',
    projectId: record.projectId,
    organizationId: record.organizationId,
    walletAddress: record.beneficiaryAddress,
    timestamp: new Date(),
    payload: { sbtId: record.sbtId, mintRequestId, attemptNumber, errorMessage: safeErrorMessage }
  });

  // Nếu đã hết retry → DLQ
  if (attemptNumber >= SBT_MINT_MAX_ATTEMPTS) {
    const dlqAt = new Date();
    const firstAttemptedAt = record.createdAt;

    const dlqRecord = await markImpactSbtAsDlq(mintRequestId, {
      dlqAt,
      errorMessage: safeErrorMessage,
      attemptNumber
    });
    if (!dlqRecord) {
      logger.info('SBT mint DLQ transition đã được xử lý bởi worker/reconciler khác — bỏ qua side effect trùng.', {
        mintRequestId,
        attemptNumber
      });
      return { willRetry: false, movedToDlq: false, nextDelayMs: null };
    }

    const dlqEntry = await createSbtMintDlqEntry({
      dlqId: `DLQ-${randomUUID()}`,
      mintRequestId,
      sbtId: record.sbtId,
      projectId: record.projectId,
      organizationId: record.organizationId,
      beneficiaryAddress: record.beneficiaryAddress,
      attemptNumber,
      lastErrorMessage: safeErrorMessage,
      firstAttemptedAt,
      dlqAt
    });
    if ((failedRecord.reRunCount ?? record.reRunCount ?? 0) > 0) {
      await markSbtMintDlqRerunFailed(mintRequestId, {
        failedAt: dlqAt,
        errorMessage: safeErrorMessage
      });
    }

    sbtEvents.emit('sbt.mint-dlq', {
      sbtId: record.sbtId,
      mintRequestId,
      projectId: record.projectId,
      organizationId: record.organizationId,
      beneficiaryAddress: record.beneficiaryAddress,
      attemptNumber,
      lastErrorMessage: safeErrorMessage,
      dlqAt
    } satisfies SbtMintDlqEventPayload);
    eventLoggerService.logEvent({
      eventType: 'SBT_MINT_DLQ',
      projectId: record.projectId,
      organizationId: record.organizationId,
      walletAddress: record.beneficiaryAddress,
      timestamp: dlqAt,
      payload: {
        sbtId: record.sbtId,
        mintRequestId,
        attemptNumber,
        lastErrorMessage: safeErrorMessage
      }
    });

    logger.error('SBT mint đã hết retry — chuyển DLQ.', {
      mintRequestId,
      sbtId: record.sbtId,
      attemptNumber,
      dlqEntryCreated: dlqEntry !== null,
      errorMessage: safeErrorMessage
    });

    return { willRetry: false, movedToDlq: true, nextDelayMs: null };
  }

  // Còn retry → re-enqueue với delay backoff
  const nextAttempt = attemptNumber + 1;
  const delayIndex = attemptNumber - 1; // attemptNumber 1-indexed, delayIndex 0-indexed
  // Fallback: nếu delayIndex vượt array (do data corruption hoặc race), dùng max delay thay vì throw
  // Đây là safety net — trong điều kiện bình thường, logic đã được kiểm soát ở các check trên
  const nextDelayMs = SBT_MINT_RETRY_DELAYS_MS[delayIndex] ?? SBT_MINT_RETRY_DELAYS_MS[SBT_MINT_RETRY_DELAYS_MS.length - 1];

  // Xóa các pending job cũ trước khi enqueue mới (tránh duplicate retry job)
  await removePendingSbtMintJobsByRequestId(mintRequestId);

  const enqueueResult = await enqueueSbtMint(
    {
      mintRequestId,
      sbtId: record.sbtId,
      attemptNumber: nextAttempt,
      enqueuedBy: 'worker_retry' // Worker self-trigger khi executeSbtMint fail và còn retry budget
    },
    { delay: nextDelayMs }
  );

  logger.warn('SBT mint attempt thất bại — đã schedule retry.', {
    mintRequestId,
    sbtId: record.sbtId,
    attemptNumber,
    nextAttempt,
    nextDelayMs,
    enqueued: enqueueResult.enqueued,
    errorMessage
  });

  return { willRetry: true, movedToDlq: false, nextDelayMs };
}

// ============================================================
// SECTION 4: Mint Rerun (rerunSbtMintJob)
// ============================================================

/**
 * Hàm trigger re-run job từ admin UI (POST /api/sbt/retry-job/:mintRequestId).
 *
 * Ràng buộc:
 * - Chỉ re-run được khi status = DLQ hoặc FAILED (không cho re-run khi đang pending)
 * - Reset attemptNumber = 0 và re-enqueue attempt đầu tiên
 * - Tăng reRunCount để audit
 * - KHÔNG BAO GIỜ cho mint tay (Q4 decision) — chỉ reset và re-enqueue
 */
export async function rerunSbtMintJob(
  mintRequestId: string,
  adminUserId: string,
  auditRequestContext?: AuditRequestContext
): Promise<{ record: ImpactSbtMetadataRecord; jobId: string | number | undefined; enqueued: boolean }> {
  const record = await findImpactSbtMetadataByMintRequestId(mintRequestId);
  if (!record) {
    throw new ApplicationError(`Không tìm thấy mint request: ${mintRequestId}`, 404, 'NOT_FOUND');
  }

  if (record.status === 'CONFIRMED') {
    throw new ApplicationError(
      `Mint request đã CONFIRMED, không thể re-run: ${mintRequestId}`,
      409,
      'INVALID_STATUS_TRANSITION'
    );
  }

  if (record.status === 'SUBMITTED') {
    throw new ApplicationError(
      `Mint request đang SUBMITTED (tx chưa confirm) — chờ receipt trước khi re-run.`,
      409,
      'INVALID_STATUS_TRANSITION'
    );
  }

  // PENDING / FAILED / DLQ: luôn check pending job để tránh enqueue duplicate
  const pendingCount = await countPendingSbtMintJobsByRequestId(mintRequestId);
  if (pendingCount > 0) {
    throw new ApplicationError(
      `Mint request đang có ${pendingCount} job chờ xử lý — không cần re-run.`,
      409,
      'CONFLICT'
    );
  }

  const reRunAt = new Date();
  const nextReRunCount = (record.reRunCount ?? 0) + 1;
  const outboxEventId = `sbt-rerun-dispatch:${mintRequestId}:${nextReRunCount}`;
  const updatedRecord = await runMongoTransaction(async (session) => {
    const resetInput = { reRunBy: adminUserId, reRunAt };
    const updated = session
      ? await resetImpactSbtForReRun(mintRequestId, resetInput, session)
      : await resetImpactSbtForReRun(mintRequestId, resetInput);

    if (!updated) {
      throw new ApplicationError(
      'Không thể reset mint request (có thể đã chuyển CONFIRMED).',
      409,
      'CONFLICT'
      );
    }

    if (record.status === 'DLQ') {
      await markSbtMintDlqRerunStarted(mintRequestId, { startedAt: reRunAt }, session);
    }

    await recordAdminAuditLog({
      actionId: `sbt-rerun-requested:${mintRequestId}:${updated.reRunCount ?? nextReRunCount}`,
      actorType: 'ADMIN',
      adminId: adminUserId,
      adminRole: 'admin',
      actionType: 'SBT_MINT_RERUN_REQUESTED',
      targetId: mintRequestId,
      targetType: 'SBT_MINT_REQUEST',
      requestContext: auditRequestContext,
      context: {
        mintRequestId,
        sbtId: updated.sbtId,
        previousStatus: record.status,
        previousAttemptNumber: record.attemptNumber,
        reRunCount: updated.reRunCount ?? nextReRunCount,
        enqueueResult: 'REQUESTED'
      },
      session
    });
    await createAdminActionOutbox({
      eventId: outboxEventId,
      eventType: 'SBT_MINT_RERUN',
      payload: {
        mintRequestId,
        sbtId: updated.sbtId,
        attemptNumber: 1,
        adminId: adminUserId,
        adminRole: 'admin',
        previousStatus: record.status,
        previousAttemptNumber: record.attemptNumber,
        reRunCount: updated.reRunCount ?? nextReRunCount,
        requestContext: auditRequestContext ?? null
      }
    }, session);
    return updated;
  });

  // Consumer có thể dispatch ngay sau commit; nếu queue lỗi, outbox giữ PENDING để retry và ghi ENQUEUED khi thành công.
  const enqueueResult = await runAdminActionOutboxOnce(outboxEventId).then(dispatched => ({
    jobId: dispatched > 0 ? `${mintRequestId}-attempt1` : undefined,
    enqueued: dispatched > 0
  }));

  if (!enqueueResult.enqueued && record.status === 'DLQ') {
    await markSbtMintDlqRerunFailed(mintRequestId, {
      failedAt: new Date(),
      errorMessage: 'Không dispatch được admin rerun job vào durable queue.'
    });
  }

  logger.info('Admin re-run SBT mint job.', {
    mintRequestId,
    sbtId: updatedRecord.sbtId,
    reRunBy: adminUserId,
    reRunAt: reRunAt.toISOString(),
    previousAttemptNumber: record.attemptNumber,
    enqueued: enqueueResult.enqueued,
    jobId: enqueueResult.jobId
  });

  return { record: updatedRecord, jobId: enqueueResult.jobId, enqueued: enqueueResult.enqueued };
}

/** Reconcile receipt của SUBMITTED record; không broadcast transaction mới trong mọi nhánh. */
export async function reconcileSubmittedSbtMint(
  mintRequestId: string
): Promise<'PENDING' | 'CONFIRMED' | 'FAILED' | 'UNKNOWN'> {
  const record = await findImpactSbtMetadataByMintRequestId(mintRequestId);
  if (!record || record.status === 'CONFIRMED') return 'CONFIRMED';
  if (record.status !== 'SUBMITTED' || !record.transactionHash) return 'UNKNOWN';

  const provider = getReadOnlyImpactSbtProvider();
  const receipt = await provider.getTransactionReceipt(record.transactionHash);
  if (!receipt) return 'PENDING';

  if (receipt.status !== 1) {
    await handleSbtMintFailure(
      mintRequestId,
      record.attemptNumber,
      `Tx mint SBT revert on-chain (hash=${record.transactionHash}, status=${receipt.status}).`
    );
    return 'FAILED';
  }

  const onChainTokenId = parseSbtMintedTokenId(receipt.logs, record.sbtId);
  const confirmed = await markImpactSbtAsConfirmed(mintRequestId, {
    onChainTokenId,
    blockNumber: receipt.blockNumber,
    confirmedAt: new Date()
  });
  if (!confirmed) {
    const latest = await findImpactSbtMetadataByMintRequestId(mintRequestId);
    return latest?.status === 'CONFIRMED' ? 'CONFIRMED' : 'UNKNOWN';
  }

  try {
    await invalidateSbtGalleryTotalCache(record.projectId);
  } catch (error) {
    logger.warn('Invalidate total gallery SBT thất bại trong reconcile.', {
      mintRequestId,
      errorMessage: sanitizeProviderError(error) ?? 'UNKNOWN_ERROR'
    });
  }

  const eventPayload: SbtMintedEventPayload = {
    sbtId: record.sbtId,
    mintRequestId,
    projectId: record.projectId,
    organizationId: record.organizationId,
    beneficiaryAddress: record.beneficiaryAddress,
    onChainTokenId,
    transactionHash: record.transactionHash,
    blockNumber: receipt.blockNumber,
    imageCid: record.imageCid,
    tokenUri: record.tokenUri,
    milestone: record.milestone,
    beneficiaryCount: record.beneficiaryCount,
    mintedAt: new Date()
  };
  sbtEvents.emit('sbt.minted', eventPayload);
  eventLoggerService.logEvent({
    eventType: 'SBT_MINTED',
    projectId: eventPayload.projectId,
    organizationId: eventPayload.organizationId,
    walletAddress: eventPayload.beneficiaryAddress,
    timestamp: eventPayload.mintedAt,
    payload: {
      tokenId: eventPayload.onChainTokenId,
      milestone: eventPayload.milestone,
      beneficiaryCount: eventPayload.beneficiaryCount,
      sbtId: eventPayload.sbtId,
      transactionHash: eventPayload.transactionHash
    }
  });
  return 'CONFIRMED';
}

// ============================================================
// SECTION 5: Mint Recovery (recoverStuckSbtMints)
// ============================================================

/**
 * Hàm recovery bởi cron 15 phút — tìm record PENDING/FAILED/SUBMITTED quá lâu chưa có job.
 * Mục đích: an toàn khi:
 * - Redis restart mất queue → re-enqueue
 * - Worker crash giữa chừng → re-enqueue
 * - Tx SUBMITTED quá lâu → reconcile receipt; không tự đánh dấu FAILED chỉ vì timeout
 */
export async function recoverStuckSbtMints(olderThanMinutes: number = 15): Promise<{ recovered: number; enqueued: number }> {
  const candidates = await findImpactSbtNeedingRecovery(olderThanMinutes, 50);

  if (candidates.length === 0) {
    return { recovered: 0, enqueued: 0 };
  }

  let enqueuedCount = 0;
  for (let record of candidates) {
    if (record.status === 'SUBMITTED') {
      // Receipt chưa có không đồng nghĩa tx thất bại; giữ SUBMITTED để tránh double-mint.
      await reconcileSubmittedSbtMint(record.mintRequestId);
      continue;
    }

    // SUBMITTING không có tx hash vẫn là trạng thái không chắc chắn sau crash; tuyệt đối không broadcast nonce khác.
    if (record.status === 'SUBMITTING') {
      const leaseExpired = record.submissionLeaseExpiresAt instanceof Date
        && record.submissionLeaseExpiresAt.getTime() <= Date.now();
      const hasReservedNonce = record.transactionNonce !== null && record.transactionNonce !== undefined;
      const hasTransactionHash = Boolean(record.transactionHash);

      if (!leaseExpired || hasReservedNonce || hasTransactionHash) {
      logger.warn('SBT mint đang SUBMITTING nhưng chưa có tx hash; giữ nguyên để operator/reconciler xử lý.', {
        mintRequestId: record.mintRequestId,
        sbtId: record.sbtId,
        transactionNonce: record.transactionNonce ?? undefined,
        submissionLeaseExpiresAt: record.submissionLeaseExpiresAt?.toISOString()
      });
      continue;
      }

      const releasedRecord = await releaseExpiredSbtSubmissionWithoutNonce(
        record.mintRequestId,
        'Submission lease expired before nonce reservation.'
      );
      if (!releasedRecord) {
        continue;
      }
      record = releasedRecord;
    }

    // [I5 fix] Guard: nếu record đã đạt MAX_ATTEMPTS thì KHÔNG re-enqueue.
    // Nếu vẫn ở status FAILED (không phải DLQ) thì recovery nên moveToDLQ thay vì retry thêm.
    if (record.attemptNumber >= SBT_MINT_MAX_ATTEMPTS) {
      logger.warn('Record đã đạt MAX_ATTEMPTS — bỏ qua recovery, đã/đang chuyển DLQ ở cycle trước.', {
        mintRequestId: record.mintRequestId,
        sbtId: record.sbtId,
        status: record.status,
        attemptNumber: record.attemptNumber
      });
      continue;
    }

    const jobCount = await countPendingSbtMintJobsByRequestId(record.mintRequestId);
    if (jobCount > 0) continue;

    // Enqueue retry với attemptNumber = current + 1, bounded không vượt MAX
    // [S1 fix] Nếu current = 5 → nextAttempt = 6 (hợp lệ)
    // Nếu current = 6 → skip ở check ở trên rồi (attemptNumber >= MAX_ATTEMPTS)
    // Nhưng guard thêm ở đây để tránh overflow nếu logic thay đổi
    const nextAttempt = Math.min(record.attemptNumber + 1, SBT_MINT_MAX_ATTEMPTS);
    const enqueueResult = await enqueueSbtMint(
      {
        mintRequestId: record.mintRequestId,
        sbtId: record.sbtId,
        attemptNumber: nextAttempt,
        enqueuedBy: 'cron_recovery'
      },
      { delay: 0 } // Chạy ngay
    );

    if (enqueueResult.enqueued) {
      enqueuedCount += 1;
    }
  }

  logger.info('SBT mint cron recovery hoàn tất.', {
    candidatesFound: candidates.length,
    enqueued: enqueuedCount > 0,
    olderThanMinutes: olderThanMinutes
  });

  return { recovered: candidates.length, enqueued: enqueuedCount };
}
