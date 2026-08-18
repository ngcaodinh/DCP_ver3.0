import { createHmac, timingSafeEqual } from 'crypto';
import { getLogger } from '../config/logger';
import { ApplicationError } from '../utils/applicationError';
import { findVerificationById, markVerificationSbtMintEnqueued, type OracleVerificationResultRecord } from '../models/oracleVerificationResultModel';
import { consumeOracleTriggerNonce } from '../models/oracleTriggerNonceModel';
import { findDisbursementByRequestId, findDisbursementsByProjectId } from '../models/disbursementModel';
import { findUserWalletAddressById } from '../models/authModel';
import { findDonationsByProjectId } from '../models/donationModel';
import { countBeneficiariesByProjectId } from '../models/beneficiaryFeedbackModel';
import { createSbtMintRequest, type CreateSbtMintRequestInput } from '../services/sbtMintService';
import { countConfirmedImpactSbtByProjectId } from '../models/impactSbtMetadataModel';
import { ethers } from 'ethers';
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

const ORACLE_TRIGGER_MAX_CLOCK_SKEW_SECONDS = 300;

/** Chuyển projectId string thành uint256 display deterministic mà không nhận giá trị từ client. */
function projectIdToNumeric(projectId: string): number {
  if (/^\d+$/.test(projectId)) {
    const numericProjectId = Number(projectId);
    if (Number.isSafeInteger(numericProjectId)) return numericProjectId;
  }
  return Number(BigInt(ethers.keccak256(ethers.toUtf8Bytes(projectId))) % BigInt(Number.MAX_SAFE_INTEGER));
}

/** Xác thực chữ ký HMAC, timestamp và nonce của Oracle service trước khi xử lý verificationId. */
export async function verifyOracleTriggerRequest(
  verificationId: string,
  headers: { signature?: string; timestamp?: string; nonce?: string }
): Promise<void> {
  const secret = process.env.ORACLE_TRIGGER_SHARED_SECRET?.trim();
  if (!secret) {
    throw new ApplicationError('Oracle trigger chưa được cấu hình shared secret.', 503, 'ORACLE_AUTH_UNAVAILABLE');
  }

  const timestamp = Number(headers.timestamp);
  const nonce = headers.nonce?.trim() ?? '';
  const signature = headers.signature?.trim() ?? '';
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(timestamp) || Math.abs(nowSeconds - timestamp) > ORACLE_TRIGGER_MAX_CLOCK_SKEW_SECONDS) {
    throw new ApplicationError('Oracle trigger timestamp hết hạn hoặc không hợp lệ.', 401, 'ORACLE_SIGNATURE_INVALID');
  }
  if (!/^[A-Za-z0-9._:-]{16,128}$/.test(nonce) || !/^[a-fA-F0-9]{64}$/.test(signature)) {
    throw new ApplicationError('Oracle trigger signature hoặc nonce không hợp lệ.', 401, 'ORACLE_SIGNATURE_INVALID');
  }

  const expectedSignature = createHmac('sha256', secret)
    .update(`${timestamp}.${nonce}.${verificationId}`)
    .digest('hex');
  if (!timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expectedSignature, 'hex'))) {
    throw new ApplicationError('Oracle trigger signature không hợp lệ.', 401, 'ORACLE_SIGNATURE_INVALID');
  }

  const consumed = await consumeOracleTriggerNonce(
    nonce,
    new Date((timestamp + ORACLE_TRIGGER_MAX_CLOCK_SKEW_SECONDS) * 1000)
  );
  if (!consumed) {
    throw new ApplicationError('Oracle trigger nonce đã được sử dụng.', 409, 'ORACLE_SIGNATURE_REPLAY');
  }
}

