import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DonationCertificateVerification from '@/app/donations/verify/[certificateId]/DonationCertificateVerification';
import { fetchDonationCertificate } from '@/app/donations/certificates/services';
import type { DonationCertificatePublicResponse } from '@/app/donations/certificates/types';

vi.mock('@/app/donations/certificates/services', () => ({
  fetchDonationCertificate: vi.fn()
}));

const mockedFetchDonationCertificate = vi.mocked(fetchDonationCertificate);

/** Tạo payload public tối thiểu để kiểm tra các trạng thái hiển thị của trang verify. */
function createCertificateResponse(overrides: Partial<DonationCertificatePublicResponse> = {}): DonationCertificatePublicResponse {
  return {
    certificateId: 'DCP-2026-0123456789ABCDEF0123456789ABCDEF',
    issuanceStatus: 'ISSUED',
    verificationStatus: 'VERIFIED',
    issuedAt: '2026-09-01T03:10:00.000Z',
    revokedAt: null,
    verificationCheckedAt: '2026-09-01T03:10:05.000Z',
    currentConfirmations: 12,
    finalizedBlockNumber: 7123456,
    certificate: {
      donorName: 'Nguyễn Minh An',
      donorAddress: '0x1111111111111111111111111111111111111111',
      projectId: 'demo-project',
      projectName: 'Quỹ học bổng cộng đồng',
      organizationName: 'DCP Foundation',
      amountRaw: '250000',
      tokenSymbol: 'DCT',
      tokenDecimals: 0,
      vndEquivalent: '250000',
      valuationPolicy: 'POC_1_DCT_EQUALS_1_VND',
      donatedAt: '2026-09-01T03:00:00.000Z'
    },
    chain: {
      chainId: 80002,
      networkName: 'Polygon Amoy',
      contractAddress: '0x2222222222222222222222222222222222222222',
      transactionHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      blockNumber: 7123456,
      blockHash: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd',
      logIndex: 3,
      finalityMode: 'RPC_FINALIZED',
      confirmationsAtIssue: 12,
      explorerUrl: 'https://amoy.polygonscan.com/tx/0x123'
    },
    verificationUrl: 'http://localhost:3000/donations/verify/DCP-2026-0123456789ABCDEF0123456789ABCDEF',
    pdfUrl: 'http://localhost:3000/api/donations/certificates/DCP-2026-0123456789ABCDEF0123456789ABCDEF/pdf',
    ...overrides
  };
}

describe('DonationCertificateVerification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('hiển thị trạng thái VERIFIED cùng nút PDF và explorer', async () => {
    mockedFetchDonationCertificate.mockResolvedValue(createCertificateResponse());

    render(<DonationCertificateVerification certificateId="DCP-2026-0123456789ABCDEF0123456789ABCDEF" />);

    expect(await screen.findByText('Đã xác minh on-chain')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Tải PDF' })).toHaveAttribute('href', expect.stringContaining('/api/donations/certificates/'));
    expect(screen.getByRole('link', { name: 'Mở blockchain explorer' })).toHaveAttribute('href', 'https://amoy.polygonscan.com/tx/0x123');
  });

  it('hiển thị PENDING và không cho tải PDF trước finality', async () => {
    mockedFetchDonationCertificate.mockResolvedValue(createCertificateResponse({
      issuanceStatus: 'PENDING_FINALITY',
      verificationStatus: 'PENDING',
      issuedAt: null,
      finalizedBlockNumber: null,
      pdfUrl: null
    }));

    render(<DonationCertificateVerification certificateId="DCP-2026-0123456789ABCDEF0123456789ABCDEF" />);

    expect(await screen.findByText('Đang chờ blockchain finality')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Tải PDF' })).not.toBeInTheDocument();
  });

  it('hiển thị REVOKED và nhãn PDF đã thu hồi', async () => {
    mockedFetchDonationCertificate.mockResolvedValue(createCertificateResponse({
      issuanceStatus: 'REVOKED',
      verificationStatus: 'REVOKED',
      revokedAt: '2026-09-01T04:00:00.000Z'
    }));

    render(<DonationCertificateVerification certificateId="DCP-2026-0123456789ABCDEF0123456789ABCDEF" />);

    expect(await screen.findByText('Chứng nhận đã bị thu hồi')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Tải bản đánh dấu đã thu hồi' })).toBeInTheDocument();
  });

  it('hiển thị thông báo không tìm thấy khi API trả 404', async () => {
    mockedFetchDonationCertificate.mockRejectedValue({ statusCode: 404 });

    render(<DonationCertificateVerification certificateId="DCP-2026-UNKNOWN" />);

    expect(await screen.findByText('Không tìm thấy chứng nhận')).toBeInTheDocument();
  });
});
