import { Job } from 'bull';
import { z } from 'zod';
import { ethers } from 'ethers';
import { getLogger } from '../config/logger';
import {
  getSbtMintQueue,
  SBT_MINT_MAX_ATTEMPTS
} from '../queues/sbtMintQueue';
import { oracleEvents } from '../events/oracleEvents';
import { executeSbtMint, handleSbtMintFailure, createSbtMintRequest, extractErrorMessage } from '../services/sbtMintService';
import { sbtEvents, type SbtMintBlockedEventPayload } from '../events/sbtEvents';
import { createBlockedImpactSbtMetadata } from '../models/impactSbtMetadataModel';

const logger = getLogger();

/**
 * Concurrency cho SBT mint worker.
 * Thấp (1-2) vì mint là 1 transaction on-chain + chờ receipt 1 block
 * → tránh spam RPC node khi có nhiều Oracle verify cùng lúc.
 */
const SBT_MINT_WORKER_CONCURRENCY = 2;

/**
 * Build IPFS token URI dạng ipfs://{cid} từ image CID.
 * Mục đích: tạo metadata URI theo chuẩn ERC-721 token metadata extension.
 * Lưu ý: tokenURI_ trong contract yêu cầu định dạng "ipfs://" (xem ImpactSBT.sol).
 */
function buildTokenUriFromImageCid(imageCid: string): string {
  const trimmed = imageCid.trim();
  if (!trimmed) {
    throw new Error('imageCid rỗng — không thể build tokenURI.');
  }
  if (trimmed.startsWith('ipfs://')) {
    return trimmed;
  }
  return `ipfs://${trimmed}`;
}

/**
 * Tính projectIdNumeric (display only) từ projectId string.
 *
 * CẢNH BÁO: Hàm này chỉ dùng cho display/event log, KHÔNG dùng làm khóa on-chain.
 * Collision risk: với 2^53 không gian, collision xảy ra sau ~67 triệu project.
 * Contract ImpactSBT sử dụng projectId riêng qua mapping, không phụ thuộc vào giá trị này.
 *
 * Mục đích: contract ImpactSBT yêu cầu uint256. projectId trong DCP là string UUID
 * (hoặc ObjectId từ Mongo) — cần convert sang uint256. Có 2 chiến lược:
 * - Nếu projectId là số → dùng trực tiếp
 * - Nếu projectId là UUID/hash → dùng keccak256 → uint256 (deterministic)
 *
 * Ở đây dùng fallback keccak256 để đảm bảo luôn có giá trị uint256 hợp lệ,
 * giống pattern mapProviderTransactionIdToUint256 trong disbursementService.
 */
function projectIdToNumericForDisplay(projectId: string): number {
  const trimmed = projectId.trim();
  // Thử parse số trước — nếu là số thuần (1, 2, 3) thì dùng luôn
  if (/^\d+$/.test(trimmed)) {
    const num = Number(trimmed);
    if (Number.isSafeInteger(num) && num >= 0) {
      return num;
    }
  }
  // Fallback: dùng keccak256 để có giá trị uint256 deterministic từ UUID/string
  // Rồi modulo Number.MAX_SAFE_INTEGER để đảm bảo fit JS number
  // Cảnh báo: UUID projectId sẽ gây collision sau nhiều project (chỉ dùng display)
  if (trimmed.includes('-') || trimmed.length > 10) {
    logger.warn('projectIdToNumericForDisplay: projectId có vẻ là UUID — collision risk khi hiển thị.', {
      projectId: trimmed.substring(0, 8) + '...'
    });
  }
  const hashed = ethers.keccak256(ethers.toUtf8Bytes(trimmed));
  const asBigInt = BigInt(hashed);
  return Number(asBigInt % BigInt(Number.MAX_SAFE_INTEGER));
}

/**
 * TODO(C4): Tạm thời CHẶN MINT hoàn toàn vì oracle.verified event chưa kèm
 * địa chỉ ví donor. Mint SBT vào ZeroAddress sẽ khóa token vĩnh viễn trên
 * contract (vì address(0) không thể burn/recover). Chỉ revert lại mint khi
 * C4 implement lookup donor wallet từ donation record tương ứng.
 */
const PLACEHOLDER_BENEFICIARY_BLOCKED = true;

/**
 * Schema validation cho oracle.verified event payload.
 * Mục đích: đảm bảo payload có cấu trúc đúng trước khi xử lý.
 */
