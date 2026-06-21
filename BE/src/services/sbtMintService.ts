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
import { getLogger } from '../config/logger';
import { ApplicationError } from '../utils/applicationError';
import { extractErrorMessage } from '../utils/extractErrorMessage';

// Re-export để giữ backward compatibility cho tests và các module đang import
export { extractErrorMessage };
import {
  createImpactSbtMetadata,
  findImpactSbtMetadataByMintRequestId,
  markImpactSbtAsSubmitted,
  markImpactSbtAsConfirmed,
  markImpactSbtAsFailed,
  markImpactSbtAsDlq,
  resetImpactSbtForReRun,
  type ImpactSbtMetadataRecord
} from '../models/impactSbtMetadataModel';
import {
  createSbtMintDlqEntry,
  markSbtMintDlqAsRecovered,
  findSbtMintDlqByMintRequestId
} from '../models/sbtMintDlqModel';
import { getWritableImpactSbtContract } from '../config/sbtContract';
import {
  sbtEvents,
  type SbtMintedEventPayload,
  type SbtMintFailedEventPayload,
  type SbtMintDlqEventPayload
} from '../events/sbtEvents';
import {
  enqueueSbtMint,
  countPendingSbtMintJobsByRequestId,
  getSbtMintJobIndexByRequestId,
  removePendingSbtMintJobsByRequestId,
  SBT_MINT_RETRY_DELAYS_MS,
  SBT_MINT_MAX_ATTEMPTS,
  SBT_MINT_STUCK_TX_THRESHOLD_MS
} from '../queues/sbtMintQueue';
import { findImpactSbtNeedingRecovery } from '../models/impactSbtMetadataModel';

/**
 * Environment variable cho số block confirmations khi chờ mint transaction.
 * Giá trị mặc định: 2 confirmations (khoảng 12 giây trên Autonomys Network).
 * Tăng lên nếu cần security cao hơn cho transaction tài chính.
 */
const SBT_MINT_CONFIRMATION_BLOCKS = parseInt(process.env.SBT_MINT_CONFIRMATION_BLOCKS ?? '2', 10);
if (SBT_MINT_CONFIRMATION_BLOCKS < 1) {
  throw new Error('SBT_MINT_CONFIRMATION_BLOCKS phải >= 1.');
}

const logger = getLogger();

