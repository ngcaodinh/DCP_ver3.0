/**
 * API Client cho Guest Relay Donation endpoint.
 * Mục đích: cung cấp interface type-safe để gọi POST /api/guest/relay/donate.
 * Backend tự build và gửi transaction thay user — user chỉ click.
 */
import { buildApiUrl, fetchApi, ApiErrorResponse, ApiSuccessResponse } from './apiClient';

/** Payload request cho relay donation */
export interface RelayDonationRequest {
  projectId: string;
  amount: number;
  sessionId: string;
  /** Sender address — phải khớp với session wallet để BE verify */
  sender: string;
}

/** Response khi relay donation thành công */
export interface RelayDonationResponse {
  transactionHash: string;
  projectId: string;
  amount: number;
  sessionId: string;
}

/** Mã lỗi có thể nhận từ relay endpoint */
export type RelayApiErrorCode =
  | 'GUEST_SESSION_REQUIRED'
  | 'GUEST_SESSION_NOT_FOUND'
  | 'GUEST_SESSION_NOT_ACTIVE'
  | 'GUEST_SESSION_EXPIRED'
  | 'RELAY_NOT_AVAILABLE'
  | 'GUEST_WALLET_MISMATCH'
  | 'INVALID_REQUEST'
  | 'INSUFFICIENT_TOKEN_BALANCE'
  | 'DONATION_QUOTA_EXCEEDED'
  | 'TOTAL_AMOUNT_EXCEEDED'
  | 'PENDING_DONATION_EXISTS'
  | 'PAYMASTER_POLICY_MISMATCH'
  | 'FORBIDDEN'
  | 'INTERNAL_ERROR';

/** Error class cho relay API errors */
export class RelayApiError extends Error {
  public readonly statusCode: number;
  public readonly errorCode: RelayApiErrorCode;

  constructor(response: ApiErrorResponse) {
    super(response.message);
    this.name = 'RelayApiError';
    this.statusCode = response.statusCode ?? 500;
    this.errorCode = (response.errorCode as RelayApiErrorCode) ?? 'INTERNAL_ERROR';
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, RelayApiError);
    }
  }
}

/**
 * Thực hiện relay donation qua backend.
 * Backend tự build transaction (approve + donate) và gửi lên chain.
 * User chỉ cần click — không cần sign hay popup MetaMask.
 *
 * @param payload - projectId, amount, sessionId, sender
 * @param token - guestSessionToken (Bearer)
 * @returns transactionHash, projectId, amount, sessionId
 * @throws RelayApiError khi validate thất bại
 */
export async function relayGuestDonation(
  payload: RelayDonationRequest,
  token: string
): Promise<RelayDonationResponse> {
  return fetchApi<RelayDonationResponse>(
    buildApiUrl('/api/guest/relay/donate'),
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify(payload)
    }
  ).then(response => response.data)
    .catch((error: unknown) => {
      if (error && typeof error === 'object' && 'errorCode' in error) {
        throw new RelayApiError(error as ApiErrorResponse);
      }
      throw new RelayApiError({
        success: false,
        message: error instanceof Error ? error.message : 'Lỗi kết nối không xác định.',
        errorCode: 'INTERNAL_ERROR',
        statusCode: 0
      });
    });
}
