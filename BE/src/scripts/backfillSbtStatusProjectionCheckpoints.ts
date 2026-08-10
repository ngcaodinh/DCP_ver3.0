import mongoose from 'mongoose';
import { getLogger } from '../config/logger';
import { findEarliestConfirmedImpactSbtBackfillAnchor } from '../models/impactSbtMetadataModel';
import {
  findAllSbtStatusProjectionCheckpoints,
  rewindSbtStatusProjectionCheckpoint,
  type SbtStatusProjectionCheckpointRecord
} from '../models/sbtStatusProjectionModel';

const logger = getLogger();

export interface SbtStatusProjectionCheckpointBackfillResult {
  dryRun: boolean;
  earliestConfirmedBlock: number | null;
  inspected: number;
  rewound: number;
}

/** Hạ checkpoint sentinel legacy tạo trước mint CONFIRMED đầu tiên để projector replay đủ status event lịch sử. */
export async function backfillSbtStatusProjectionCheckpoints(
  dryRun = false
): Promise<SbtStatusProjectionCheckpointBackfillResult> {
  const earliestConfirmedAnchor = await findEarliestConfirmedImpactSbtBackfillAnchor();
  const checkpointList = await findAllSbtStatusProjectionCheckpoints();
  const result: SbtStatusProjectionCheckpointBackfillResult = {
    dryRun,
    earliestConfirmedBlock: earliestConfirmedAnchor?.blockNumber ?? null,
    inspected: checkpointList.length,
    rewound: 0
  };

  if (earliestConfirmedAnchor === null) return result;

  for (const checkpoint of checkpointList) {
    if (!shouldRewindCheckpoint(checkpoint, earliestConfirmedAnchor)) continue;

    if (!dryRun) {
      await rewindSbtStatusProjectionCheckpoint(
        checkpoint,
        earliestConfirmedAnchor.blockNumber,
        -1
      );
    }
    result.rewound += 1;
  }

  return result;
}

/** Chỉ nhận diện sentinel legacy tạo trước mint CONFIRMED đầu tiên, không rewind checkpoint khỏe mạnh. */
function shouldRewindCheckpoint(
  checkpoint: SbtStatusProjectionCheckpointRecord,
  earliestConfirmedAnchor: {
    blockNumber: number;
    confirmedAt: Date;
  }
): boolean {
  const checkpointCreatedAt = checkpoint.createdAt instanceof Date
    ? checkpoint.createdAt.getTime()
    : Number.NaN;
  const earliestConfirmedAt = earliestConfirmedAnchor.confirmedAt.getTime();

  return checkpoint.lastProcessedLogIndex === Number.MAX_SAFE_INTEGER
    && checkpoint.lastProcessedBlock >= earliestConfirmedAnchor.blockNumber
    && Number.isFinite(checkpointCreatedAt)
    && Number.isFinite(earliestConfirmedAt)
    && checkpointCreatedAt < earliestConfirmedAt;
}

/** Kết nối MongoDB cho lệnh backfill mà không log URI hoặc thông tin nhạy cảm. */
async function connectMongo(): Promise<void> {
  const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!mongoUri) {
    throw new Error('Thiếu MONGODB_URI hoặc MONGO_URI.');
  }

  await mongoose.connect(mongoUri);
}

/** Chạy backfill checkpoint từ command line và đóng kết nối MongoDB sau khi hoàn tất. */
async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  await connectMongo();

  try {
    const result = await backfillSbtStatusProjectionCheckpoints(dryRun);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    logger.error('Backfill SBT status projection checkpoint thất bại.', {
      errorMessage: error instanceof Error ? error.message : 'UNKNOWN_ERROR'
    });
    process.exitCode = 1;
  });
}
