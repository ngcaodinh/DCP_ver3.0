import crypto from 'node:crypto';
import { getLogger } from '../config/logger';
import { getFoundationKycIpHashSalt } from '../config/foundationKycRuntimeConfig';
import { FOUNDATION_KYC_ALLOWED_MIME_TYPES, FOUNDATION_KYC_MAX_FILE_SIZE_BYTES } from '../constants/foundationKycPolicy';
import { findUserByLegalRegistrationNumber } from '../models/authModel';
import {
  createOrganizationKycSubmission,
  findExistingBankAccountOwner,
  findLatestFoundationSubmissionByLegalRegistrationNumber,
  type OrganizationKycFile,
  type OrganizationKycSubmission
} from '../models/organizationKycModel';
import { uploadFileToPinataWithRetry, type OrganizationKycFileInput } from './organizationKycService';
import { detectFileTypeFromBuffer } from './upload-validation.service';
import { ApplicationError } from '../utils/applicationError';
import { claimOnce, releaseSubmissionSlot } from '../utils/submissionThrottle';
import type { FoundationKycSubmitPayload } from '../validators/foundationKycValidator';

const FOUNDATION_ORGANIZATION_ID_PREFIX = 'FOUNDATION:';
const FOUNDATION_PUBLIC_SUBMITTED_BY = 'PUBLIC_FOUNDATION_FORM';
const FOUNDATION_SUBMISSION_LOCK_TTL_SECONDS = 180;
const logger = getLogger();
const allowedFoundationMimeTypeSet = new Set<string>(FOUNDATION_KYC_ALLOWED_MIME_TYPES);

export interface FoundationKycSubmitContext {
  clientIpHash: string;
}

/** Chuẩn hóa số đăng ký pháp nhân thành khóa ổn định cho toàn bộ flow public. */
export function normalizeFoundationLegalRegistrationNumber(legalRegistrationNumber: string): string {
  return legalRegistrationNumber.trim().toUpperCase().replace(/[\s.-]/g, '');
}

/** Chuẩn hóa mã số thuế về chuỗi số liên tục để đối chiếu ổn định giữa các hồ sơ. */
export function normalizeFoundationTaxIdentificationNumber(taxIdentificationNumber: string): string {
  return taxIdentificationNumber.trim().replace(/[\s-]/g, '');
}

/** Chuẩn hóa tên chủ tài khoản để dữ liệu lưu trữ luôn viết hoa và không dấu tiếng Việt. */
export function normalizeFoundationAccountHolderName(accountHolderName: string): string {
  return accountHolderName
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[Đđ]/g, 'D')
    .toUpperCase();
}

/** Tạo khóa phân tán đã băm để serialize submission theo pháp nhân mà không lưu số đăng ký thô trong Redis. */
function buildFoundationSubmissionLockKey(normalizedLegalRegistrationNumber: string): string {
  const legalRegistrationHash = crypto
    .createHmac('sha256', getFoundationKycIpHashSalt())
    .update(normalizedLegalRegistrationNumber)
    .digest('hex');
  return `dcp:foundation-kyc:registration:${legalRegistrationHash}`;
}

/** Kiểm tra chuỗi có thể giải mã an toàn thành base64 trước khi tạo Buffer. */
function isValidBase64Content(base64Content: string): boolean {
  const normalizedBase64 = base64Content.replace(/\s/g, '');
  return normalizedBase64.length > 0
    && normalizedBase64.length % 4 !== 1
    && /^[A-Za-z0-9+/]*={0,2}$/.test(normalizedBase64);
}

/** Giải mã và xác thực kích thước file thực tế, không tin fileSize từ client. */
function decodeFoundationDocument(payload: FoundationKycSubmitPayload): Buffer {
  if (!isValidBase64Content(payload.legalDocument.base64Content)) {
    throw new ApplicationError('Nội dung file không hợp lệ.', 400, 'VALIDATION_ERROR');
  }

  const documentBuffer = Buffer.from(payload.legalDocument.base64Content, 'base64');
  if (documentBuffer.length === 0) {
    throw new ApplicationError('Nội dung file không được để trống.', 400, 'VALIDATION_ERROR');
  }
  if (documentBuffer.length > FOUNDATION_KYC_MAX_FILE_SIZE_BYTES) {
    throw new ApplicationError('File vượt quá giới hạn 5MB sau khi giải mã.', 413, 'FILE_TOO_LARGE');
  }
  return documentBuffer;
}

