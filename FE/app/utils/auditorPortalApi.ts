import { buildSameOriginApiUrl, fetchApi } from './apiClient';

export type AuditorWalletLock = 'UNSTAKING' | 'WITHDRAWING' | 'PAYOUT_IN_FLIGHT' | 'DEBT_SETTLING' | 'ACCOUNT_UPDATING';
export type AuditorPayoutStatus = 'PENDING' | 'TRANSFERRING' | 'TRANSFERRED' | 'BURNED' | 'FAILED' | 'MANUAL_REVIEW' | 'CANCELLED';
export interface EvidencePhoto { cid: string; capturedAt: string; gps: { latitude: number; longitude: number }; accuracyMeters: number; isLowAccuracyOverride: boolean; lowAccuracyReason: string | null; }
export interface AuditorStakeOverview { onchain: { stakedBalance: string; minimumStakeThreshold: string; pendingWithdrawAmount: string; unbondingReleaseAt: string | null; unbondingPeriodSeconds: string } | null; onchainError: string | null; guard: { walletLock: AuditorWalletLock | null; lockedAt: string | null; penaltyDebtVnd: number; openCaseCount: number }; payoutAccount: { bankName: string; bankAccountNumberMasked: string; accountHolderName: string; branchName: string | null } | null; accountStatus: string | null; suspendedReasonCode: string | null; exitEligibility: { eligible: boolean; reasons: Array<{ code: 'OPEN_DISPUTE' | 'PENALTY_DEBT' | 'ACTIVE_PROJECT_TIES'; message: string; projectTies?: Array<{ projectId: string; projectName: string; status: string }> }> } | null; }
export type AuditorDepositStatus = 'PENDING_PAYMENT' | 'PAYMENT_CONFIRMED' | 'MINT_COMPLETED' | 'FAILED';
export interface AuditorDepositCreateResult { orderCode: string; paymentUrl: string; status: 'PENDING_PAYMENT'; }
export interface AuditorDepositStatusResult { status: AuditorDepositStatus; paymentUrl?: string; paymentExpiredAt?: string; failureReason?: string | null; isPaymentConfirmedButMintFailed?: boolean; }
export interface AuditorEarnings { claimableRewardVnd: number; ledgerEntries: Array<{ ledgerId: string; entryType: 'REWARD' | 'PENALTY'; amount: string; status: string; reasonCode: string; createdAt: string }>; payouts: Array<{ payoutId: string; payoutType: 'REWARD' | 'STAKE_WITHDRAWAL'; status: AuditorPayoutStatus; amountVnd: number; feeVnd: number; netAmountVnd: number; bankSnapshot: { bankName: string; bankAccountNumberMasked: string; accountHolderName: string }; errorMessage: string | null; createdAt: string }>; }
export interface AuditorFieldReportHistoryItem { reportId: string; projectId: string; projectName: string; note: string; verifiedMilestoneIndexes: number[]; photos: EvidencePhoto[]; submittedAt: string; }
export interface AuditorListingRecord { kind: 'CONFIRMED' | 'CHALLENGE'; recordId: string; projectId: string; projectName: string; round: number; submittedAt: string; photos: EvidencePhoto[]; note: string | null; reason: string | null; arbitration: { status: 'PENDING' | 'RESOLVED'; verdict: 'UPHOLD_PROJECT' | 'REJECT_PROJECT' | 'NO_CONSENSUS' | 'TIMEOUT' | null; deadlineAt: string; resolvedAt: string | null; isMarkedAbusive: boolean } | null; }
export interface AuditorEvidenceSubmissionPhoto { contentBase64: string; mimeType: 'image/jpeg'; fileName: string; gps: { latitude: number; longitude: number }; accuracyMeters: number; capturedAtClient: string; geolocationTimestamp: string; lowAccuracyOverride: boolean; overrideUnlockedAfterMs: number | null; lowAccuracyReason: string | null; }

/** Chuẩn hóa response phẳng của API deposit và envelope chuẩn để portal không mất paymentUrl khi tạo phiếu PayOS. */
function getDepositResponsePayload(response: unknown): Record<string, unknown> {
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    throw new Error('Phản hồi phiếu nạp không hợp lệ.');
  }

  const responseRecord = response as Record<string, unknown>;
  const responseData = responseRecord.data;
  if (responseData && typeof responseData === 'object' && !Array.isArray(responseData)) {
    return responseData as Record<string, unknown>;
  }

  return responseRecord;
}