const OracleVerifiedEventPayloadSchema = z.object({
  verificationId: z.string().min(1),
  projectId: z.string().min(1),
  organizationId: z.string().min(1),
  evidenceCid: z.string().min(1).max(256),
  isValid: z.boolean().nullable(),
  distance: z.number().nullable(),
  reason: z.string().nullable()
});

/**
 * Lắng nghe oracle.verified event — khi isValid=true, tạo mint request.
 * Mục đích: trigger mint tự động từ signal của Oracle worker (B1).
 * Chỉ trigger khi isValid=true (đã verify GPS trong geofence).
 * Các trường hợp isValid=false/null (override flow) → KHÔNG mint tự động
 * theo scope task C2 — đợi B2 override approval (Phase 2).
 */
function attachOracleEventListener(): void {
  oracleEvents.on('oracle.verified', async (rawPayload: unknown) => {
    const parseResult = OracleVerifiedEventPayloadSchema.safeParse(rawPayload);
    if (!parseResult.success) {
      logger.error('Oracle.verified payload không hợp lệ — bỏ qua mint.', {
        errorMessage: parseResult.error.message
      });
      return;
    }
    const payload = parseResult.data;

    // Chỉ mint khi GPS verified thành công trong geofence
    if (payload.isValid !== true) {
      logger.info('Oracle.verified nhưng isValid không phải true — bỏ qua mint.', {
        verificationId: payload.verificationId,
        isValid: payload.isValid,
        reason: payload.reason ?? undefined
      });
      return;
    }

    // [I2] Chặn mint khi chưa có địa chỉ donor — tránh mint vào ZeroAddress (mất token vĩnh viễn)
    if (PLACEHOLDER_BENEFICIARY_BLOCKED) {
      logger.warn('Chặn mint SBT: chưa có địa chỉ donor trong oracle.verified event. Cần implement task C4.', {
        verificationId: payload.verificationId,
        projectId: payload.projectId,
        organizationId: payload.organizationId
      });

      // Tạo BLOCKED record để audit và alert admin
      const blockedRecord = await createBlockedImpactSbtMetadata(
        payload.verificationId,
        payload.projectId,
        payload.organizationId
      );

      // Emit sbt.mint-blocked event để socket server forward tới admin
      const eventPayload: SbtMintBlockedEventPayload = {
        mintRequestId: blockedRecord.mintRequestId,
        verificationId: payload.verificationId,
        projectId: payload.projectId,
        organizationId: payload.organizationId,
        reason: 'NO_DONOR_ADDRESS',
        blockedAt: new Date()
      };
      sbtEvents.emit('sbt.mint-blocked', eventPayload);

      return;
    }

    try {
      const mintInput = {
        verificationId: payload.verificationId,
        projectId: payload.projectId,
        organizationId: payload.organizationId,
        // TODO(C4): lookup donor wallet từ donation record tương ứng
        beneficiaryAddress: ethers.ZeroAddress,
        projectIdNumeric: projectIdToNumericForDisplay(payload.projectId),
        milestone: 0, // Default — sau này có thể map từ milestoneId trong verification
        beneficiaryCount: 1, // Default — sau này đếm từ beneficiary_feedback
        gpsCoordinates: '', // Đã verified trong geofence nhưng không cần pass vào SBT
        imageCid: payload.evidenceCid,
        tokenUri: buildTokenUriFromImageCid(payload.evidenceCid)
      };

      await createSbtMintRequest(mintInput);
    } catch (error) {
      logger.error('Lỗi khi tạo SBT mint request từ oracle.verified event.', {
        verificationId: payload.verificationId,
        projectId: payload.projectId,
        errorMessage: extractErrorMessage(error)
      });
    }
  });
}

/**
 * Processor xử lý 1 SBT mint job.
 *
 * Flow:
 * 1. Gọi executeSbtMint → gọi mint() on-chain
 * 2. Nếu thành công → trả về result
 * 3. Nếu thất bại → throw để Bull catch
 * 4. Worker catch error → gọi handleSbtMintFailure để quyết định retry/DLQ
 *
 * Pattern này tách biệt "thực thi" và "xử lý lỗi" để dễ test riêng từng phần.
 */