/** Kiểm tra magic bytes khớp MIME type khai báo trước khi gửi file lên Pinata. */
function validateFoundationDocumentType(payload: FoundationKycSubmitPayload, documentBuffer: Buffer): void {
  const detectedFileType = detectFileTypeFromBuffer(documentBuffer.subarray(0, 16));
  const declaredMimeType = payload.legalDocument.mimeType;
  if (!allowedFoundationMimeTypeSet.has(declaredMimeType) || detectedFileType.mimeType !== declaredMimeType) {
    throw new ApplicationError('Định dạng file không khớp với nội dung thực tế.', 415, 'UNSUPPORTED_MEDIA_TYPE');
  }
}

/** Trả lỗi conflict đúng hợp đồng khi MongoDB phát hiện collision ở partial unique index. */
function isDuplicateKeyError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 11000);
}

/** Kiểm tra trạng thái FOUNDATION gần nhất theo chính sách một chiều, một lần. */
function assertFoundationSubmissionCanProceed(latestSubmission: OrganizationKycSubmission | null): void {
  if (!latestSubmission) return;

  if (latestSubmission.status === 'PENDING_REVIEW') {
    throw new ApplicationError(
      'Hồ sơ của quỹ đang chờ Cơ quan giám sát duyệt.',
      409,
      'DUPLICATE_SUBMISSION'
    );
  }
  if (latestSubmission.status === 'APPROVED') {
    throw new ApplicationError('Quỹ đã được xác minh. Không cần nộp lại.', 409, 'CONFLICT');
  }
  if (latestSubmission.status === 'REJECTED') {
    throw new ApplicationError(
      'Hồ sơ đã bị từ chối. Cổng nộp công khai không hỗ trợ nộp lại, vui lòng liên hệ Cơ quan giám sát.',
      409,
      'CONFLICT'
    );
  }
  if (latestSubmission.status !== 'SUBMISSION_ERROR') {
    throw new ApplicationError('Quỹ đã có hồ sơ trên hệ thống và không thể nộp lại qua cổng công khai.', 409, 'CONFLICT');
  }
}

/** Tạo metadata file FOUNDATION sau khi file đã được Pinata cấp CID. */
function buildFoundationKycFile(
  payload: FoundationKycSubmitPayload,
  documentBuffer: Buffer,
  cid: string,
  version: number,
  submittedAt: Date
): OrganizationKycFile {
  return {
    cid,
    fileName: payload.legalDocument.fileName.trim(),
    mimeType: payload.legalDocument.mimeType,
    fileSize: documentBuffer.length,
    documentType: 'LEGAL_DOCUMENT',
    version,
    uploadedBy: FOUNDATION_PUBLIC_SUBMITTED_BY,
    uploadedAt: submittedAt,
    reviewStatus: 'PENDING_REVIEW',
    reviewedBy: null,
    reviewedAt: null,
    rejectionReason: null
  };
}

/**
 * Nộp hồ sơ KYC FOUNDATION public theo thứ tự fail-fast trước khi upload IPFS.
 * @param payload Payload đã qua Zod validator.
 * @param context Context quota đã được controller băm, không chứa IP thô.
 */
