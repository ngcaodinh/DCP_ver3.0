import { findUserById } from '../models/authModel';
import { findDonationCertificateById, updateDonationCertificateEmailState } from '../repositories/donationCertificateRepository';
import { getDonationCertificateConfig } from '../config/donationCertificateConfig';
import { sendEmail } from './email.service';
import { renderDonationCertificatePdf } from './donationCertificatePdf.service';
import type { DeliveryResult } from './types/delivery.types';

const CERTIFICATE_PAYMENT_METHOD = 'Chuyển khoản ngân hàng';
const CERTIFICATE_CURRENCY_CODE = 'VNĐ';

export interface DonationCertificateEmailTemplateContext {
  certificateId: string; statusLabel: string; donorName: string; donorAddress: string; projectId: string; projectName: string; organizationName: string; amountDctFormatted: string; amountVndFormatted: string; currencyCode: string; paymentMethodLabel: string; valuationPolicyLabel: '1 DCT = 1 VNĐ'; donatedAtVietnam: string; donatedAtIso: string; issuedAtVietnam: string; chainId: string; networkName: string; contractAddress: string; transactionHash: string; blockNumber: string; blockHash: string; logIndex: string; finalityModeLabel: string; confirmationsAtIssue: string; explorerUrl: string; verificationUrl: string; pdfUrl: string;
}

/** Tạo URL public cùng origin cấu hình để email không tin Host header hay request input. */
function buildPublicUrl(pathname: string): string { return new URL(pathname, getDonationCertificateConfig().frontendUrl).toString(); }

/** Chuẩn hóa tên file đính kèm để certificate ID không thể tạo đường dẫn ngoài dự kiến. */
function buildCertificatePdfFilename(certificateId: string): string {
  const safeCertificateId = certificateId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || 'certificate';
  return `DCP-Certificate-${safeCertificateId}.pdf`;
}

/** Định dạng thời gian UTC+7 và amount BigInt mà không mất độ chính xác. */
function createTemplateContext(certificateId: string, certificate: NonNullable<Awaited<ReturnType<typeof findDonationCertificateById>>>): DonationCertificateEmailTemplateContext {
  const snapshot = certificate.snapshot!;
  const amountDct = BigInt(snapshot.amountRaw).toLocaleString('vi-VN');
  const amountVnd = BigInt(snapshot.vndEquivalent || snapshot.amountRaw).toLocaleString('vi-VN');
  const vietnamTime = new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false, dateStyle: 'medium', timeStyle: 'medium' }).format(snapshot.donatedAt);
  const issuedAtVietnam = new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false, dateStyle: 'medium', timeStyle: 'medium' }).format(certificate.issuedAt ?? new Date());
  const config = getDonationCertificateConfig();
  return { certificateId, statusLabel: certificate.issuanceStatus === 'REVOKED' ? 'Đã thu hồi' : 'Đã ghi nhận thành công', donorName: snapshot.donorName, donorAddress: snapshot.donorAddress, projectId: snapshot.projectId, projectName: snapshot.projectName, organizationName: snapshot.organizationName, amountDctFormatted: amountDct, amountVndFormatted: amountVnd, currencyCode: CERTIFICATE_CURRENCY_CODE, paymentMethodLabel: CERTIFICATE_PAYMENT_METHOD, valuationPolicyLabel: '1 DCT = 1 VNĐ', donatedAtVietnam: vietnamTime, donatedAtIso: snapshot.donatedAt.toISOString(), issuedAtVietnam, chainId: String(snapshot.chainId), networkName: snapshot.networkName, contractAddress: snapshot.contractAddress, transactionHash: snapshot.transactionHash, blockNumber: String(snapshot.blockNumber), blockHash: snapshot.blockHash, logIndex: String(snapshot.logIndex), finalityModeLabel: snapshot.finalityMode === 'RPC_FINALIZED' ? 'Finalized bởi Polygon PoS' : 'Fallback – 12 confirmations', confirmationsAtIssue: String(snapshot.confirmationsAtIssue), explorerUrl: new URL(snapshot.transactionHash, `${config.explorerTransactionBaseUrl}/`).toString(), verificationUrl: buildPublicUrl(`/donations/verify/${encodeURIComponent(certificateId)}`), pdfUrl: buildPublicUrl(`/api/donations/certificates/${encodeURIComponent(certificateId)}/pdf`) };
}

