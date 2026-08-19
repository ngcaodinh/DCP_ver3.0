import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findUserByLegalRegistrationNumber: vi.fn(),
  findLatestFoundationSubmissionByLegalRegistrationNumber: vi.fn(),
  findExistingBankAccountOwner: vi.fn(),
  createOrganizationKycSubmission: vi.fn(),
  uploadFileToPinataWithRetry: vi.fn(),
  detectFileTypeFromBuffer: vi.fn(),
  claimOnce: vi.fn(),
  releaseSubmissionSlot: vi.fn()
}));

vi.mock('../../models/authModel', () => ({
  findUserByLegalRegistrationNumber: mocks.findUserByLegalRegistrationNumber
}));
vi.mock('../../models/organizationKycModel', () => ({
  createOrganizationKycSubmission: mocks.createOrganizationKycSubmission,
  findExistingBankAccountOwner: mocks.findExistingBankAccountOwner,
  findLatestFoundationSubmissionByLegalRegistrationNumber: mocks.findLatestFoundationSubmissionByLegalRegistrationNumber
}));
vi.mock('../../services/organizationKycService', () => ({
  uploadFileToPinataWithRetry: mocks.uploadFileToPinataWithRetry
}));
vi.mock('../../services/upload-validation.service', () => ({
  detectFileTypeFromBuffer: mocks.detectFileTypeFromBuffer
}));
vi.mock('../../utils/submissionThrottle', () => ({
  claimOnce: mocks.claimOnce,
  releaseSubmissionSlot: mocks.releaseSubmissionSlot
}));
vi.mock('../../config/logger', () => ({
  getLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }))
}));

import { submitFoundationKyc } from '../../services/foundationKyc.service';

const PDF_BASE64 = Buffer.from('%PDF-1.7\nlegal-document').toString('base64');

function createPayload(base64Content = PDF_BASE64) {
  return {
    organizationName: 'Quỹ Nhân Ái Toàn Dân',
    legalRegistrationNumber: ' 031.234-567 ',
    taxIdentificationNumber: '0101234567-001',
    officialWebsite: 'https://example.org',
    organizationDescription: 'Pháp nhân đại diện tiếp nhận và quản lý tiền quyên góp.',
    legalDocument: {
      fileName: 'giay-phep.pdf',
      mimeType: 'application/pdf' as const,
      base64Content
    },
    bankName: 'MB',
    bankAccountNumber: '1234567890',
    accountHolderName: 'Quỹ Nhân Ái Đà Nẵng',
    branchName: 'Ha Noi',
    recaptchaToken: 'token'
  };
}

