import { Job } from 'bull';
import { z } from 'zod';
import { getLogger } from '../config/logger';
import { runWithWorkerContext } from '../config/requestContext';
import {
  getSbtMintQueue,
  SBT_MINT_MAX_ATTEMPTS
} from '../queues/sbtMintQueue';
import { oracleEvents } from '../events/oracleEvents';
import { executeSbtMint, handleSbtMintFailure, extractErrorMessage, SbtSubmissionPersistenceError } from '../services/sbtMintService';
import { triggerSbtMintFromOracle } from '../services/sbt-trigger.service';
import { findPendingSbtMintVerifications } from '../models/oracleVerificationResultModel';
import { reportTerminalError } from '../utils/sentryReporter';

const logger = getLogger();

/**
 * Concurrency cho SBT mint worker.
 * Thấp (1-2) vì mint là 1 transaction on-chain + chờ receipt 1 block
 * → tránh spam RPC node khi có nhiều Oracle verify cùng lúc.
 */
const SBT_MINT_WORKER_CONCURRENCY = 2;

/** Schema chỉ nhận verificationId; mọi field mint còn lại phải resolve từ DB authoritative. */
const OracleVerifiedEventPayloadSchema = z.object({
  verificationId: z.string().min(1)
});

let oracleListenerAttached = false;

/** Dispatch durable mint request từ event nhẹ; nếu process tách nhau, replay DB sẽ bù event bị mất. */
function attachOracleEventListener(): void {
  if (oracleListenerAttached) return;
  oracleListenerAttached = true;
  oracleEvents.on('oracle.verified', async (rawPayload: unknown) => {
    const parseResult = OracleVerifiedEventPayloadSchema.safeParse(rawPayload);
    if (!parseResult.success) {
      logger.error('Oracle.verified payload không hợp lệ — bỏ qua mint.', {
        errorMessage: parseResult.error.message
      });
      return;
    }
    try {
      await triggerSbtMintFromOracle(parseResult.data);
    } catch (error) {
      logger.error('Dispatch SBT từ oracle.verified thất bại; durable replay sẽ thử lại.', {
        verificationId: parseResult.data.verificationId,
        errorMessage: extractErrorMessage(error)
      });
    }
  });
}

/** Replay VALID verification còn PENDING dispatch để API/worker khác process vẫn không mất trigger. */
export async function replayPendingOracleSbtMints(limit = 50): Promise<number> {
  const pendingVerifications = await findPendingSbtMintVerifications(limit);
  let dispatchedCount = 0;
  for (const verification of pendingVerifications) {
    try {
      const result = await triggerSbtMintFromOracle({ verificationId: verification.verificationId });
      if (result.enqueued || result.duplicate) dispatchedCount += 1;
    } catch (error) {
      logger.warn('Replay Oracle verification chưa dispatch được; giữ PENDING để cycle sau.', {
        verificationId: verification.verificationId,
        errorMessage: extractErrorMessage(error)
      });
    }
  }
  return dispatchedCount;
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
async function processSbtMintJobInternal(
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
    if (error instanceof SbtSubmissionPersistenceError) {
      // Không đổi FAILED/không enqueue nonce khác; receipt reconciler sẽ xử lý trạng thái không chắc chắn.
      throw error;
    }
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
      // Đã vào DLQ → terminal, ghi Winston và capture Sentry theo bảng E6.
      const dlqError = new Error(
        `SBT mint moved to DLQ after ${attemptNumber} attempts (1 initial attempt plus retries): ${errorMessage}`
      );
      reportTerminalError('SBT mint job đã vào DLQ.', dlqError, {
        errorSource: 'job-dlq',
        metadata: {
          mintRequestId,
          sbtId: job.data.sbtId,
          attemptNumber,
          durationMs,
          errorMessage
        }
      });
      // Throw để Bull ghi failed log và không retry tiếp.
      throw dlqError;
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

/** Chạy processor SBT mint trong correlation context riêng của queue job. */
export async function processSbtMintJob(
  job: Job<{ mintRequestId: string; sbtId: string; attemptNumber: number; enqueuedBy: string }>
): Promise<{
  onChainTokenId: number | null;
  transactionHash: string | null;
  blockNumber: number | null;
  status: 'CONFIRMED' | 'SUBMITTED' | 'FAILED' | 'DLQ';
  attemptNumber: number;
}> {
  return runWithWorkerContext('sbt-mint', () => processSbtMintJobInternal(job), job.id);
}

/**
 * Khởi động SBT mint worker — đăng ký processor với Bull queue + lắng nghe oracle event.
 * Mục đích: bridge giữa Oracle signal (B1) và on-chain mint (C1).
 * Pattern giống oracle.worker.ts.
 */
export function startSbtMintWorker(): void {
  // Đăng ký listener độc lập với Redis; verification được persist trước nên event vẫn replay được.
  attachOracleEventListener();
  const queue = getSbtMintQueue();
  if (!queue) {
    logger.warn('SBT mint queue không khả dụng. Worker không khởi động.');
    return;
  }

  queue.process(SBT_MINT_WORKER_CONCURRENCY, processSbtMintJob);

  queue.on('failed', (job, error) => {
    runWithWorkerContext('sbt-mint', () => {
      logger.error('SBT mint job failed event.', {
        queueJobId: job.id,
        mintRequestId: job.data.mintRequestId,
        sbtId: job.data.sbtId,
        attemptNumber: job.data.attemptNumber,
        errorMessage: (error as Error)?.message
      });
    }, job.id);
  });

  queue.on('stalled', (job) => {
    runWithWorkerContext('sbt-mint', () => {
      logger.warn('SBT mint job bị stall.', {
        queueJobId: job.id,
        mintRequestId: job.data.mintRequestId,
        sbtId: job.data.sbtId
      });
    }, job.id);
  });

  queue.on('completed', (job, result) => {
    runWithWorkerContext('sbt-mint', () => {
      logger.info('SBT mint job completed event.', {
        queueJobId: job.id,
        mintRequestId: job.data.mintRequestId,
        sbtId: job.data.sbtId,
        onChainTokenId: result?.onChainTokenId ?? undefined,
        transactionHash: result?.transactionHash ?? undefined,
        status: result?.status
      });
    }, job.id);
  });

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
  oracleListenerAttached = false;
}
