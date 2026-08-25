import { buildApiUrl, fetchApi, type ApiErrorResponse } from './apiClient';

export type AuditorPayoutAccountInput = {
  bankName: string;
  bankAccountNumber: string;
  accountHolderName: string;
  branchName?: string;
};

export type AuditorOnboardingStatus = 'PENDING_TX' | 'VERIFYING' | 'ACTIVATED' | 'FAILED';
export type AuditorOnboardingErrorCode = ApiErrorResponse['errorCode']
  | 'INTENT_NOT_FOUND' | 'ALREADY_SUBMITTED' | 'EMAIL_EXISTS'
  | 'INSUFFICIENT_TOKEN_BALANCE' | 'PAYMASTER_POLICY_MISMATCH'
  | 'AUDITOR_ONBOARDING_NOT_FOUND' | 'ALREADY_AUDITOR' | 'ONBOARDING_RESUME_UNAVAILABLE';

export type AuditorOnboardingApiError = ApiErrorResponse & { errorCode: AuditorOnboardingErrorCode };

export type RegisterAuditorIntentResult = {
  intentId: string;
  minimumStakeThreshold: string;
  currentTokenBalance: string;
  walletAddress: string;
  accessToken: string;
  refreshToken: string;
  csrfToken: string;
  refreshSessionId: string;
  expiresAt: string;
  correlationId: string;
};

export type AuditorOnboardingStatusResult = {
  status: AuditorOnboardingStatus;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Kiểm tra chuỗi bắt buộc trước khi dữ liệu API được dùng để lưu phiên hoặc điều khiển luồng UI. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Chỉ chấp nhận số nguyên DCT không âm để các phép so sánh BigInt ở UI luôn an toàn. */
function isNonNegativeIntegerString(value: unknown): value is string {
  return typeof value === 'string' && /^\d+$/.test(value);
}

/** Xác thực dữ liệu intent trước khi persist token và dùng số dư từ response để điều khiển giao dịch cọc. */
function isRegisterAuditorIntentResult(value: unknown): value is RegisterAuditorIntentResult {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const result = value as Record<string, unknown>;
  return isNonEmptyString(result.intentId)
    && isNonNegativeIntegerString(result.minimumStakeThreshold)
    && isNonNegativeIntegerString(result.currentTokenBalance)
    && isNonEmptyString(result.walletAddress)
    && isNonEmptyString(result.accessToken)
    && isNonEmptyString(result.refreshToken)
    && isNonEmptyString(result.csrfToken)
    && isNonEmptyString(result.refreshSessionId)
    && isNonEmptyString(result.expiresAt)
    && isNonEmptyString(result.correlationId);
}

/** Tạo lỗi contract thống nhất khi API trả HTTP thành công nhưng data không đáp ứng schema của frontend. */
function createInvalidAuditorIntentResponseError(): AuditorOnboardingApiError {
  return {
    success: false,
    message: 'Phản hồi tạo hồ sơ Kiểm toán viên không hợp lệ.',
    errorCode: 'INVALID_RESPONSE'
  };
}

function authorizationHeaders(accessToken: string): HeadersInit {
  return { Authorization: `Bearer ${accessToken}` };
}

export async function registerAuditorIntent(input: {
  identityToken: string;
  fullName?: string;
  payoutAccount: AuditorPayoutAccountInput;
}): Promise<RegisterAuditorIntentResult> {
  const response = await fetchApi<RegisterAuditorIntentResult>(buildApiUrl('/api/auditor-onboarding/register'), {
    method: 'POST', body: JSON.stringify(input)
  });
  if (!isRegisterAuditorIntentResult(response.data)) {
    throw createInvalidAuditorIntentResponseError();
  }

  return response.data;
}

/** Khôi phục intent Auditor đang chờ cọc sau khi người dùng xác thực lại đúng tài khoản Google. */
export async function resumeAuditorIntent(input: {
  identityToken: string;
}): Promise<RegisterAuditorIntentResult> {
  const response = await fetchApi<RegisterAuditorIntentResult>(buildApiUrl('/api/auditor-onboarding/resume'), {
    method: 'POST', body: JSON.stringify(input)
  });
  if (!isRegisterAuditorIntentResult(response.data)) {
    throw createInvalidAuditorIntentResponseError();
  }

  return response.data;
}

export async function executeAuditorStake(accessToken: string): Promise<{ status: 'VERIFYING'; txHash: string }> {
  const response = await fetchApi<{ status: 'VERIFYING'; txHash: string }>(buildApiUrl('/api/auditor-onboarding/stake'), {
    method: 'POST', headers: authorizationHeaders(accessToken), body: '{}'
  });
  return response.data;
}

export async function requestAuditorUnstake(accessToken: string, amount: string): Promise<{ txHash: string; releaseAt: string; previousReleaseAt: string | null }> {
  const response = await fetchApi<{ txHash: string; releaseAt: string; previousReleaseAt: string | null }>(buildApiUrl('/api/auditor-onboarding/unstake'), {
    method: 'POST', headers: authorizationHeaders(accessToken), body: JSON.stringify({ amount })
  });
  return response.data;
}

export async function withdrawAuditorStake(accessToken: string): Promise<{ txHash: string; payoutId: string }> {
  const response = await fetchApi<{ txHash: string; payoutId: string }>(buildApiUrl('/api/auditor-onboarding/withdraw'), {
    method: 'POST', headers: authorizationHeaders(accessToken), body: '{}'
  });
  return response.data;
}

export async function getAuditorOnboardingStatus(accessToken: string, intentId: string): Promise<AuditorOnboardingStatusResult> {
  const response = await fetchApi<AuditorOnboardingStatusResult>(buildApiUrl(`/api/auditor-onboarding/status/${encodeURIComponent(intentId)}`), {
    method: 'GET', headers: authorizationHeaders(accessToken)
  });
  return response.data;
}
