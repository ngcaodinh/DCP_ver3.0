import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DonationCertificateRecord } from '../../models/donationCertificateModel';

const mocks = vi.hoisted(() => ({
  getDonationCertificateConfig: vi.fn(),
  findDonationCertificateById: vi.fn(),
  reverifyIssuedDonationCertificate: vi.fn()
}));

vi.mock('../../config/donationCertificateConfig', () => ({
  getDonationCertificateConfig: mocks.getDonationCertificateConfig
}));
vi.mock('../../repositories/donationCertificateRepository', () => ({
  findDonationCertificateById: mocks.findDonationCertificateById
}));
vi.mock('../../services/donationCertificateIssuance.service', () => ({
  reverifyIssuedDonationCertificate: mocks.reverifyIssuedDonationCertificate
}));

import { getPublicDonationCertificate } from '../../services/donationCertificatePublic.service';

const CERTIFICATE_ID = 'DCP-2026-0123456789ABCDEF0123456789ABCDEF';

/** Tạo record ISSUED đầy đủ để kiểm thử cache và trạng thái public. */
function createCertificate(overrides: Partial<DonationCertificateRecord> = {}): DonationCertificateRecord {
  return {
    certificateId: CERTIFICATE_ID,
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
    issuanceEmail: { status: 'SENT', attemptCount: 1 },
    revocationEmail: { status: 'NOT_QUEUED', attemptCount: 0 },
    requestedFinalityMode: 'RPC_FINALIZED',
    allowConfirmationFallback: false,
    finalityCheckCount: 1,
    nextFinalityCheckAt: new Date('2026-08-31T00:00:00.000Z'),
    snapshot: {
      donorName: 'Nguyễn Văn An',
      donorAddress: '0x1111111111111111111111111111111111111111',
      projectId: 'project-1',
      projectName: 'Project One',
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
      logIndex: 0,
      finalityMode: 'RPC_FINALIZED',
      confirmationsAtIssue: 12
    },
    issuedAt: new Date('2026-08-31T00:02:00.000Z'),
    createdAt: new Date('2026-08-31T00:00:00.000Z'),
    updatedAt: new Date('2026-08-31T00:02:00.000Z'),
    ...overrides
  };
}

describe('donationCertificatePublic.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDonationCertificateConfig.mockReturnValue({
      frontendUrl: 'https://dcp.example',
      explorerTransactionBaseUrl: 'https://explorer.example/tx'
    });
    mocks.reverifyIssuedDonationCertificate.mockResolvedValue('VERIFIED');
  });

  it('không gọi RPC reverify khi cửa sổ reorg đã được chốt', async () => {
    mocks.findDonationCertificateById.mockResolvedValue(createCertificate({ reverificationCompletedAt: new Date() }));

    const result = await getPublicDonationCertificate(CERTIFICATE_ID);

    expect(result).toMatchObject({ verificationStatus: 'VERIFIED', certificateId: CERTIFICATE_ID });
    expect(mocks.reverifyIssuedDonationCertificate).not.toHaveBeenCalled();
  });

  it('dùng snapshot trong TTL ngắn sau lần verify thành công gần nhất', async () => {
    mocks.findDonationCertificateById.mockResolvedValue(createCertificate({ lastVerificationAt: new Date(Date.now() - 1_000) }));

    const result = await getPublicDonationCertificate(CERTIFICATE_ID);

    expect(result?.verificationStatus).toBe('VERIFIED');
    expect(mocks.reverifyIssuedDonationCertificate).not.toHaveBeenCalled();
  });

  it('reverify live khi snapshot đã quá TTL và trả VERIFIED nếu canonical chain vẫn đúng', async () => {
    mocks.findDonationCertificateById.mockResolvedValue(createCertificate({ lastVerificationAt: new Date(Date.now() - 31_000) }));

    const result = await getPublicDonationCertificate(CERTIFICATE_ID);

    expect(result?.verificationStatus).toBe('VERIFIED');
    expect(mocks.reverifyIssuedDonationCertificate).toHaveBeenCalledWith(CERTIFICATE_ID);
  });

  it('trả UNAVAILABLE khi live reverify tạm thời không truy cập được RPC', async () => {
    mocks.findDonationCertificateById.mockResolvedValue(createCertificate({ lastVerificationAt: new Date(Date.now() - 31_000) }));
    mocks.reverifyIssuedDonationCertificate.mockResolvedValue('UNAVAILABLE');

    const result = await getPublicDonationCertificate(CERTIFICATE_ID);

    expect(result?.verificationStatus).toBe('UNAVAILABLE');
  });

  it('reload record đã REVOKED sau khi live reverify phát hiện reorg', async () => {
    mocks.findDonationCertificateById
      .mockResolvedValueOnce(createCertificate({ lastVerificationAt: new Date(Date.now() - 31_000) }))
      .mockResolvedValueOnce(createCertificate({ issuanceStatus: 'REVOKED', revokedAt: new Date() }));
    mocks.reverifyIssuedDonationCertificate.mockResolvedValue('REVOKED');

    const result = await getPublicDonationCertificate(CERTIFICATE_ID);

    expect(result?.verificationStatus).toBe('REVOKED');
    expect(mocks.findDonationCertificateById).toHaveBeenCalledTimes(2);
  });
});
