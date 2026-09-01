export type DonationCertificateFinalityMode = 'RPC_FINALIZED' | 'CONFIRMATION_FALLBACK';
export type DonationCertificateIssuanceStatus = 'PENDING_FINALITY' | 'ISSUED' | 'REVOKED' | 'BLOCKED';
export type PublicCertificateVerificationStatus = 'PENDING' | 'VERIFIED' | 'REVOKED' | 'UNAVAILABLE';

export interface DonationCertificatePublicResponse {
  certificateId: string; issuanceStatus: DonationCertificateIssuanceStatus; verificationStatus: PublicCertificateVerificationStatus; issuedAt: string | null; revokedAt: string | null; verificationCheckedAt: string; currentConfirmations: number | null; finalizedBlockNumber: number | null;
  certificate: { donorName: string; donorAddress: string; projectId: string; projectName: string; organizationName: string; amountRaw: string; tokenSymbol: 'DCT'; tokenDecimals: 0; vndEquivalent: string; valuationPolicy: 'POC_1_DCT_EQUALS_1_VND'; donatedAt: string } | null;
  chain: { chainId: number; networkName: string; contractAddress: string; transactionHash: string; blockNumber: number; blockHash: string; logIndex: number; finalityMode: DonationCertificateFinalityMode; confirmationsAtIssue: number; explorerUrl: string } | null;
  verificationUrl: string; pdfUrl: string | null;
}
