import { getLogger } from '../config/logger';
import { createSbtMintRequest, type CreateSbtMintRequestInput } from '../services/sbtMintService';
import type { ImpactSbtMetadataRecord } from '../models/impactSbtMetadataModel';
import type { SbtTriggerBody } from '../validators/sbtTrigger.validator';

const logger = getLogger();

/**
 * Kết quả trả về từ triggerSbtMintFromOracle.
 * Bao gồm metadata record + flag duplicate để caller xử lý idempotency.
 */
export type TriggerSbtMintResult = {
  record: ImpactSbtMetadataRecord;
  jobId: string | number | undefined;
  enqueued: boolean;
  duplicate: boolean;
};

/**
 * Kiểm tra xem transaction có bị stuck (> 5 phút SUBMITTED không confirm) không.
 * Mục đích: hỗ trợ Oracle biết khi nào transaction cần được retry.
 * Lưu ý: recovery thực tế được xử lý bởi cron-based sbtMintRecoveryScheduler (C2).
 * Hàm này chỉ cung cấp thông tin check, không tự động retry.
 */
export function isTransactionStuck(record: ImpactSbtMetadataRecord): boolean {
  if (record.status !== 'SUBMITTED' || !record.submittedAt) {
    return false;
  }
  const stuckThresholdMs = 5 * 60 * 1000; // 5 phút
  const elapsedMs = Date.now() - record.submittedAt.getTime();
  return elapsedMs > stuckThresholdMs;
}

/**
 * Hàm trigger mint SBT từ Oracle service.
 *
 * Flow:
 * 1. Build CreateSbtMintRequestInput từ validated payload (đã validate ở controller)
 * 2. Gọi createSbtMintRequest từ sbtMintService (idempotent)
 * 3. Log kết quả với thông tin cần thiết cho Oracle/frontend
 *
 * Ràng buộc:
 * - Chỉ gọi qua API endpoint đã được auth middleware bảo vệ
 * - Validation đã được thực hiện ở controller trước khi gọi hàm này
 * - Gas sponsorship: EOA signing với BACKEND_MINTER_PRIVATE_KEY (không dùng Account Abstraction/Paymaster)
 * - Stuck tx handling: cron-based recovery (sbtMintRecoveryScheduler từ C2)
 *
 * @param body - validated request body từ controller
 * @returns Promise<TriggerSbtMintResult> chứa metadata record và trạng thái enqueue
 */
export async function triggerSbtMintFromOracle(
  body: SbtTriggerBody
): Promise<TriggerSbtMintResult> {
  // Build CreateSbtMintRequestInput từ validated payload — dùng body trực tiếp (N-B4 fix)
  const mintInput: CreateSbtMintRequestInput = {
    verificationId: body.verificationId,
    projectId: body.projectId,
    organizationId: body.organizationId,
    beneficiaryAddress: body.beneficiaryAddress,
    projectIdNumeric: body.projectIdNumeric,
    milestone: body.milestone,
    beneficiaryCount: body.beneficiaryCount,
    gpsCoordinates: body.gpsCoordinates,
    imageCid: body.imageCid,
    tokenUri: body.tokenUri
  };

  logger.info('Oracle trigger SBT mint request.', {
    verificationId: body.verificationId,
    projectId: body.projectId,
    milestone: body.milestone
  });

  // Gọi service — idempotent: nếu verificationId đã tồn tại, trả về existing record
  const result = await createSbtMintRequest(mintInput);

  // Log kết quả với context đầy đủ
  if (result.duplicate) {
    logger.info('SBT mint request duplicate — trả về existing record.', {
      mintRequestId: result.record.mintRequestId,
      sbtId: result.record.sbtId,
      verificationId: body.verificationId,
      status: result.record.status
    });
  } else {
    logger.info('SBT mint request mới đã tạo và enqueued.', {
      mintRequestId: result.record.mintRequestId,
      sbtId: result.record.sbtId,
      projectId: body.projectId,
      jobId: result.jobId,
      enqueued: result.enqueued
    });
  }

  return result;
}