/** Kiểm tra trạng thái deposit trước khi UI sử dụng để đối soát hoặc cập nhật số dư. */
function isAuditorDepositStatus(value: unknown): value is AuditorDepositStatus {
  return value === 'PENDING_PAYMENT'
    || value === 'PAYMENT_CONFIRMED'
    || value === 'MINT_COMPLETED'
    || value === 'FAILED';
}
/** Tạo header xác thực tối thiểu cho API portal. */
function authorizationHeaders(accessToken: string): HeadersInit {
  const normalizedToken = accessToken.trim().replace(/^Bearer\s+/i, '');
  return normalizedToken ? { Authorization: `Bearer ${normalizedToken}` } : {};
}
/** Đọc tổng quan cọc và tài khoản nhận tiền của Auditor. */
export async function getAuditorStakeOverview(accessToken: string): Promise<AuditorStakeOverview> { return (await fetchApi<AuditorStakeOverview>(buildSameOriginApiUrl('/api/auditor-onboarding/stake-overview'), { headers: authorizationHeaders(accessToken) })).data; }
/** Đọc số dư VND chính xác của Smart Account để tính khoản nạp bù cho mức cọc. */
/** Đọc số dư token từ endpoint deposit (endpoint này hiện trả payload phẳng thay vì envelope chuẩn). */
export async function getAuditorWalletTokenBalance(accessToken: string): Promise<string> {
  const response = await fetchApi<{ tokenBalance?: unknown; data?: { tokenBalance?: unknown } }>(buildSameOriginApiUrl('/api/deposit/balance'), { headers: authorizationHeaders(accessToken) });
  const responseRecord = response as unknown as { tokenBalance?: unknown; data?: { tokenBalance?: unknown } };
  const tokenBalance = responseRecord.data?.tokenBalance ?? responseRecord.tokenBalance;
  if (typeof tokenBalance !== 'string' || !/^\d+$/.test(tokenBalance)) {
    throw new Error('Phản hồi số dư Smart Account không hợp lệ.');
  }
  return tokenBalance;
}
/** Tạo phiếu PayOS quay lại cổng Auditor sau khi thanh toán khoản nạp bù tiền cọc. */
export async function createAuditorPortalDeposit(accessToken: string, amountVnd: number): Promise<AuditorDepositCreateResult> {
  const response = await fetchApi<unknown>(buildSameOriginApiUrl('/api/deposit/create'), {
    method: 'POST',
    headers: authorizationHeaders(accessToken),
    body: JSON.stringify({ amountVnd, paymentFlow: 'AUDITOR_PORTAL' })
  });
  const payload = getDepositResponsePayload(response);

  if (typeof payload.orderCode !== 'string' || !/^\d{1,20}$/.test(payload.orderCode)
    || typeof payload.paymentUrl !== 'string' || payload.status !== 'PENDING_PAYMENT') {
    throw new Error('Phản hồi tạo phiếu nạp không hợp lệ.');
  }

  return {
    orderCode: payload.orderCode,
    paymentUrl: payload.paymentUrl,
    status: payload.status
  };
}
/** Đối soát phiếu PayOS thuộc Auditor hiện tại trước khi cho phép đặt cọc bù. */
export async function getAuditorPortalDepositStatus(accessToken: string, orderCode: string): Promise<AuditorDepositStatusResult> {
  const response = await fetchApi<unknown>(
    buildSameOriginApiUrl(`/api/deposit/${encodeURIComponent(orderCode)}?reconcile=true`),
    { headers: authorizationHeaders(accessToken) }
  );
  const payload = getDepositResponsePayload(response);

  if (!isAuditorDepositStatus(payload.status)
    || (payload.paymentUrl !== undefined && typeof payload.paymentUrl !== 'string')
    || (payload.paymentExpiredAt !== undefined && typeof payload.paymentExpiredAt !== 'string')
    || (payload.failureReason !== undefined && payload.failureReason !== null && typeof payload.failureReason !== 'string')
    || (payload.isPaymentConfirmedButMintFailed !== undefined && typeof payload.isPaymentConfirmedButMintFailed !== 'boolean')) {
    throw new Error('Phản hồi trạng thái phiếu nạp không hợp lệ.');
  }

  return {
    status: payload.status,
    paymentUrl: payload.paymentUrl,
    paymentExpiredAt: payload.paymentExpiredAt,
    failureReason: payload.failureReason,
    isPaymentConfirmedButMintFailed: payload.isPaymentConfirmedButMintFailed
  };
}
/** Đọc sổ thưởng phạt và các payout đã che PII. */
export async function getAuditorEarnings(accessToken: string): Promise<AuditorEarnings> { return (await fetchApi<AuditorEarnings>(buildSameOriginApiUrl('/api/auditor-onboarding/earnings?limit=50'), { headers: authorizationHeaders(accessToken) })).data; }
/** Đọc các biên bản hiện trường do chính Auditor đã nộp. */
export async function getAuditorFieldReports(accessToken: string): Promise<AuditorFieldReportHistoryItem[]> { return (await fetchApi<AuditorFieldReportHistoryItem[]>(buildSameOriginApiUrl('/api/project-governance/auditor/my-field-reports?limit=50'), { headers: authorizationHeaders(accessToken) })).data; }
/** Đọc lịch sử xác minh đã trộn giữa xác nhận và khiếu nại. */
export async function getAuditorListingRecords(accessToken: string): Promise<AuditorListingRecord[]> { return (await fetchApi<AuditorListingRecord[]>(buildSameOriginApiUrl('/api/project-governance/auditor/my-listing-records?limit=50'), { headers: authorizationHeaders(accessToken) })).data; }
/** Ghi kết luận dự án đúng sự thật với evidence camera bắt buộc. */
export async function submitAuditorListingVerification(accessToken: string, payload: { projectId: string; note?: string; clientSubmittedAt: string; photos: AuditorEvidenceSubmissionPhoto[] }): Promise<void> { await fetchApi(buildSameOriginApiUrl('/api/project-governance/auditor/listing-verification'), { method: 'POST', headers: authorizationHeaders(accessToken), body: JSON.stringify(payload) }); }
/** Cập nhật tài khoản nhận tiền mà không gửi bankCode do backend tự suy diễn. */
export async function updateAuditorPayoutAccount(accessToken: string, input: { bankName: string; bankAccountNumber: string; accountHolderName: string; branchName?: string }): Promise<void> { await fetchApi(buildSameOriginApiUrl('/api/auditor-onboarding/payout-account'), { method: 'PATCH', headers: authorizationHeaders(accessToken), body: JSON.stringify(input) }); }