/** Resolve toàn bộ input mint từ verification và dữ liệu nghiệp vụ đã lưu, không tin payload client. */
export async function resolveSbtMintInputFromVerification(
  verification: OracleVerificationResultRecord
): Promise<CreateSbtMintRequestInput> {
  if (verification.status !== 'VALID') {
    throw new ApplicationError('Chỉ verification VALID mới được tạo SBT mint request.', 409, 'VERIFICATION_NOT_VALID');
  }
  if (!verification.gpsFromImage) {
    throw new ApplicationError('Verification VALID thiếu GPS snapshot authoritative.', 422, 'VERIFICATION_DATA_INCOMPLETE');
  }

  const [linkedDisbursement, disbursements, donations, beneficiaryCount, confirmedSbtCount] = await Promise.all([
    verification.disbursementRequestId
      ? findDisbursementByRequestId(verification.disbursementRequestId)
      : Promise.resolve(null),
    findDisbursementsByProjectId(verification.projectId, 1000),
    findDonationsByProjectId(verification.projectId, 1000),
    countBeneficiariesByProjectId(verification.projectId),
    countConfirmedImpactSbtByProjectId(verification.projectId)
  ]);

  if (verification.disbursementRequestId && (
    !linkedDisbursement
    || linkedDisbursement.projectId !== verification.projectId
    || linkedDisbursement.organizationId !== verification.organizationId
  )) {
    throw new ApplicationError('Disbursement không khớp verification authoritative.', 422, 'VERIFICATION_DATA_MISMATCH');
  }

  const beneficiaryAddress = linkedDisbursement?.beneficiaryWalletAddress
    ?? await findUserWalletAddressById(verification.organizationId);
  if (!beneficiaryAddress || !ethers.isAddress(beneficiaryAddress) || beneficiaryAddress === ethers.ZeroAddress) {
    throw new ApplicationError('Không tìm thấy beneficiary wallet authoritative cho verification.', 422, 'BENEFICIARY_NOT_FOUND');
  }

  const distinctDisbursementBeneficiaries = new Set(
    disbursements.map(record => record.beneficiaryWalletAddress.toLowerCase())
  ).size;
  const distinctDonors = new Set(donations.map(record => record.donorAddress.toLowerCase())).size;
  const resolvedBeneficiaryCount = Math.max(
    1,
    distinctDisbursementBeneficiaries || distinctDonors || beneficiaryCount
  );

  return {
    verificationId: verification.verificationId,
    projectId: verification.projectId,
    organizationId: verification.organizationId,
    beneficiaryAddress,
    projectIdNumeric: projectIdToNumeric(verification.projectId),
    // Mỗi verification VALID là một mốc canonical tiếp theo của project; không nhận milestone từ client.
    milestone: Math.max(1, confirmedSbtCount + 1),
    beneficiaryCount: resolvedBeneficiaryCount,
    gpsCoordinates: `${verification.gpsFromImage.lat},${verification.gpsFromImage.lng}`,
    imageCid: verification.evidenceCid,
    tokenUri: verification.evidenceCid.startsWith('ipfs://')
      ? verification.evidenceCid
      : `ipfs://${verification.evidenceCid}`
  };
}

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
 * - Gas sponsorship: EOA signing với IMPACT_SBT_MINTER_PRIVATE_KEY (không dùng Account Abstraction/Paymaster)
 * - Stuck tx handling: cron-based recovery (sbtMintRecoveryScheduler từ C2)
 *
 * @param body - validated request body từ controller
 * @returns Promise<TriggerSbtMintResult> chứa metadata record và trạng thái enqueue
 */
export async function triggerSbtMintFromOracle(
  body: SbtTriggerBody
): Promise<TriggerSbtMintResult> {
  const verification = await findVerificationById(body.verificationId);
  if (!verification) {
    throw new ApplicationError('Không tìm thấy oracle verification.', 404, 'VERIFICATION_NOT_FOUND');
  }
  const mintInput = await resolveSbtMintInputFromVerification(verification);

  logger.info('Oracle trigger SBT mint request.', {
    verificationId: body.verificationId,
    projectId: verification.projectId,
    milestone: mintInput.milestone
  });

  // Gọi service — idempotent: nếu verificationId đã tồn tại, trả về existing record
  const result = await createSbtMintRequest(mintInput);
  if (result.enqueued || ['SUBMITTING', 'SUBMITTED', 'CONFIRMED', 'DLQ'].includes(result.record.status)) {
    await markVerificationSbtMintEnqueued(body.verificationId);
  }

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
      projectId: verification.projectId,
      jobId: result.jobId,
      enqueued: result.enqueued
    });
  }

  return result;
}
