import { beforeEach, describe, expect, it, vi } from 'vitest';
import QRCode from 'qrcode';
import type { DonationCertificateRecord } from '../../models/donationCertificateModel';

const mocks = vi.hoisted(() => ({
  getDonationCertificateConfig: vi.fn()
}));

vi.mock('../../config/donationCertificateConfig', () => ({
  getDonationCertificateConfig: mocks.getDonationCertificateConfig
}));

import {
  DonationCertificatePdfError,
  renderDonationCertificatePdf
} from '../../services/donationCertificatePdf.service';

/** Tạo certificate snapshot cố định để các bài test PDF không phụ thuộc cơ sở dữ liệu. */
function createCertificate(overrides: Partial<DonationCertificateRecord> = {}): DonationCertificateRecord {
  return {
    certificateId: 'DCP-CERT-2026-0001',
    schemaVersion: 1,
    chainId: 80002,
    transactionHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    donorUserId: 'user-1',
    expectedProjectId: 'project-1',
    expectedDonorAddress: '0x1111111111111111111111111111111111111111',
    expectedAmountRaw: '250000',
    expectedIsAnonymous: false,
    firstObservedAt: new Date('2026-08-01T03:00:00.000Z'),
    issuanceStatus: 'ISSUED',
    issuanceEmail: { status: 'SENT', attemptCount: 1 },
    revocationEmail: { status: 'NOT_QUEUED', attemptCount: 0 },
    requestedFinalityMode: 'RPC_FINALIZED',
    allowConfirmationFallback: false,
    finalityCheckCount: 1,
    nextFinalityCheckAt: new Date('2026-08-01T03:05:00.000Z'),
    snapshot: {
      donorName: 'Nguyễn Văn An',
      donorAddress: '0x1111111111111111111111111111111111111111',
      projectId: 'project-1',
      projectName: 'Quỹ học bổng cộng đồng',
      organizationName: 'DCP Foundation',
      amountRaw: '250000',
      tokenSymbol: 'DCT',
      tokenDecimals: 0,
      vndEquivalent: '250000',
      valuationPolicy: 'POC_1_DCT_EQUALS_1_VND',
      donatedAt: new Date('2026-08-01T03:00:00.000Z'),
      chainId: 80002,
      networkName: 'Polygon Amoy',
      contractAddress: '0x2222222222222222222222222222222222222222',
      transactionHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      blockNumber: 7123456,
      blockHash: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd',
      logIndex: 3,
      finalityMode: 'RPC_FINALIZED',
      confirmationsAtIssue: 12
    },
    issuedAt: new Date('2026-08-01T03:10:00.000Z'),
    createdAt: new Date('2026-08-01T03:00:00.000Z'),
    updatedAt: new Date('2026-08-01T03:10:00.000Z'),
    ...overrides
  };
}

describe('donationCertificatePdf.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDonationCertificateConfig.mockReturnValue({
      frontendUrl: 'https://dcp.example/'
    });
  });

  it('từ chối certificate chưa có snapshot trước khi tạo QR hoặc PDF', async () => {
    const qrBufferSpy = vi.spyOn(QRCode, 'toBuffer');
    const certificate = createCertificate({ snapshot: undefined });

    await expect(renderDonationCertificatePdf(certificate)).rejects.toEqual(
      expect.objectContaining<DonationCertificatePdfError>({
        name: 'DonationCertificatePdfError',
        message: 'CERTIFICATE_NOT_ISSUED'
      })
    );
    expect(qrBufferSpy).not.toHaveBeenCalled();
  });

  it('từ chối certificate đang chờ finality dù đã có snapshot', async () => {
    const qrBufferSpy = vi.spyOn(QRCode, 'toBuffer');
    const certificate = createCertificate({ issuanceStatus: 'PENDING_FINALITY' });

    await expect(renderDonationCertificatePdf(certificate)).rejects.toBeInstanceOf(DonationCertificatePdfError);
    expect(qrBufferSpy).not.toHaveBeenCalled();
  });

  it('tạo PDF hai trang cho certificate đã phát hành và mã hóa certificate ID trong URL QR', async () => {
    const qrBufferSpy = vi.spyOn(QRCode, 'toBuffer');
    const certificate = createCertificate({ certificateId: 'DCP/CERT 2026' });

    const pdf = await renderDonationCertificatePdf(certificate);

    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
    expect(pdf.toString('latin1')).toContain('/Count 2');
    expect(qrBufferSpy).toHaveBeenCalledWith(
      'https://dcp.example/donations/verify/DCP%2FCERT%202026',
      expect.objectContaining({ errorCorrectionLevel: 'Q', margin: 1, width: 320 })
    );
  });

  it('cho phép render lại certificate đã thu hồi để người dùng đối soát snapshot', async () => {
    const certificate = createCertificate({
      issuanceStatus: 'REVOKED',
      revokedAt: new Date('2026-08-02T03:00:00.000Z'),
      revocationReasonCode: 'BLOCK_HASH_MISMATCH'
    });

    const pdf = await renderDonationCertificatePdf(certificate);

    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
    expect(pdf.length).toBeGreaterThan(10_000);
  });
});
