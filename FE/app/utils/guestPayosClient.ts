/**
 * API Client cho Guest PayOS Donation endpoints.
 * Mục đích: khởi tạo thanh toán PayOS và theo dõi trạng thái donation.
 */
import { buildApiUrl, fetchApi } from './apiClient';

/** Payload request để khởi tạo thanh toán PayOS */
export interface InitPayosDonationRequest {
  projectId: string;
  amount: number;
}

/** Response khi khởi tạo PayOS donation thành công */
export interface InitPayosDonationResponse {
  orderCode: string;
  paymentUrl: string;
  amount: number;
  projectId: string;
}

/** Trạng thái PayOS donation trên BE */
export type PayosDonationStatus =
  | 'PENDING_PAYMENT'
  | 'PAYMENT_CONFIRMED'
  | 'MINTING'
  | 'RELAYING'
  | 'COMPLETED'
  | 'FAILED';

/** Response trạng thái PayOS donation */
export interface PayosDonationStatusResponse {
  orderCode: string;
  status: PayosDonationStatus;
  amount: number;
  projectId: string;
  relayTxHash: string | null;
  mintTxHash: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Khởi tạo thanh toán PayOS cho guest donation.
 * BE tạo payment link và trả về QR cho user thanh toán.
 *
 * @param payload - projectId và amount (token, không phải VND)
 * @param token - guestSessionToken (Bearer)
 * @returns orderCode, paymentUrl, amount, projectId
 */
export async function initPayosDonation(
  payload: InitPayosDonationRequest,
  token: string
): Promise<InitPayosDonationResponse> {
  const response = await fetchApi<InitPayosDonationResponse>(
    buildApiUrl('/api/guest/payos/init'),
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify(payload)
    }
  );
  return response.data;
}

/**
 * Lấy trạng thái PayOS donation.
 * Dùng cho FE poll trạng thái sau khi user thanh toán.
 *
 * @param orderCode - Mã đơn PayOS
 * @param token - guestSessionToken (Bearer)
 * @returns Trạng thái donation hiện tại
 */
export async function getPayosDonationStatus(
  orderCode: string,
  token: string
): Promise<PayosDonationStatusResponse> {
  const response = await fetchApi<PayosDonationStatusResponse>(
    buildApiUrl(`/api/guest/payos/status/${encodeURIComponent(orderCode)}`),
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`
      }
    }
  );
  return response.data;
}
