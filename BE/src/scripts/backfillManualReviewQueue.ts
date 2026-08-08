import mongoose from 'mongoose';
import { getLogger } from '../config/logger';
import { findDisbursementsInManualReview } from '../models/disbursementModel';
import { findPendingManualReviewQueueByRequestId } from '../models/manualReviewQueueModel';
import { openManualReviewQueueForDisbursement } from '../services/manualReviewService';

const logger = getLogger();

type BackfillOptions = {
  dryRun: boolean;
  batchSize: number;
  maxItems: number;
};

type BackfillResult = {
  scanned: number;
  opened: number;
  skipped: number;
  failed: number;
  hasMore: boolean;
};

/** Đọc option CLI cho backfill manual review queue. */
function parseBackfillOptions(argv: string[]): BackfillOptions {
  const dryRun = argv.includes('--dry-run');
  const batchSizeArg = argv.find(arg => arg.startsWith('--batch-size='));
  const batchSizeValue = batchSizeArg ? Number(batchSizeArg.split('=')[1]) : 100;
  const batchSize = Number.isFinite(batchSizeValue)
    ? Math.max(1, Math.min(500, Math.floor(batchSizeValue)))
    : 100;
  const maxItemsArg = argv.find(arg => arg.startsWith('--max-items='));
  const maxItemsValue = maxItemsArg ? Number(maxItemsArg.split('=')[1]) : 100;
  const maxItems = Number.isFinite(maxItemsValue)
    ? Math.max(1, Math.min(100_000, Math.floor(maxItemsValue)))
    : 100;

  return { dryRun, batchSize, maxItems };
}

/** Kết nối MongoDB bằng URI môi trường mà không đọc hoặc log secret. */
async function connectMongo(): Promise<void> {
  const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!mongoUri) {
    throw new Error('Thiếu MONGODB_URI hoặc MONGO_URI.');
  }

  await mongoose.connect(mongoUri);
}

/** Backfill các disbursement MANUAL_REVIEW còn thiếu queue item durable bằng cursor để không kẹt ở batch mới nhất. */
async function backfillManualReviewQueue(options: BackfillOptions): Promise<BackfillResult> {
  const result: BackfillResult = {
    scanned: 0,
    opened: 0,
    skipped: 0,
    failed: 0,
    hasMore: false
  };
  let cursor: { updatedAt: Date; requestId: string } | undefined;

  while (result.opened < options.maxItems) {
    const pageSize = Math.min(options.batchSize, options.maxItems - result.opened);
    const disbursements = await findDisbursementsInManualReview(pageSize, cursor);
    if (disbursements.length === 0) {
      break;
    }

    for (const disbursement of disbursements) {
      result.scanned += 1;
      cursor = { updatedAt: disbursement.updatedAt, requestId: disbursement.requestId };

      try {
        const existingQueue = await findPendingManualReviewQueueByRequestId(disbursement.requestId);
        if (existingQueue) {
          result.skipped += 1;
          continue;
        }

        if (!options.dryRun) {
          await openManualReviewQueueForDisbursement({
            disbursement,
            reason: disbursement.payosTransferLastError || 'Backfill manual review queue.',
            retryCount: disbursement.payosTransferAttemptCount,
            source: 'backfill'
          });
        }

        result.opened += 1;
        if (result.opened >= options.maxItems) {
          break;
        }
      } catch (error) {
        result.failed += 1;
        logger.error('Backfill manual review queue item thất bại.', {
          requestId: disbursement.requestId,
          errorMessage: (error as Error)?.message
        });
      }
    }

    if (result.opened >= options.maxItems) {
      const remaining = await findDisbursementsInManualReview(1, cursor);
      result.hasMore = remaining.length > 0;
      break;
    }

    if (disbursements.length < pageSize) {
      break;
    }
  }

  return result;
}

/** Entry point CLI cho script backfill A3. */
async function main(): Promise<void> {
  const options = parseBackfillOptions(process.argv.slice(2));
  await connectMongo();

  try {
    const result = await backfillManualReviewQueue(options);
    console.log(JSON.stringify({
      dryRun: options.dryRun,
      batchSize: options.batchSize,
      maxItems: options.maxItems,
      ...result
    }, null, 2));
  } finally {
    await mongoose.disconnect();
  }
}

void main().catch(error => {
  logger.error('Backfill manual review queue thất bại.', {
    errorMessage: (error as Error)?.message
  });
  process.exitCode = 1;
});