export async function processSbtMintJob(
  job: Job<{ mintRequestId: string; sbtId: string; attemptNumber: number; enqueuedBy: string }>
): Promise<{
  onChainTokenId: number | null;
  transactionHash: string | null;
  blockNumber: number | null;
  status: 'CONFIRMED' | 'SUBMITTED' | 'FAILED' | 'DLQ';
  attemptNumber: number;
}> {
  const { mintRequestId, attemptNumber } = job.data;
  const startTime = Date.now();

  logger.info('SBT mint job bắt đầu.', {
    mintRequestId,
    sbtId: job.data.sbtId,
    attemptNumber,
    jobId: job.id,
    enqueuedAt: job.data.enqueuedBy
  });

  try {
    const result = await executeSbtMint(mintRequestId, attemptNumber);
    const durationMs = Date.now() - startTime;
    logger.info('SBT mint job hoàn thành.', {
      mintRequestId,
      sbtId: job.data.sbtId,
      status: result.status,
      onChainTokenId: result.onChainTokenId ?? undefined,
      transactionHash: result.transactionHash ?? undefined,
      blockNumber: result.blockNumber ?? undefined,
      attemptNumber,
      durationMs
    });
    return { ...result, attemptNumber };
  } catch (error) {
    const errorMessage = extractErrorMessage(error);
    const durationMs = Date.now() - startTime;
    logger.error('SBT mint attempt thất bại — xử lý retry/DLQ.', {
      mintRequestId,
      sbtId: job.data.sbtId,
      attemptNumber,
      durationMs,
      errorMessage
    });

    // Quyết định retry hay DLQ
    const failureResult = await handleSbtMintFailure(mintRequestId, attemptNumber, errorMessage);

    if (failureResult.movedToDlq) {
      // Đã vào DLQ → throw để Bull ghi failed log, không retry tiếp
      throw new Error(`SBT mint moved to DLQ after ${attemptNumber} attempts: ${errorMessage}`);
    }

    if (failureResult.willRetry) {
      // Đã schedule retry job trong queue → return success để Bull không retry lại
      logger.info('SBT mint sẽ retry ở attempt tiếp theo.', {
        mintRequestId,
        nextAttempt: attemptNumber + 1,
        nextDelayMs: failureResult.nextDelayMs ?? undefined
      });
      return {
        onChainTokenId: null,
        transactionHash: null,
        blockNumber: null,
        status: 'FAILED',
        attemptNumber
      };
    }

    // Edge case: không retry, không DLQ (record bị xóa giữa chừng)
    throw error;
  }
}

/**
 * Khởi động SBT mint worker — đăng ký processor với Bull queue + lắng nghe oracle event.
 * Mục đích: bridge giữa Oracle signal (B1) và on-chain mint (C1).
 * Pattern giống oracle.worker.ts.
 */
export function startSbtMintWorker(): void {
  const queue = getSbtMintQueue();
  if (!queue) {
    logger.warn('SBT mint queue không khả dụng. Worker không khởi động.');
    return;
  }

  queue.process(SBT_MINT_WORKER_CONCURRENCY, processSbtMintJob);

  queue.on('failed', (job, error) => {
    logger.error('SBT mint job failed event.', {
      queueJobId: job.id,
      mintRequestId: job.data.mintRequestId,
      sbtId: job.data.sbtId,
      attemptNumber: job.data.attemptNumber,
      errorMessage: (error as Error)?.message
    });
  });

  queue.on('stalled', (job) => {
    logger.warn('SBT mint job bị stall.', {
      queueJobId: job.id,
      mintRequestId: job.data.mintRequestId,
      sbtId: job.data.sbtId
    });
  });

  queue.on('completed', (job, result) => {
    logger.info('SBT mint job completed event.', {
      queueJobId: job.id,
      mintRequestId: job.data.mintRequestId,
      sbtId: job.data.sbtId,
      onChainTokenId: result?.onChainTokenId ?? undefined,
      transactionHash: result?.transactionHash ?? undefined,
      status: result?.status
    });
  });

  // Lắng nghe oracle.verified để tự động tạo mint request
  attachOracleEventListener();

  logger.info(`SBT mint worker đã khởi động (concurrency=${SBT_MINT_WORKER_CONCURRENCY}, maxAttempts=${SBT_MINT_MAX_ATTEMPTS}).`);
}

/** Dừng SBT mint worker — đóng queue connection. */
export async function stopSbtMintWorker(): Promise<void> {
  const queue = getSbtMintQueue();
  if (queue) {
    await queue.close();
    logger.info('SBT mint worker đã dừng.');
  }
  // Remove oracle listener để tránh memory leak
  oracleEvents.removeAllListeners('oracle.verified');
}
