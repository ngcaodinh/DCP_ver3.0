/**
 * DonationModal.services — Các hàm gọi API cho donation flow.
 * Tách riêng để giảm complexity của DonationModal.tsx theo Single Responsibility Principle.
 * Chỉ chứa logic gọi API, không chứa React state hoặc UI.
 */
import { ApiErrorResponse, buildApiUrl, fetchApi } from '../../utils/apiClient';
import { resolveRelayProjectId } from './DonationModal.helpers';
import type { RecordDonationResponse } from './DonationModal.types';

/* ============================================================
 * AUTHENTICATED DONATION — ONE-CLICK FLOW
 * ============================================================ */

/**
 * Gọi API one-click donation — batch approve + donate qua backend không cần mở MetaMask.
 * Dùng cho authenticated user flow.
 *
 * @param accessToken - JWT của user đã đăng nhập
 * @param projectId - ID của dự án cần donate
 * @param amount - Số token cần donate
 * @param isAnonymous - Có ẩn danh hay không
 * @returns transactionHash của giao dịch on-chain
 * @throws ApiErrorResponse khi validation fail hoặc backend reject
 */
export async function executeOneClickDonationRequest(
  accessToken: string,
  projectId: string,
  amount: number,
  isAnonymous: boolean,
): Promise<string> {
  const normalizedProjectId = resolveRelayProjectId(projectId);
  if (!normalizedProjectId) {
    throw { statusCode: 400, errorCode: 'VALIDATION_ERROR', message: 'Mã dự án không hợp lệ để gửi one-click donation.' } as ApiErrorResponse;
  }

  const response = await fetchApi<{ transactionHash: string }>(buildApiUrl('/donations/one-click'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ projectId: normalizedProjectId, amount, isAnonymous }),
  });

  return response.data.transactionHash;
}

/**
 * Ghi nhận donation sau khi ví user đã ký thành công.
 * Backend verify txHash on-chain và index lịch sử minh bạch.
 *
 * @param accessToken - JWT của user đã đăng nhập
 * @param projectId - ID của dự án
 * @param transactionHash - Hash của giao dịch on-chain
 * @throws ApiErrorResponse khi validation fail hoặc backend reject
 */
export async function recordDonationByTransactionHash(
  accessToken: string,
  projectId: string,
  transactionHash: string,
): Promise<RecordDonationResponse> {
  const normalizedProjectId = resolveRelayProjectId(projectId);
  if (!normalizedProjectId) {
    throw { statusCode: 400, errorCode: 'VALIDATION_ERROR', message: 'Mã dự án không hợp lệ để ghi nhận giao dịch.' } as ApiErrorResponse;
  }

  const response = await fetchApi<RecordDonationResponse>(buildApiUrl('/donations/record'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ projectId: normalizedProjectId, transactionHash, isAnonymous: false }),
  });
  return response.data;
}
