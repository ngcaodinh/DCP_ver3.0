import {
  findSoftDeletedFeedbackForPurge,
  hardDeleteBeneficiaryFeedbackByIds
} from '../models/beneficiaryFeedbackModel';
import { feedbackHardPurgedTotal } from '../config/metricsRegistry';
import { invalidatePublicFeedbackStatsCache } from './publicFeedback.service';
import { FEEDBACK_SOFT_DELETE_RETENTION_DAYS } from './feedbackRetention.constants';

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_MAX_BATCHES = 100;
const DEFAULT_TIME_BUDGET_MS = 30_000;

export interface PurgeSoftDeletedFeedbackOptions {
  now?: Date;
  batchSize?: number;
  maxBatches?: number;
  timeBudgetMs?: number;
}

export interface PurgeSoftDeletedFeedbackResult {
  cutoff: Date;
  scanned: number;
  purged: number;
  hasMore: boolean;
  oldestDeletedAt: Date | null;
  affectedProjectIds: string[];
}

/** Purge feedback quá hạn theo lô, giới hạn thời gian và re-check cutoff ở lệnh xoá cứng. */
export async function purgeSoftDeletedFeedback(
  options: PurgeSoftDeletedFeedbackOptions = {}
): Promise<PurgeSoftDeletedFeedbackResult> {
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - FEEDBACK_SOFT_DELETE_RETENTION_DAYS * MILLISECONDS_PER_DAY);
  const batchSize = clamp(options.batchSize ?? DEFAULT_BATCH_SIZE, 1, 5_000);
  const maxBatches = clamp(options.maxBatches ?? DEFAULT_MAX_BATCHES, 1, 1_000);
  const timeBudgetMs = clamp(options.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS, 1, 300_000);
  const result: PurgeSoftDeletedFeedbackResult = {
    cutoff,
    scanned: 0,
    purged: 0,
    hasMore: false,
    oldestDeletedAt: null,
    affectedProjectIds: []
  };
  const affectedProjectIdSet = new Set<string>();
  const startedAt = Date.now();

  for (let batchIndex = 0; batchIndex < maxBatches; batchIndex += 1) {
    if (batchIndex > 0 && Date.now() - startedAt >= timeBudgetMs) {
      result.hasMore = true;
      break;
    }

    const records = await findSoftDeletedFeedbackForPurge(cutoff, batchSize);
    if (records.length === 0) {
      result.hasMore = false;
      break;
    }

    result.scanned += records.length;
    result.oldestDeletedAt = records[0].deletedAt ?? result.oldestDeletedAt;
    records.forEach(record => affectedProjectIdSet.add(record.projectId));
    const purgedCount = await hardDeleteBeneficiaryFeedbackByIds(
      records.map(record => record.feedbackId),
      cutoff
    );
    result.purged += purgedCount;
    feedbackHardPurgedTotal.inc(purgedCount);

    result.hasMore = records.length >= batchSize;
    if (records.length < batchSize) break;
  }

  result.affectedProjectIds = [...affectedProjectIdSet];
  result.affectedProjectIds.forEach(projectId => invalidatePublicFeedbackStatsCache(projectId));
  if (!result.hasMore) result.oldestDeletedAt = null;
  return result;
}

/** Giới hạn tham số worker để một cấu hình lỗi không tạo batch hoặc thời gian vô hạn. */
function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