describe('submitFoundationKyc', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUserByLegalRegistrationNumber.mockResolvedValue(null);
    mocks.findLatestFoundationSubmissionByLegalRegistrationNumber.mockResolvedValue(null);
    mocks.findExistingBankAccountOwner.mockResolvedValue(null);
    mocks.uploadFileToPinataWithRetry.mockResolvedValue('bafy-foundation-document');
    mocks.createOrganizationKycSubmission.mockResolvedValue({});
    mocks.detectFileTypeFromBuffer.mockReturnValue({ mimeType: 'application/pdf', extension: 'pdf', isValid: false });
    mocks.claimOnce.mockResolvedValue(true);
    mocks.releaseSubmissionSlot.mockResolvedValue(undefined);
  });

  it('tạo hồ sơ mới với định danh FOUNDATION và lưu thông tin bank', async () => {
    const result = await submitFoundationKyc(createPayload(), { clientIpHash: 'hashed-ip' });

    expect(result).toMatchObject({ version: 1, status: 'PENDING_REVIEW' });
    expect(mocks.findUserByLegalRegistrationNumber).toHaveBeenCalledWith('031234567');
    expect(mocks.uploadFileToPinataWithRetry).toHaveBeenCalledTimes(1);
    expect(mocks.createOrganizationKycSubmission).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'FOUNDATION:031234567',
      organizationCategory: 'FOUNDATION',
      submittedBy: 'PUBLIC_FOUNDATION_FORM',
      status: 'PENDING_REVIEW',
      version: 1,
      taxIdentificationNumber: '0101234567001',
      beneficiaryBankAccount: expect.objectContaining({
        bankAccountNumber: '1234567890',
        accountHolderName: 'QUY NHAN AI DA NANG'
      })
    }));
    expect(mocks.releaseSubmissionSlot).toHaveBeenCalledOnce();
  });

  it('chặn request đồng thời cùng pháp nhân trước khi kiểm tra hoặc upload', async () => {
    mocks.claimOnce.mockResolvedValue(false);

    await expect(submitFoundationKyc(createPayload(), { clientIpHash: 'hashed-ip' }))
      .rejects.toMatchObject({ statusCode: 409, errorCode: 'DUPLICATE_SUBMISSION' });
    expect(mocks.findUserByLegalRegistrationNumber).not.toHaveBeenCalled();
    expect(mocks.uploadFileToPinataWithRetry).not.toHaveBeenCalled();
    expect(mocks.releaseSubmissionSlot).not.toHaveBeenCalled();
  });

  it.each([
    ['PENDING_REVIEW', 'DUPLICATE_SUBMISSION'],
    ['APPROVED', 'CONFLICT'],
    ['REJECTED', 'CONFLICT']
  ] as const)('chặn trạng thái %s và không upload lại', async (status, errorCode) => {
    mocks.findLatestFoundationSubmissionByLegalRegistrationNumber.mockResolvedValue({ status, version: 1 });

    await expect(submitFoundationKyc(createPayload(), { clientIpHash: 'hashed-ip' }))
      .rejects.toMatchObject({ statusCode: 409, errorCode });
    expect(mocks.uploadFileToPinataWithRetry).not.toHaveBeenCalled();
    expect(mocks.createOrganizationKycSubmission).not.toHaveBeenCalled();
  });

  it('cho phép retry SUBMISSION_ERROR thành version tiếp theo và không giữ bank trong bản ghi lỗi', async () => {
    mocks.findLatestFoundationSubmissionByLegalRegistrationNumber.mockResolvedValue({ status: 'SUBMISSION_ERROR', version: 1 });
    mocks.createOrganizationKycSubmission
      .mockRejectedValueOnce(new Error('metadata unavailable'))
      .mockResolvedValueOnce({});

    await expect(submitFoundationKyc(createPayload(), { clientIpHash: 'hashed-ip' }))
      .rejects.toMatchObject({ statusCode: 500, errorCode: 'INTERNAL_ERROR' });

    expect(mocks.createOrganizationKycSubmission).toHaveBeenNthCalledWith(2, expect.objectContaining({
      version: 2,
      status: 'SUBMISSION_ERROR',
      beneficiaryBankAccount: null
    }));
  });

  it('map duplicate key E11000 thành CONFLICT và không trả 500', async () => {
    mocks.createOrganizationKycSubmission.mockRejectedValueOnce({ code: 11000 });

    await expect(submitFoundationKyc(createPayload(), { clientIpHash: 'hashed-ip' }))
      .rejects.toMatchObject({ statusCode: 409, errorCode: 'CONFLICT' });
    expect(mocks.createOrganizationKycSubmission).toHaveBeenCalledTimes(1);
  });

  it('chặn NGO trùng số pháp nhân, bank owner và magic bytes trước Pinata', async () => {
    mocks.findUserByLegalRegistrationNumber.mockResolvedValueOnce({ id: 'ngo-1' });
    await expect(submitFoundationKyc(createPayload(), { clientIpHash: 'hashed-ip' }))
      .rejects.toMatchObject({ errorCode: 'DUPLICATE_LEGAL_REGISTRATION_NUMBER' });
    expect(mocks.uploadFileToPinataWithRetry).not.toHaveBeenCalled();

    mocks.findUserByLegalRegistrationNumber.mockResolvedValue(null);
    mocks.findExistingBankAccountOwner.mockResolvedValueOnce({ organizationId: 'ngo-2', organizationName: 'NGO', status: 'APPROVED' });
    await expect(submitFoundationKyc(createPayload(), { clientIpHash: 'hashed-ip' }))
      .rejects.toMatchObject({ errorCode: 'CONFLICT' });
    expect(mocks.uploadFileToPinataWithRetry).not.toHaveBeenCalled();

    mocks.findExistingBankAccountOwner.mockResolvedValue(null);
    mocks.detectFileTypeFromBuffer.mockReturnValueOnce({ mimeType: 'image/png', extension: 'png', isValid: false });
    await expect(submitFoundationKyc(createPayload(), { clientIpHash: 'hashed-ip' }))
      .rejects.toMatchObject({ statusCode: 415, errorCode: 'UNSUPPORTED_MEDIA_TYPE' });
    expect(mocks.uploadFileToPinataWithRetry).not.toHaveBeenCalled();
  });

  it('đo file sau decode và trả FILE_TOO_LARGE trước Pinata', async () => {
    const oversizedBase64 = Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64');

    await expect(submitFoundationKyc(createPayload(oversizedBase64), { clientIpHash: 'hashed-ip' }))
      .rejects.toMatchObject({ statusCode: 413, errorCode: 'FILE_TOO_LARGE' });
    expect(mocks.uploadFileToPinataWithRetry).not.toHaveBeenCalled();
  });
});
