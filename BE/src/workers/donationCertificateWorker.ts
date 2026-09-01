import { getDonationCertificateConfig } from '../config/donationCertificateConfig';
import { findCertificatesNeedingReconciliation, findDonationCertificateById } from '../repositories/donationCertificateRepository';
import { getDonationCertificateQueue, closeDonationCertificateQueues, enqueueDonationCertificateJob, moveDonationCertificateJobToDlq, type DonationCertificateJobData } from '../queues/donationCertificateQueue';
import { processDonationCertificateFinalityCheck, reverifyIssuedDonationCertificate } from '../services/donationCertificateIssuance.service';

const EMAIL_RETRY_DELAYS_MS = [30_000, 120_000, 300_000] as const;
const RECONCILIATION_INTERVAL_MS = 60_000;
let reconciliationTimer: NodeJS.Timeout | null = null;

export interface DonationCertificateEmailDelivery { sendIssuedEmail: (certificateId: string) => Promise<{ success: boolean; retryable?: boolean; errorMessage?: string }>; sendRevokedEmail: (certificateId: string) => Promise<{ success: boolean; retryable?: boolean; errorMessage?: string }>; }

/** Tính lần gửi kế tiếp từ trạng thái đã lưu để reconciliation không lặp lại attempt cũ. */
function getNextEmailAttempt(attemptCount: number): 1 | 2 | 3 | 4 {
  return Math.min(attemptCount + 1, 4) as 1 | 2 | 3 | 4;
}

/** Xử lý email job và chỉ retry tối đa ba lần sau lần gửi đầu tiên. */
async function processEmailJob(data: Extract<DonationCertificateJobData, { kind: 'SEND_ISSUED_EMAIL' | 'SEND_REVOKED_EMAIL' }>, emailDelivery: DonationCertificateEmailDelivery): Promise<void> {
  const result = data.kind === 'SEND_ISSUED_EMAIL' ? await emailDelivery.sendIssuedEmail(data.certificateId) : await emailDelivery.sendRevokedEmail(data.certificateId);
  if (result.success || !result.retryable) return;
  if (data.attemptNumber === 4) { await moveDonationCertificateJobToDlq(data); return; }
  const nextAttempt = (data.attemptNumber + 1) as 2 | 3 | 4;
  await enqueueDonationCertificateJob({ kind: data.kind, certificateId: data.certificateId, attemptNumber: nextAttempt }, EMAIL_RETRY_DELAYS_MS[data.attemptNumber - 1]);
}

/** Chạy reconciliation bounded để khôi phục job mất giữa issuance và queue enqueue. */
async function reconcileDonationCertificates(): Promise<void> {
  const records = await findCertificatesNeedingReconciliation(new Date(), 100);
  for (const record of records) {
    if (record.issuanceStatus === 'PENDING_FINALITY') await enqueueDonationCertificateJob({ kind: 'VERIFY_AND_ISSUE', certificateId: record.certificateId, checkSequence: record.finalityCheckCount + 1 }, 0);
    if (record.issuanceStatus === 'ISSUED' && ['NOT_QUEUED', 'RETRYING'].includes(record.issuanceEmail.status)) await enqueueDonationCertificateJob({ kind: 'SEND_ISSUED_EMAIL', certificateId: record.certificateId, attemptNumber: getNextEmailAttempt(record.issuanceEmail.attemptCount) }, 0);
    if (record.issuanceStatus === 'REVOKED' && record.issuedAt && ['NOT_QUEUED', 'RETRYING'].includes(record.revocationEmail.status)) await enqueueDonationCertificateJob({ kind: 'SEND_REVOKED_EMAIL', certificateId: record.certificateId, attemptNumber: getNextEmailAttempt(record.revocationEmail.attemptCount) }, 0);
  }
}

/** Khởi động consumer chỉ trong worker container và chỉ khi feature flag đã bật. */
export function startDonationCertificateWorker(emailDelivery: DonationCertificateEmailDelivery): void {
  if (!getDonationCertificateConfig().enabled || process.env.RUN_WORKERS !== 'true') return;
  const queue = getDonationCertificateQueue();
  if (!queue) return;
  queue.process(async job => {
    const data = job.data;
    if (data.kind === 'VERIFY_AND_ISSUE') return processDonationCertificateFinalityCheck(data.certificateId);
    if (data.kind === 'REVERIFY_ISSUED') return reverifyIssuedDonationCertificate(data.certificateId);
    await processEmailJob(data, emailDelivery);
  });
  if (!reconciliationTimer) reconciliationTimer = setInterval(() => { void reconcileDonationCertificates(); }, RECONCILIATION_INTERVAL_MS);
  void reconcileDonationCertificates();
}

/** Dừng polling và đóng queue để active jobs có cơ hội hoàn tất khi shutdown. */
export async function stopDonationCertificateWorker(): Promise<void> { if (reconciliationTimer) clearInterval(reconciliationTimer); reconciliationTimer = null; await closeDonationCertificateQueues(); }