// Cache ethers.Interface cho SBTMinted event — tránh tạo mới mỗi lần parse logs.
// Hot path: chạy cho mỗi attempt mint, nên cache là critical cho performance.
const SBT_MINTED_EVENT_IFACE = new ethers.Interface([
  'event SBTMinted(address indexed to, uint256 indexed tokenId, string tokenURI_)'
]);

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
    // Duplicate — trả về existing record mà không enqueue
    logger.info('SBT mint request đã tồn tại cho verification này — bỏ qua duplicate (atomic upsert).', {
      mintRequestId: record.mintRequestId,
      sbtId: record.sbtId,
      verificationId: input.verificationId,
      status: record.status
    });
    return {
      record,
      jobId: undefined,
      enqueued: false,
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

  const contract = getWritableContract();

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
    { gasLimit }
  );

  // ethers v6 ContractFunction trả về transaction response với .hash + .wait()
  const txHash = txResponse.hash as string;
  const submittedAt = new Date();

  // [I-A4] Anti-tampering: kiểm tra submittedAt không phải future date
  validateSubmittedAtNotFuture(submittedAt);

  // Cập nhật SUBMITTED trước khi chờ receipt — an toàn nếu worker crash sau bước này
  await markImpactSbtAsSubmitted(mintRequestId, {
    transactionHash: txHash,
    attemptNumber,
    submittedAt
  });

  logger.info('Đã submit tx mint SBT — đang chờ confirm.', {
    mintRequestId,
    sbtId: record.sbtId,
    transactionHash: txHash,
    attemptNumber
  });

  // [I-A4] Dùng SBT_MINT_CONFIRMATION_BLOCKS từ env (default 2) cho giao dịch tài chính
  const receipt = await txResponse.wait(SBT_MINT_CONFIRMATION_BLOCKS);

  if (!receipt) {
    throw new Error(`Không nhận được receipt cho tx mint SBT (hash=${txHash}).`);
  }

  if (receipt.status !== 1) {
    // Tx đã được mine nhưng revert
    throw new Error(`Tx mint SBT revert on-chain (hash=${txHash}, status=${receipt.status}).`);
  }

  // Parse SBTMinted event từ receipt logs để lấy tokenId chính xác
  const onChainTokenId = parseSbtMintedTokenId(receipt.logs, record.sbtId);
  const blockNumber = receipt.blockNumber;
  const confirmedAt = new Date();

  await markImpactSbtAsConfirmed(mintRequestId, {
    onChainTokenId,
    blockNumber,
    confirmedAt
  });

  // DLQ status check được thực hiện fire-and-forget bên dưới sau khi emit event

  // Emit sbt.minted event để socket + notification forward
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
    mintedAt: confirmedAt
  };
  sbtEvents.emit('sbt.minted', eventPayload);

  // Fire-and-forget: kiểm tra DLQ sau khi mint confirm mà không block response.
  // Nếu DLQ check fail, cron job 15 phút sẽ cover.
  setImmediate(() => {
    checkSbtMintDlqStatus(mintRequestId).catch((e: Error) => logger.warn('DLQ status check thất bại sau mint.', { mintRequestId, errorMessage: e.message }));
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
  const record = await findImpactSbtMetadataByMintRequestId(mintRequestId);
  if (!record) {
    logger.warn('handleSbtMintFailure: không tìm thấy record, bỏ qua.', { mintRequestId });
    return { willRetry: false, movedToDlq: false, nextDelayMs: null };
  }

  // Đánh dấu FAILED trong DB
  await markImpactSbtAsFailed(mintRequestId, {
    attemptNumber,
    errorMessage
  });

  // Emit sbt.mint-failed event cho notification service (không bắt buộc — chỉ alert nếu nhiều fail liên tiếp)
  sbtEvents.emit('sbt.mint-failed', {
    sbtId: record.sbtId,
    mintRequestId,
    projectId: record.projectId,
    organizationId: record.organizationId,
    attemptNumber,
    errorMessage,
    failedAt: new Date()
  } satisfies SbtMintFailedEventPayload);

  // Nếu đã hết retry → DLQ
  if (attemptNumber >= SBT_MINT_MAX_ATTEMPTS) {
    const dlqAt = new Date();
    const firstAttemptedAt = record.createdAt;

    await markImpactSbtAsDlq(mintRequestId, {
      dlqAt,
      errorMessage,
      attemptNumber
    });

    const dlqEntry = await createSbtMintDlqEntry({
      dlqId: `DLQ-${randomUUID()}`,
      mintRequestId,
      sbtId: record.sbtId,
      projectId: record.projectId,
      organizationId: record.organizationId,
      beneficiaryAddress: record.beneficiaryAddress,
      attemptNumber,
      lastErrorMessage: errorMessage,
      firstAttemptedAt,
      dlqAt
    });

    sbtEvents.emit('sbt.mint-dlq', {
      sbtId: record.sbtId,
      mintRequestId,
      projectId: record.projectId,
      organizationId: record.organizationId,
      beneficiaryAddress: record.beneficiaryAddress,
      attemptNumber,
      lastErrorMessage: errorMessage,
      dlqAt
    } satisfies SbtMintDlqEventPayload);

    logger.error('SBT mint đã hết retry — chuyển DLQ.', {
      mintRequestId,
      sbtId: record.sbtId,
      attemptNumber,
      dlqEntryCreated: dlqEntry !== null,
      errorMessage
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
  adminUserId: string
): Promise<{ record: ImpactSbtMetadataRecord; jobId: string | number | undefined; enqueued: boolean }> {
  const record = await findImpactSbtMetadataByMintRequestId(mintRequestId);
  if (!record) {
    throw new Error(`Không tìm thấy mint request: ${mintRequestId}`);
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
  const updatedRecord = await resetImpactSbtForReRun(mintRequestId, {
    reRunBy: adminUserId,
    reRunAt
  });

  if (!updatedRecord) {
    throw new Error(`Không thể reset mint request (có thể đã chuyển CONFIRMED).`);
  }

  // Xóa pending jobs cũ trước khi enqueue mới — tránh duplicate retry job
  const removedCount = await removePendingSbtMintJobsByRequestId(mintRequestId);
  logger.info('Đã xóa pending jobs cũ trước khi re-run.', { mintRequestId, removedCount });

  // Enqueue attempt đầu tiên (attemptNumber = 1)
  const enqueueResult = await enqueueSbtMint(
    {
      mintRequestId,
      sbtId: updatedRecord.sbtId,
      attemptNumber: 1,
      enqueuedBy: 'admin_rerun'
    },
    { priority: 3 } // Priority cao hơn oracle_event (5 < 3)
  );

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

// ============================================================
// SECTION 5: Mint Recovery (recoverStuckSbtMints)
// ============================================================

/**
 * Hàm recovery bởi cron 15 phút — tìm record PENDING/FAILED/SUBMITTED quá lâu chưa có job.
 * Mục đích: an toàn khi:
 * - Redis restart mất queue → re-enqueue
 * - Worker crash giữa chừng → re-enqueue
 * - Tx SUBMITTED > 5 phút chưa confirm → mark FAILED để retry (transaction stuck handling)
 */
export async function recoverStuckSbtMints(olderThanMinutes: number = 15): Promise<{ recovered: number; enqueued: number }> {
  const candidates = await findImpactSbtNeedingRecovery(olderThanMinutes, 50);

  if (candidates.length === 0) {
    return { recovered: 0, enqueued: 0 };
  }

  // [I5 fix] Batch fetch tất cả jobs 1 lần duy nhất — tránh N+1 Redis calls
  const jobIndex = await getSbtMintJobIndexByRequestId();

  let enqueuedCount = 0;
  for (const record of candidates) {
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

    // [I5 fix] Tra cứu từ index đã batch-fetch thay vì gọi Redis mỗi iteration
    const jobCount = jobIndex.get(record.mintRequestId) ?? 0;
    if (jobCount > 0) {
      continue;
    }

    // Nếu SUBMITTED > SBT_MINT_STUCK_TX_THRESHOLD_MS → mark FAILED để retry path xử lý
    // Lưu ý: Date.now() vs record.submittedAt.getTime() có thể có clock drift < 1s.
    // Với cron job 15 phút, drift này chấp nhận được. Nếu cần sub-second accuracy,
    // cần truyền referenceTime từ scheduler hoặc dùng MongoDB server time.
    if (record.status === 'SUBMITTED' && record.submittedAt) {
      const stuckMs = Date.now() - record.submittedAt.getTime();
      if (stuckMs > SBT_MINT_STUCK_TX_THRESHOLD_MS) {
        await markImpactSbtAsFailed(record.mintRequestId, {
          attemptNumber: record.attemptNumber,
          errorMessage: `Tx submitted > ${SBT_MINT_STUCK_TX_THRESHOLD_MS / 60_000} phút chưa confirm (stuck ${Math.round(stuckMs / 1000)}s) — auto-fail để retry.`
        });
        logger.warn('SBT mint tx bị stuck — auto-fail để retry.', {
          mintRequestId: record.mintRequestId,
          sbtId: record.sbtId,
          stuckMintTxHash: record.transactionHash ?? undefined,
          stuckSeconds: Math.round(stuckMs / 1000)
        });
      } else {
        // Vẫn trong ngưỡng — skip, chờ thêm
        continue;
      }
    }

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
