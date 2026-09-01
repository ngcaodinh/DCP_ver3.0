import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { DonationCertificateRecord } from '../src/models/donationCertificateModel';
import { renderDonationCertificatePdf } from '../src/services/donationCertificatePdf.service';

const PREVIEW_OUTPUT_PATH = path.resolve(process.cwd(), '..', 'output', 'pdf', 'donation-certificate-preview.pdf');

/** Tạo snapshot giả lập cố định để render PDF demo mà không truy cập dữ liệu production. */
function createPreviewCertificate(): DonationCertificateRecord {
  const issuedAt = new Date('2026-09-01T03:10:00.000Z');
  return {
    certificateId: 'DCP-DEMO-2026-0001',
    schemaVersion: 1,
    chainId: 80002,
    transactionHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    donorUserId: 'demo-user',
    expectedProjectId: 'demo-community-scholarship',
    expectedDonorAddress: '0x1111111111111111111111111111111111111111',
    expectedAmountRaw: '250000',
    expectedIsAnonymous: false,
    firstObservedAt: issuedAt,
    issuanceStatus: 'ISSUED',
    issuanceEmail: { status: 'SENT', attemptCount: 1 },
    revocationEmail: { status: 'NOT_QUEUED', attemptCount: 0 },
    requestedFinalityMode: 'RPC_FINALIZED',
    allowConfirmationFallback: false,
    finalityCheckCount: 1,
    nextFinalityCheckAt: issuedAt,
    snapshot: {
      donorName: 'Nguyễn Minh An',
      donorAddress: '0x1111111111111111111111111111111111111111',
      projectId: 'demo-community-scholarship',
      projectName: 'Quỹ học bổng cộng đồng',
      organizationName: 'DCP Foundation',
      amountRaw: '250000',
      tokenSymbol: 'DCT',
      tokenDecimals: 0,
      vndEquivalent: '250000',
      valuationPolicy: 'POC_1_DCT_EQUALS_1_VND',
      donatedAt: new Date('2026-09-01T03:00:00.000Z'),
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
    issuedAt,
    createdAt: issuedAt,
    updatedAt: issuedAt
  };
}

/** Render PDF demo độc lập, bảo đảm URL QR không lấy từ biến môi trường production. */
async function renderPreview(): Promise<void> {
  process.env.DONATION_CERTIFICATE_ENABLED = 'false';
  process.env.FRONTEND_URL = 'https://demo.dcp.local';
  const outputDirectory = path.dirname(PREVIEW_OUTPUT_PATH);
  await mkdir(outputDirectory, { recursive: true });
  const pdfBuffer = await renderDonationCertificatePdf(createPreviewCertificate());
  await writeFile(PREVIEW_OUTPUT_PATH, pdfBuffer);
  console.log(PREVIEW_OUTPUT_PATH);
}

void renderPreview();