/** Gửi email certificate theo delivery CAS, bỏ qua user chưa verify email và không dùng unsubscribe. */
async function sendCertificateEmail(certificateId: string, emailKind: 'ISSUANCE' | 'REVOCATION'): Promise<DeliveryResult> {
  const certificate = await findDonationCertificateById(certificateId);
  if (!certificate?.snapshot) return { success: false, channel: 'EMAIL', errorMessage: 'CERTIFICATE_NOT_ISSUED', retryable: false };
  // Trạng thái được kiểm tra lại khi worker chạy để không gửi email phát hành sau reorg/thu hồi.
  if (emailKind === 'ISSUANCE' && certificate.issuanceStatus !== 'ISSUED') return { success: true, channel: 'EMAIL' };
  if (emailKind === 'REVOCATION' && certificate.issuanceStatus !== 'REVOKED') return { success: true, channel: 'EMAIL' };
  const user = await findUserById(certificate.donorUserId);
  if (!user) return { success: false, channel: 'EMAIL', errorMessage: 'USER_NOT_FOUND', retryable: false };
  const statusField = emailKind === 'ISSUANCE' ? certificate.issuanceEmail : certificate.revocationEmail;
  if (statusField.status === 'SENT') return { success: true, channel: 'EMAIL' };
  if (!user.isEmailVerified) {
    await updateDonationCertificateEmailState(certificateId, emailKind, statusField.status, 'SKIPPED_UNVERIFIED_EMAIL', {});
    return { success: true, channel: 'EMAIL' };
  }
  const attemptCount = statusField.attemptCount + 1;
  const claimed = await updateDonationCertificateEmailState(certificateId, emailKind, statusField.status, 'RETRYING', { attemptCount });
  if (!claimed) return { success: true, channel: 'EMAIL' };
  const context = createTemplateContext(certificateId, certificate);
  const pdfBuffer = await renderDonationCertificatePdf(certificate);
  const result = await sendEmail({
    to: user.email,
    templateName: emailKind === 'ISSUANCE' ? 'donation-certificate-issued' : 'donation-certificate-revoked',
    subject: emailKind === 'ISSUANCE' ? `DCP – Giấy xác nhận đóng góp ${certificateId}` : `DCP – Đính chính trạng thái chứng nhận ${certificateId}`,
    templateContext: { ...context },
    attachments: [{ filename: buildCertificatePdfFilename(certificateId), content: pdfBuffer, contentType: 'application/pdf' }],
    includeUnsubscribeLink: false
  });
  await updateDonationCertificateEmailState(certificateId, emailKind, 'RETRYING', result.success ? 'SENT' : attemptCount >= 4 || !result.retryable ? 'FAILED' : 'RETRYING', { attemptCount, ...(result.success ? { acceptedAt: new Date(), providerMessageId: result.providerMessageId } : { lastErrorCode: result.errorMessage?.slice(0, 120) }) });
  return result;
}

/** Gửi email phát hành certificate sau finality. */
export async function sendDonationCertificateIssuedEmail(certificateId: string): Promise<DeliveryResult> { return sendCertificateEmail(certificateId, 'ISSUANCE'); }

/** Gửi email đính chính khi certificate đã phát hành bị reorg/thu hồi. */
export async function sendDonationCertificateRevokedEmail(certificateId: string): Promise<DeliveryResult> { return sendCertificateEmail(certificateId, 'REVOCATION'); }
