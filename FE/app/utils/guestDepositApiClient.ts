/**
 * API client cho guest deposit PayOS flow.
 * Cung cấp các functions để create deposit, sponsor UserOp, submit donation, và poll status.
 *
 * Luồng ZeroDev mới:
 * 1. buildDonateUserOp() - Build unsigned UserOp client-side
 * 2. sponsorGuestDeposit() - Gửi unsigned UserOp lên BE, mint tokens, sponsor via Paymaster
 * 3. signUserOpHash() - Ký userOpHash với owner key
 * 4. submitGuestDonation() - Gửi signed UserOp lên BE sau PayOS redirect
 * 5. getGuestDepositStatus() - Poll trạng thái
 */
import { buildApiUrl, fetchApi, ApiErrorResponse, ApiSuccessResponse } from './apiClient';

/**
 * Trạng thái guest deposit transaction.
 */
export type GuestDepositStatus =
  | 'PENDING_PAYMENT'
  | 'PAYMENT_CONFIRMED'
  | 'MINTING'
  | 'DONATION_EXECUTING'
  | 'DONATION_COMPLETED'
  | 'DONATION_FAILED'
  | 'FAILED';

/**
 * Unsigned UserOp structure - gửi lên backend để sponsor.
 */
export interface UnsignedUserOp {
  sender: string;
  nonce: string;
  initCode: string;
  callData: string;
  callGasLimit?: string;
  verificationGasLimit?: string;
  preVerificationGas?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
}

/**
 * Signed UserOp structure - gửi lên backend sau khi sign.
 */
export interface SignedUserOp {
  sender: string;
  nonce: string;
  initCode: string;
  callData: string;
  callGasLimit?: string;
  verificationGasLimit?: string;
  preVerificationGas?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  paymasterAndData?: string;
  signature: string;
}

/**
 * Gas limits estimated cho UserOp.
 */
export interface UserOpGasLimits {
  callGasLimit: string;
  verificationGasLimit: string;
  preVerificationGas: string;
}

/**
 * Response khi sponsor guest deposit thành công.
 * Backend mint tokens và sponsor via Paymaster, trả về paymasterAndData + userOpHash.
 */
export interface SponsorGuestDepositResponse {
  paymasterAndData: string;
  userOpHash: string;
  sponsorshipId: string;
  orderCode: string;
  paymentUrl: string;
}

/**
 * Response khi submit signed UserOp thành công.
 */
export interface SubmitGuestDonationResponse {
  success: boolean;
  donationTxHash: string;
  mintTxHash: string;
}

/**
 * Response khi tạo guest deposit thành công (legacy).
 */
export interface CreateGuestDepositResponse {
  paymentUrl: string;
  orderCode: string;
}

/**
 * Response khi lấy trạng thái guest deposit.
 */
export interface GuestDepositStatusResponse {
  status: GuestDepositStatus;
  orderCode: string;
  amount: number;
  projectId: string;
  mintTxHash: string | null;
  userOpHash: string | null;
  donationTxHash: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Tạo error class cho guest deposit API.
 */
export class GuestDepositApiError extends Error {
  public readonly statusCode: number;
  public readonly errorCode: string;

  constructor(response: ApiErrorResponse) {
    super(response.message);
    this.name = 'GuestDepositApiError';
    this.statusCode = response.statusCode ?? 500;
    this.errorCode = response.errorCode ?? 'UNKNOWN_ERROR';
  }
}

/**
 * Ham unwrap response tu API.
 */
function unwrap<T>(promise: Promise<ApiSuccessResponse<T>>): Promise<T> {
  return promise
    .then((response) => response.data)
    .catch((error: unknown) => {
      if (error && typeof error === 'object' && 'errorCode' in error) {
        throw new GuestDepositApiError(error as ApiErrorResponse);
      }
      throw new GuestDepositApiError({
        success: false,
        message: error instanceof Error ? error.message : 'Lỗi kết nối không xác định.',
        errorCode: 'INTERNAL_ERROR',
        statusCode: 0
      });
    });
}

/**
 * Sponsor guest deposit - gửi unsigned UserOp lên backend để mint và sponsor.
 *
 * Luồng:
 * 1. Backend mint tokens vào guest wallet address
 * 2. Backend sponsor via ZeroDev Paymaster (attach paymasterAndData)
 * 3. Backend tạo PayOS payment link
 * 4. Trả về paymasterAndData + userOpHash để FE sign
 *
 * @param params - Tham số sponsor (sessionId, projectId, amount, unsignedUserOp, gasLimits)
 * @param token - Guest session token (JWT)
 * @returns paymasterAndData, userOpHash, sponsorshipId, orderCode, paymentUrl
 */
export async function sponsorGuestDeposit(
  params: {
    sessionId: string;
    projectId: string;
    amount: number;
    unsignedUserOp: UnsignedUserOp;
    gasLimits?: UserOpGasLimits;
  },
  token: string
): Promise<SponsorGuestDepositResponse> {
  return unwrap(
    fetchApi<SponsorGuestDepositResponse>(buildApiUrl('/api/guest/deposit/sponsor'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        projectId: params.projectId,
        amount: params.amount,
        unsignedUserOp: params.unsignedUserOp,
        gasLimits: params.gasLimits
      })
    })
  );
}

/**
 * Submit signed UserOp sau khi PayOS redirect về.
 *
 * @param params - Tham số submit (orderCode, signedUserOp, paymasterAndData, userOpHash)
 * @param token - Guest session token (JWT)
 * @returns donationTxHash, mintTxHash
 */
export async function submitGuestDonation(
  params: {
    orderCode: string;
    signedUserOp: SignedUserOp;
    paymasterAndData: string;
    userOpHash: string;
  },
  token: string
): Promise<SubmitGuestDonationResponse> {
  return unwrap(
    fetchApi<SubmitGuestDonationResponse>(buildApiUrl('/api/guest/deposit/submit'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        orderCode: params.orderCode,
        signedUserOp: params.signedUserOp,
        paymasterAndData: params.paymasterAndData,
        userOpHash: params.userOpHash
      })
    })
  );
}

/**
 * Tạo guest deposit payment link (legacy endpoint - không khuyến khích).
 *
 * @param params - Tham số tạo deposit (sessionId, projectId, amount)
 * @param token - Guest session token (JWT)
 * @returns paymentUrl để redirect sang PayOS và orderCode để poll status
 */
export async function createGuestDeposit(
  params: {
    sessionId: string;
    projectId: string;
    amount: number;
  },
  token: string
): Promise<CreateGuestDepositResponse> {
  return unwrap(
    fetchApi<CreateGuestDepositResponse>(buildApiUrl('/api/guest/deposit/create'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        sessionId: params.sessionId,
        projectId: params.projectId,
        amount: params.amount
      })
    })
  );
}

/**
 * Lay trang thai guest deposit.
 *
 * @param orderCode - Ma giao dich tu PayOS
 * @param token - Guest session token (JWT)
 * @returns Trang thai chi tiet cua guest deposit transaction
 */
export async function getGuestDepositStatus(
  orderCode: string,
  token: string
): Promise<GuestDepositStatusResponse> {
  return unwrap(
    fetchApi<GuestDepositStatusResponse>(
      buildApiUrl(`/api/guest/deposit/status?orderCode=${encodeURIComponent(orderCode)}`),
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`
        }
      }
    )
  );
}
