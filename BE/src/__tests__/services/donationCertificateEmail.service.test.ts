import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DonationCertificateRecord } from '../../models/donationCertificateModel';

const mocks = vi.hoisted(() => ({
  findDonationCertificateById: vi.fn(),
  updateDonationCertificateEmailState: vi.fn(),
  findUserById: vi.fn(),
  sendEmail: vi.fn(),
  renderDonationCertificatePdf: vi.fn(),
  getDonationCertificateConfig: vi.fn()
}));

vi.mock('../../repositories/donationCertificateRepository', () => ({
  findDonationCertificateById: mocks.findDonationCertificateById,
  updateDonationCertificateEmailState: mocks.updateDonationCertificateEmailState
}));

vi.mock('../../models/authModel', () => ({
  findUserById: mocks.findUserById
}));

vi.mock('../../services/email.service', () => ({
  sendEmail: mocks.sendEmail
}));

vi.mock('../../services/donationCertificatePdf.service', () => ({
  renderDonationCertificatePdf: mocks.renderDonationCertificatePdf
}));

vi.mock('../../config/donationCertificateConfig', () => ({
  getDonationCertificateConfig: mocks.getDonationCertificateConfig
}));

import {
  sendDonationCertificateIssuedEmail,
  sendDonationCertificateRevokedEmail
} from '../../services/donationCertificateEmail.service';

/** Tạo record certificate hoàn chỉnh, chỉ thay đổi trường cần thiết cho từng nhánh gửi email. */
function createCertificate(overrides: Partial<DonationCertificateRecord> = {}): DonationCertificateRecord {
  return {
    certificateId: 'DCP-2026-0123456789ABCDEF0123456789ABCDEF',
    schemaVersion: 1,
    chainId: 80002,
    transactionHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    donorUserId: 'user-1',
    expectedProjectId: 'project-1',
    expectedDonorAddress: '0x1111111111111111111111111111111111111111',
    expectedAmountRaw: '1000',
    expectedIsAnonymous: false,
    firstObservedAt: new Date('2026-08-31T00:00:00.000Z'),
    issuanceStatus: 'ISSUED',
    issuanceEmail: { status: 'NOT_QUEUED', attemptCount: 0 },
    revocationEmail: { status: 'NOT_QUEUED', attemptCount: 0 },
    requestedFinalityMode: 'RPC_FINALIZED',
    allowConfirmationFallback: false,
    finalityCheckCount: 1,
    nextFinalityCheckAt: new Date('2026-08-31T00:00:00.000Z'),
    snapshot: {
      donorName: 'Nguyễn Văn An',
      donorAddress: '0x1111111111111111111111111111111111111111',
      projectId: 'project-1',
      projectName: 'Dự án học bổng',
      organizationName: 'DCP Foundation',
      amountRaw: '1000',
      tokenSymbol: 'DCT',
      tokenDecimals: 0,
      vndEquivalent: '1000',
      valuationPolicy: 'POC_1_DCT_EQUALS_1_VND',
      donatedAt: new Date('2026-08-31T00:00:00.000Z'),
      chainId: 80002,
      networkName: 'Polygon Amoy',
      contractAddress: '0x2222222222222222222222222222222222222222',
      transactionHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      blockNumber: 100,
      blockHash: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd',
      logIndex: 1,
      finalityMode: 'RPC_FINALIZED',
      confirmationsAtIssue: 12
    },
    issuedAt: new Date('2026-08-31T00:02:00.000Z'),
    createdAt: new Date('2026-08-31T00:00:00.000Z'),
    updatedAt: new Date('2026-08-31T00:02:00.000Z'),
    ...overrides
  };
}

describe('donationCertificateEmail.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDonationCertificateConfig.mockReturnValue({
      frontendUrl: 'https://dcp.example',
      explorerTransactionBaseUrl: 'https://explorer.example/tx'
    });
    mocks.renderDonationCertificatePdf.mockResolvedValue(Buffer.from('%PDF-demo'));
  });

  it('không gửi email phát hành khi certificate đã bị thu hồi trước lúc worker xử lý job', async () => {
    mocks.findDonationCertificateById.mockResolvedValue(createCertificate({
      issuanceStatus: 'REVOKED',
      revokedAt: new Date('2026-08-31T00:03:00.000Z')
    }));

    await expect(sendDonationCertificateIssuedEmail('DCP-2026-0123456789ABCDEF0123456789ABCDEF')).resolves.toMatchObject({ success: true });

    expect(mocks.findUserById).not.toHaveBeenCalled();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.updateDonationCertificateEmailState).not.toHaveBeenCalled();
  });

  it('không gửi email đính chính khi certificate chưa chuyển sang trạng thái thu hồi', async () => {
    mocks.findDonationCertificateById.mockResolvedValue(createCertificate());

    await expect(sendDonationCertificateRevokedEmail('DCP-2026-0123456789ABCDEF0123456789ABCDEF')).resolves.toMatchObject({ success: true });

    expect(mocks.findUserById).not.toHaveBeenCalled();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('đánh dấu bỏ qua email cho user chưa xác minh mà không gọi SMTP', async () => {
    const certificate = createCertificate();
    mocks.findDonationCertificateById.mockResolvedValue(certificate);
    mocks.findUserById.mockResolvedValue({ isEmailVerified: false });

    await expect(sendDonationCertificateIssuedEmail(certificate.certificateId)).resolves.toMatchObject({ success: true });

    expect(mocks.updateDonationCertificateEmailState).toHaveBeenCalledWith(
      certificate.certificateId,
      'ISSUANCE',
      'NOT_QUEUED',
      'SKIPPED_UNVERIFIED_EMAIL',
      {}
    );
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('gửi email phát hành kèm PDF và context hiển thị VNĐ cùng phương thức chuyển khoản ngân hàng', async () => {
    const certificate = createCertificate();
    mocks.findDonationCertificateById.mockResolvedValue(certificate);
    mocks.findUserById.mockResolvedValue({ email: 'donor@example.com', isEmailVerified: true });
    mocks.updateDonationCertificateEmailState.mockResolvedValue(true);
    mocks.sendEmail.mockResolvedValue({ success: true, channel: 'EMAIL', providerMessageId: 'message-1' });

    await expect(sendDonationCertificateIssuedEmail(certificate.certificateId)).resolves.toMatchObject({ success: true });

    expect(mocks.renderDonationCertificatePdf).toHaveBeenCalledWith(certificate);
    expect(mocks.sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: 'donor@example.com',
      templateName: 'donation-certificate-issued',
      attachments: [expect.objectContaining({
        filename: expect.stringMatching(/^DCP-Certificate-.*\.pdf$/),
        content: Buffer.from('%PDF-demo'),
        contentType: 'application/pdf'
      })],
      templateContext: expect.objectContaining({
        amountVndFormatted: '1.000',
        currencyCode: 'VNĐ',
        paymentMethodLabel: 'Chuyển khoản ngân hàng'
      })
    }));
  });
});
