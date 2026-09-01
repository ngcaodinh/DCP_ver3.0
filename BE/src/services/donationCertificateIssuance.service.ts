import { getDonationCertificateConfig } from '../config/donationCertificateConfig';
import type { DonationCertificateFinalityMode, DonationCertificateRecord } from '../models/donationCertificateModel';
import { claimDonationCertificateIssuance, findDonationCertificateById, markDonationCertificateBlocked, markDonationCertificateRevoked, markDonationCertificateReverificationCompleted, markDonationCertificateVerified, scheduleDonationCertificateFinalityCheck, switchDonationCertificateToConfirmationFallback, upsertPendingDonationCertificate } from '../repositories/donationCertificateRepository';
import { enqueueDonationCertificateJob } from '../queues/donationCertificateQueue';
import { verifyDonationCertificateFinality } from './donationCertificateFinality.service';

export interface DonationCertificateReference { certificateId: string; issuanceStatus: 'PENDING_FINALITY' | 'ISSUED' | 'REVOKED' | 'BLOCKED'; finalityMode: DonationCertificateFinalityMode; fallbackConfirmations: 12; verificationUrl: string; }

/** Xây URL verify hoàn toàn từ FRONTEND_URL đã validate, không lấy Host từ request. */
function buildVerificationUrl(certificateId: string): string { return new URL(`/donations/verify/${encodeURIComponent(certificateId)}`, getDonationCertificateConfig().frontendUrl).toString(); }

/** Tạo candidate chỉ cho donation public của account đã liên kết và nằm sau feature start. */
export async function createDonationCertificateCandidate(input: { transactionHash: string; donorUserId: string; expectedProjectId: string; expectedDonorAddress: string; expectedAmountRaw: string; expectedIsAnonymous: false; observedAt: Date }): Promise<DonationCertificateReference | null> {
  const config = getDonationCertificateConfig();
  if (!config.enabled || input.observedAt < config.startAt) return null;
  const requestedMode: DonationCertificateFinalityMode = config.preferredFinalityMode === 'CONFIRMATIONS' ? 'CONFIRMATION_FALLBACK' : 'RPC_FINALIZED';
  const { record, created } = await upsertPendingDonationCertificate({ transactionHash: input.transactionHash, donorUserId: input.donorUserId, expectedProjectId: input.expectedProjectId, expectedDonorAddress: input.expectedDonorAddress, expectedAmountRaw: input.expectedAmountRaw, expectedIsAnonymous: false, firstObservedAt: input.observedAt, chainId: config.chainId, requestedFinalityMode: requestedMode, allowConfirmationFallback: config.preferredFinalityMode === 'AUTO' });
  if (created) await enqueueDonationCertificateJob({ kind: 'VERIFY_AND_ISSUE', certificateId: record.certificateId, checkSequence: 1 }, 0);
  return { certificateId: record.certificateId, issuanceStatus: record.issuanceStatus, finalityMode: record.requestedFinalityMode, fallbackConfirmations: 12, verificationUrl: buildVerificationUrl(record.certificateId) };
}

/** Xử lý một lần finality check và chỉ enqueue email sau CAS issuance thắng. */
export async function processDonationCertificateFinalityCheck(certificateId: string): Promise<'PENDING' | 'ISSUED' | 'REVOKED' | 'BLOCKED'> {
  const certificate = await findDonationCertificateById(certificateId);
  if (!certificate || certificate.issuanceStatus !== 'PENDING_FINALITY') return certificate?.issuanceStatus === 'ISSUED' ? 'ISSUED' : certificate?.issuanceStatus === 'REVOKED' ? 'REVOKED' : 'BLOCKED';
  const verdict = await verifyDonationCertificateFinality({ transactionHash: certificate.transactionHash, donorUserId: certificate.donorUserId, expectedProjectId: certificate.expectedProjectId, expectedDonorAddress: certificate.expectedDonorAddress, expectedAmountRaw: certificate.expectedAmountRaw, expectedIsAnonymous: false, requestedMode: certificate.requestedFinalityMode });
  const config = getDonationCertificateConfig();
  if (verdict.status === 'PENDING' || verdict.status === 'UNAVAILABLE') { await scheduleDonationCertificateFinalityCheck(certificateId, new Date(Date.now() + (verdict.status === 'UNAVAILABLE' ? verdict.retryAfterMs : config.pollIntervalMs)), verdict.status === 'UNAVAILABLE' ? verdict.errorCode : undefined); await enqueueDonationCertificateJob({ kind: 'VERIFY_AND_ISSUE', certificateId, checkSequence: certificate.finalityCheckCount + 2 }, config.pollIntervalMs); return 'PENDING'; }
  if (verdict.status === 'FINALIZED_TAG_UNSUPPORTED') { const switched = certificate.allowConfirmationFallback ? await switchDonationCertificateToConfirmationFallback(certificateId) : null; if (switched) { await enqueueDonationCertificateJob({ kind: 'VERIFY_AND_ISSUE', certificateId, checkSequence: certificate.finalityCheckCount + 2 }, 0); return 'PENDING'; } await markDonationCertificateBlocked(certificateId, 'INVALID_CONFIGURATION', new Date()); return 'BLOCKED'; }
  if (verdict.status === 'BLOCKED') { await markDonationCertificateBlocked(certificateId, verdict.reasonCode, new Date()); return 'BLOCKED'; }
  if (verdict.status === 'REVOKED') { await markDonationCertificateRevoked(certificateId, verdict.reasonCode, new Date()); return 'REVOKED'; }
  const issued = await claimDonationCertificateIssuance(certificateId, verdict.snapshot, new Date(), verdict.snapshot.blockNumber + 256);
  if (issued) await enqueueDonationCertificateJob({ kind: 'SEND_ISSUED_EMAIL', certificateId, attemptNumber: 1 }, 0);
  return 'ISSUED';
}

/** Đối chiếu certificate đã phát hành bằng snapshot bất biến để phát hiện reorg canonical. */
export async function reverifyIssuedDonationCertificate(certificateId: string): Promise<'VERIFIED' | 'REVOKED' | 'UNAVAILABLE'> {
  const certificate = await findDonationCertificateById(certificateId);
  if (!certificate?.snapshot || certificate.issuanceStatus !== 'ISSUED') return certificate?.issuanceStatus === 'REVOKED' ? 'REVOKED' : 'UNAVAILABLE';
  const snapshot = certificate.snapshot;
  const verdict = await verifyDonationCertificateFinality({ transactionHash: snapshot.transactionHash, donorUserId: certificate.donorUserId, expectedProjectId: snapshot.projectId, expectedDonorAddress: snapshot.donorAddress, expectedAmountRaw: snapshot.amountRaw, expectedIsAnonymous: false, requestedMode: snapshot.finalityMode });
  if (verdict.status === 'REVOKED') { const revoked = await markDonationCertificateRevoked(certificateId, verdict.reasonCode, new Date()); if (revoked?.issuedAt) await enqueueDonationCertificateJob({ kind: 'SEND_REVOKED_EMAIL', certificateId, attemptNumber: 1 }, 0); return 'REVOKED'; }
  if (verdict.status !== 'VERIFIED') return 'UNAVAILABLE';
  await markDonationCertificateVerified(certificateId, new Date());
  return 'VERIFIED';
}

/** Chốt certificate đã qua cửa sổ reorg để public verify chỉ dùng snapshot bất biến. */
export async function completeDonationCertificateReverificationWindow(certificateId: string): Promise<void> {
  await markDonationCertificateReverificationCompleted(certificateId, new Date());
}
