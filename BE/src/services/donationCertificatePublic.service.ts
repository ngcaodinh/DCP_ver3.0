import { getDonationCertificateConfig } from '../config/donationCertificateConfig';
import type { DonationCertificatePublicResponse, PublicCertificateVerificationStatus } from '../models/donationCertificateModel';
import { findDonationCertificateById } from '../repositories/donationCertificateRepository';
import { reverifyIssuedDonationCertificate } from './donationCertificateIssuance.service';

const CERTIFICATE_ID_PATTERN = /^DCP-\d{4}-[A-F0-9]{32}$/;

/** Xây explorer URL từ snapshot đã phát hành và base URL cấu hình an toàn. */
function buildExplorerUrl(transactionHash: string): string { const config = getDonationCertificateConfig(); return new URL(transactionHash, `${config.explorerTransactionBaseUrl}/`).toString(); }

/** Chiếu record nội bộ sang public allowlist, tuyệt đối không trải object Mongo ra response. */
function projectPublicCertificate(certificate: NonNullable<Awaited<ReturnType<typeof findDonationCertificateById>>>, verificationStatus: PublicCertificateVerificationStatus): DonationCertificatePublicResponse {
  const snapshot = certificate.snapshot;
  const verificationUrl = new URL(`/donations/verify/${encodeURIComponent(certificate.certificateId)}`, getDonationCertificateConfig().frontendUrl).toString();
  return {
    certificateId: certificate.certificateId, issuanceStatus: certificate.issuanceStatus, verificationStatus,
    issuedAt: certificate.issuedAt?.toISOString() ?? null, revokedAt: certificate.revokedAt?.toISOString() ?? null,
    verificationCheckedAt: new Date().toISOString(), currentConfirmations: null, finalizedBlockNumber: null,
    certificate: snapshot ? { donorName: snapshot.donorName, donorAddress: snapshot.donorAddress, projectId: snapshot.projectId, projectName: snapshot.projectName, organizationName: snapshot.organizationName, amountRaw: snapshot.amountRaw, tokenSymbol: 'DCT', tokenDecimals: 0, vndEquivalent: snapshot.vndEquivalent, valuationPolicy: 'POC_1_DCT_EQUALS_1_VND', donatedAt: snapshot.donatedAt.toISOString() } : null,
    chain: snapshot ? { chainId: snapshot.chainId, networkName: snapshot.networkName, contractAddress: snapshot.contractAddress, transactionHash: snapshot.transactionHash, blockNumber: snapshot.blockNumber, blockHash: snapshot.blockHash, logIndex: snapshot.logIndex, finalityMode: snapshot.finalityMode, confirmationsAtIssue: snapshot.confirmationsAtIssue, explorerUrl: buildExplorerUrl(snapshot.transactionHash) } : null,
    verificationUrl, pdfUrl: ['ISSUED', 'REVOKED'].includes(certificate.issuanceStatus) ? new URL(`/api/donations/certificates/${encodeURIComponent(certificate.certificateId)}/pdf`, getDonationCertificateConfig().frontendUrl).toString() : null
  };
}

/** Trả public verification state sau khi tái kiểm tra live khi certificate đã phát hành. */
export async function getPublicDonationCertificate(certificateId: string): Promise<DonationCertificatePublicResponse | null> {
  if (!CERTIFICATE_ID_PATTERN.test(certificateId)) return null;
  const certificate = await findDonationCertificateById(certificateId);
  if (!certificate) return null;
  if (certificate.issuanceStatus === 'PENDING_FINALITY') return projectPublicCertificate(certificate, 'PENDING');
  if (certificate.issuanceStatus === 'BLOCKED') return projectPublicCertificate(certificate, 'UNAVAILABLE');
  if (certificate.issuanceStatus === 'REVOKED') return projectPublicCertificate(certificate, 'REVOKED');
  const result = await reverifyIssuedDonationCertificate(certificateId);
  if (result === 'REVOKED') { const revoked = await findDonationCertificateById(certificateId); return revoked ? projectPublicCertificate(revoked, 'REVOKED') : null; }
  return projectPublicCertificate(certificate, result === 'UNAVAILABLE' ? 'UNAVAILABLE' : 'VERIFIED');
}

export { CERTIFICATE_ID_PATTERN };
