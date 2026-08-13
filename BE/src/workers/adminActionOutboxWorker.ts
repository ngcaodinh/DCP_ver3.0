import { getLogger } from '../config/logger';
import { runWithWorkerContext } from '../config/requestContext';
import {
  claimAdminActionOutbox,
  markAdminActionOutboxDispatched,
  releaseAdminActionOutbox,
  type AdminActionOutboxRecord
} from '../models/adminActionOutboxModel';
import {
  enqueueDisbursementTransfer,
  getDisbursementTransferJobId,
  removePendingJobsByRequestId
} from '../queues/disbursementTransferQueue';
import { enqueueSbtMint } from '../queues/sbtMintQueue';
import { recordAdminAuditLog } from '../services/audit-log.service';
import { runMongoTransaction } from '../utils/mongoTransaction';

const logger = getLogger();
const OUTBOX_POLL_INTERVAL_MS = 5_000;
const OUTBOX_STALE_LOCK_MS = 60_000;
let intervalId: ReturnType<typeof setInterval> | null = null;
let isRunning = false;
type OutboxDispatchResult = { enqueued: boolean; jobId?: string | number };

/** Dispatch outbox sau commit; lỗi queue chỉ retry event, không rollback business decision. */
async function runAdminActionOutboxOnceInternal(eventId?: string): Promise<number> {
  let dispatched = 0;
  const now = new Date();
  for (;;) {
    const event = await claimAdminActionOutbox(now, new Date(now.getTime() - OUTBOX_STALE_LOCK_MS), eventId);
    if (!event) break;
    try {
      const result = await dispatchOutboxEvent(event);
      if (!result.enqueued) throw new Error(`Queue unavailable for ${event.eventType}.`);
      await completeOutboxEvent(event, result);
      dispatched += 1;
    } catch (error) {
      await releaseAdminActionOutbox(event.eventId, new Date(Date.now() + OUTBOX_POLL_INTERVAL_MS));
      logger.error('Admin action outbox dispatch thất bại; event sẽ retry.', {
        eventId: event.eventId,
        eventType: event.eventType,
        attempts: event.attempts,
        errorMessage: error instanceof Error ? error.message : 'Unknown outbox error'
      });
    }
  }
  return dispatched;
}

/** Chạy một vòng dispatch outbox trong correlation context riêng của worker. */
export async function runAdminActionOutboxOnce(eventId?: string): Promise<number> {
  return runWithWorkerContext('admin-action-outbox', () => runAdminActionOutboxOnceInternal(eventId));
}

export function startAdminActionOutboxWorker(): void {
  if (intervalId) return;
  void runScheduledOutboxOnce();
  intervalId = setInterval(() => { void runScheduledOutboxOnce(); }, OUTBOX_POLL_INTERVAL_MS);
}

export function stopAdminActionOutboxWorker(): void {
  if (!intervalId) return;
  clearInterval(intervalId);
  intervalId = null;
}

async function runScheduledOutboxOnce(): Promise<void> {
  if (isRunning) return;
  isRunning = true;
  try { await runAdminActionOutboxOnce(); } catch (error) {
    logger.error('Admin action outbox worker query thất bại.', {
      errorMessage: error instanceof Error ? error.message : 'Unknown outbox query error'
    });
  } finally { isRunning = false; }
}

/** Dispatch một event sau commit và trả về job ID để ghi outcome audit idempotent. */
async function dispatchOutboxEvent(event: AdminActionOutboxRecord): Promise<OutboxDispatchResult> {
  if (event.eventType === 'MANUAL_APPROVE_TRANSFER') {
    const payload = event.payload as { requestId?: string; idempotencyKey?: string };
    if (!payload.requestId || !payload.idempotencyKey) return { enqueued: false };
    const result = await enqueueDisbursementTransfer(payload.requestId, 1, payload.idempotencyKey);
    if (!result.enqueued) return result;
    // Chỉ cleanup job cũ sau khi job deterministic đã được accept; giữ lại chính job này khi retry outbox.
    await removePendingJobsByRequestId(
      payload.requestId,
      result.jobId ?? getDisbursementTransferJobId(payload.requestId, 1, payload.idempotencyKey)
    );
    return result;
  }

  if (event.eventType === 'MANUAL_REJECT_TRANSFER') {
    const payload = event.payload as { requestId?: string };
    if (!payload.requestId) return { enqueued: false };
    await removePendingJobsByRequestId(payload.requestId);
    return { enqueued: true };
  }

  const payload = event.payload as { mintRequestId?: string; sbtId?: string; attemptNumber?: number };
  if (!payload.mintRequestId || !payload.sbtId || payload.attemptNumber !== 1) return { enqueued: false };
  return enqueueSbtMint({
    mintRequestId: payload.mintRequestId,
    sbtId: payload.sbtId,
    attemptNumber: payload.attemptNumber,
    enqueuedBy: 'admin_rerun'
  }, { priority: 3 });
}

/** Commit trạng thái outbox và audit ENQUEUED trong cùng transaction để retry không ghi outcome sai. */
async function completeOutboxEvent(
  event: AdminActionOutboxRecord,
  result: OutboxDispatchResult
): Promise<void> {
  await runMongoTransaction(async (session) => {
    if (session) {
      await markAdminActionOutboxDispatched(event.eventId, new Date(), session);
    } else {
      await markAdminActionOutboxDispatched(event.eventId, new Date());
    }

    if (event.eventType !== 'SBT_MINT_RERUN') return;
    const payload = event.payload as {
      mintRequestId?: string;
      sbtId?: string;
      adminId?: string;
      adminRole?: string;
      previousStatus?: string;
      previousAttemptNumber?: number;
      reRunCount?: number;
      requestContext?: { ipAddress?: string | null; userAgent?: string | null };
    };
    if (!payload.mintRequestId || !payload.sbtId || !payload.adminId || !payload.adminRole) {
      throw new Error('SBT outbox payload thiếu thông tin audit actor.');
    }

    await recordAdminAuditLog({
      actionId: `${event.eventId}:enqueued`,
      actorType: 'ADMIN',
      adminId: payload.adminId,
      adminRole: payload.adminRole,
      actionType: 'SBT_MINT_RERUN_ENQUEUED',
      targetId: payload.mintRequestId,
      targetType: 'SBT_MINT_REQUEST',
      requestContext: payload.requestContext
        ? {
            ipAddress: payload.requestContext.ipAddress ?? null,
            userAgent: payload.requestContext.userAgent ?? null
          }
        : undefined,
      context: {
        mintRequestId: payload.mintRequestId,
        sbtId: payload.sbtId,
        previousStatus: payload.previousStatus ?? null,
        previousAttemptNumber: payload.previousAttemptNumber ?? null,
        reRunCount: payload.reRunCount ?? null,
        jobId: result.jobId ?? null,
        enqueueResult: 'ENQUEUED',
        outboxEventId: event.eventId,
        dispatchAttempt: event.attempts
      },
      ...(session ? { session } : {})
    });
  });
}