export async function submitFoundationKyc(
  payload: FoundationKycSubmitPayload,
  context: FoundationKycSubmitContext
): Promise<{ submissionId: string; version: number; status: 'PENDING_REVIEW' }> {
  const normalizedLegalRegistrationNumber = normalizeFoundationLegalRegistrationNumber(payload.legalRegistrationNumber);
  const normalizedTaxIdentificationNumber = normalizeFoundationTaxIdentificationNumber(payload.taxIdentificationNumber);
  const organizationId = `${FOUNDATION_ORGANIZATION_ID_PREFIX}${normalizedLegalRegistrationNumber}`;
  const documentBuffer = decodeFoundationDocument(payload);
  validateFoundationDocumentType(payload, documentBuffer);

  const submissionLockKey = buildFoundationSubmissionLockKey(normalizedLegalRegistrationNumber);
  const submissionLockClaimed = await claimOnce(submissionLockKey, FOUNDATION_SUBMISSION_LOCK_TTL_SECONDS);
  if (!submissionLockClaimed) {
    throw new ApplicationError(
      'Hồ sơ của pháp nhân này đang được xử lý. Vui lòng thử lại sau.',
      409,
      'DUPLICATE_SUBMISSION'
    );
  }

  try {
    const existingLegalRegistrationOwner = await findUserByLegalRegistrationNumber(normalizedLegalRegistrationNumber);
    if (existingLegalRegistrationOwner) {
      throw new ApplicationError(
        'Số đăng ký pháp nhân đã thuộc một tổ chức NGO đã đăng ký.',
        409,
        'DUPLICATE_LEGAL_REGISTRATION_NUMBER'
      );
    }

    const latestFoundationSubmission = await findLatestFoundationSubmissionByLegalRegistrationNumber(
      normalizedLegalRegistrationNumber
    );
    assertFoundationSubmissionCanProceed(latestFoundationSubmission);

    const existingBankAccountOwner = await findExistingBankAccountOwner(
      payload.bankAccountNumber.trim(),
      payload.bankName.trim(),
      organizationId
    );
    if (existingBankAccountOwner) {
      throw new ApplicationError(
        'Tài khoản ngân hàng này đã được liên kết với một hồ sơ khác.',
        409,
        'CONFLICT'
      );
    }

    const nextVersion = (latestFoundationSubmission?.version || 0) + 1;
    const submissionId = crypto.randomUUID();
    const submittedAt = new Date();
    const uploadInput: OrganizationKycFileInput = {
      fileName: payload.legalDocument.fileName.trim(),
      mimeType: payload.legalDocument.mimeType,
      fileSize: documentBuffer.length,
      base64Content: payload.legalDocument.base64Content,
      documentType: 'LEGAL_DOCUMENT'
    };
    const cid = await uploadFileToPinataWithRetry(uploadInput);
    const uploadedFile = buildFoundationKycFile(payload, documentBuffer, cid, nextVersion, submittedAt);

    const submissionData: OrganizationKycSubmission = {
      submissionId,
      organizationId,
      organizationName: payload.organizationName.trim(),
      legalRegistrationNumber: normalizedLegalRegistrationNumber,
      taxIdentificationNumber: normalizedTaxIdentificationNumber,
      officialWebsite: payload.officialWebsite?.trim() || null,
      organizationDescription: payload.organizationDescription.trim(),
      organizationCategory: 'FOUNDATION',
      version: nextVersion,
      status: 'PENDING_REVIEW',
      submittedBy: FOUNDATION_PUBLIC_SUBMITTED_BY,
      submittedAt,
      reviewedBy: null,
      reviewedAt: null,
      rejectionReason: null,
      beneficiaryBankAccount: {
        bankName: payload.bankName.trim(),
        bankAccountNumber: payload.bankAccountNumber.trim(),
        accountHolderName: normalizeFoundationAccountHolderName(payload.accountHolderName),
        branchName: payload.branchName?.trim() || null
      },
      files: [uploadedFile]
    };

    try {
      await createOrganizationKycSubmission(submissionData);
      logger.info('Foundation KYC submission created.', { clientIpHash: context.clientIpHash, submissionId });
      return { submissionId, version: nextVersion, status: 'PENDING_REVIEW' };
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        throw new ApplicationError(
          'Tài khoản ngân hàng này đã được một hồ sơ khác sử dụng.',
          409,
          'CONFLICT'
        );
      }

      // Chỉ ghi SUBMISSION_ERROR sau khi Pinata đã thành công; tài khoản null để retry không bị partial index giữ chỗ.
      try {
        await createOrganizationKycSubmission({
          ...submissionData,
          status: 'SUBMISSION_ERROR',
          beneficiaryBankAccount: null,
          rejectionReason: 'Lỗi lưu metadata sau khi upload Pinata.'
        });
      } catch (submissionError) {
        logger.error('Foundation KYC submission error could not be recorded.', {
          clientIpHash: context.clientIpHash,
          errorType: submissionError instanceof Error ? submissionError.name : 'UnknownError'
        });
      }

      throw new ApplicationError(
        'Đã upload file lên IPFS nhưng lưu metadata thất bại. Hồ sơ ở trạng thái SUBMISSION_ERROR.',
        500,
        'INTERNAL_ERROR'
      );
    }
  } finally {
    await releaseSubmissionSlot(submissionLockKey);
  }
}
