import { randomUUID } from 'crypto';
import { Job } from 'bull';
import { getLogger } from '../config/logger';
import {
  getOracleQueue,
  enqueueOracleVerification,
  type OracleVerificationJobData,
  type OracleVerificationJobResult
} from '../queues/oracleQueue';
import { verifyEvidenceImage, ORACLE_MAX_FILE_SIZE } from '../services/oracleService';
import {
  oracleEvents,
  type EvidenceUploadedEventPayload
} from '../events/oracleEvents';

const logger = getLogger();
const ORACLE_WORKER_CONCURRENCY = 3; // Tránh overload CPU khi parse EXIF đồng thời

/**
 * Processor xử lý job xác minh ảnh minh chứng.
 * Flow: validate buffer size → decode → verifyEvidenceImage (EXIF + Haversine) → trả kết quả.
 * Idempotent: cùng evidenceCid + projectId có thể chạy lại — tạo thêm record nhưng không gây lỗi.
 */
export async function processOracleVerificationJob(
  job: Job<OracleVerificationJobData>
): Promise<OracleVerificationJobResult> {
  const { jobId, projectId, organizationId, evidenceCid, imageBufferBase64, fileSizeBytes } = job.data;

  logger.info('Oracle verification job bắt đầu.', {
    queueJobId: job.id,
    jobId,
    projectId,
    evidenceCid,
    fileSizeBytes,
    attemptsMade: job.attemptsMade
  });

  // Validate kích thước buffer trước khi decode — tránh allocate memory lớn nếu job data bị tamper
  if (fileSizeBytes > ORACLE_MAX_FILE_SIZE) {
    throw new Error(
      `Buffer size ${fileSizeBytes} vượt giới hạn ${ORACLE_MAX_FILE_SIZE} bytes. Job bị reject.`
    );
  }

  const imageBuffer = Buffer.from(imageBufferBase64, 'base64');

  const result = await verifyEvidenceImage(imageBuffer, projectId, organizationId, evidenceCid);

  logger.info('Oracle verification job hoàn thành.', {
    queueJobId: job.id,
    jobId,
    projectId,
    evidenceCid,
    verificationId: result.verificationId,
    isValid: result.isValid,
    distanceMeters: result.distance?.toFixed(2) ?? undefined,
    reason: result.reason ?? undefined,
    overrideRequestId: result.overrideRequestId ?? undefined
  });

  return {
    verificationId: result.verificationId,
    isValid: result.isValid,
    distance: result.distance,
    reason: result.reason,
    overrideRequestId: result.overrideRequestId
  };
}

/**
 * Khởi động oracle worker — đăng ký processor với Bull queue.
 * Lắng nghe event evidence.uploaded để tự động enqueue job khi có ảnh mới.
 * Chỉ gọi khi RUN_WORKERS !== 'false' (từ server.ts).
 */
export function startOracleWorker(): void {
  const queue = getOracleQueue();
  if (!queue) {
    logger.warn('Oracle queue không khả dụng. Oracle worker không khởi động.');
    return;
  }

  queue.process(ORACLE_WORKER_CONCURRENCY, processOracleVerificationJob);

  queue.on('failed', (job, error) => {
    logger.error('Oracle verification job thất bại.', {
      queueJobId: job.id,
      jobId: job.data.jobId,
      projectId: job.data.projectId,
      evidenceCid: job.data.evidenceCid,
      attemptsMade: job.attemptsMade,
      errorMessage: (error as Error)?.message
    });
  });

  queue.on('stalled', (job) => {
    logger.warn('Oracle verification job bị stall.', {
      queueJobId: job.id,
      jobId: job.data.jobId,
      projectId: job.data.projectId
    });
  });

  // Lắng nghe evidence.uploaded để trigger verification tự động khi tổ chức upload ảnh.
  // Pattern giống notificationBridge.service.ts lắng nghe webhookEvents.
  oracleEvents.on('evidence.uploaded', async (payload: EvidenceUploadedEventPayload) => {
    try {
      const jobData: OracleVerificationJobData = {
        jobId: randomUUID(),
        projectId: payload.projectId,
        organizationId: payload.organizationId,
        evidenceCid: payload.evidenceCid,
        imageBufferBase64: payload.imageBufferBase64,
        fileSizeBytes: payload.fileSizeBytes
      };
      await enqueueOracleVerification(jobData);
    } catch (error) {
      logger.error('Không thể enqueue oracle verification từ evidence.uploaded event.', {
        projectId: payload.projectId,
        evidenceCid: payload.evidenceCid,
        errorMessage: (error as Error)?.message
      });
    }
  });

  logger.info(`Oracle worker đã khởi động (concurrency=${ORACLE_WORKER_CONCURRENCY}).`);
}

/** Dừng oracle worker — đóng queue connection. */
export async function stopOracleWorker(): Promise<void> {
  const queue = getOracleQueue();
  if (queue) {
    await queue.close();
    logger.info('Oracle worker đã dừng.');
  }
}
