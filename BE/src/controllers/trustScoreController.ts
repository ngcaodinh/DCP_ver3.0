import { Request, Response } from 'express';
import { getLogger } from '../config/logger';
import { AuthenticatedRequest } from '../middleware/authenticationMiddleware';
import {
  getTrustScoreDetailForDonor,
  getTrustScoreForDonor,
  recalculateTrustScoreForDonor
} from '../services/trust-score.service';
import { sendErrorFromUnknown, sendErrorResponse, sendSuccessResponse } from '../utils/apiResponse';

const logger = getLogger();

/** Pattern kiểm tra địa chỉ ví Ethereum hợp lệ: 0x + 40 ký tự hex. */
const ETHEREUM_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

/**
 * Hàm xử lý request lấy trust score cơ bản theo địa chỉ donor.
 * Mục đích: endpoint public trả về { donorAddress, trustScore } — đủ cho frontend hiển thị badge.
 *
 * @param request - Request từ Express, chứa donorAddress trong params.
 * @param response - Response để trả JSON.
 */
export async function handleGetTrustScore(request: Request, response: Response): Promise<void> {
  const donorAddress = request.params.donorAddress;

  // Đảm bảo donorAddress hợp lệ trước khi query DB — tránh lộ thông tin lỗi nội bộ.
  if (!donorAddress || !ETHEREUM_ADDRESS_PATTERN.test(donorAddress)) {
    sendErrorResponse(response, 400, 'Địa chỉ ví không hợp lệ.', 'INVALID_ADDRESS');
    return;
  }

  try {
    const trustScore = await getTrustScoreForDonor(donorAddress);
    sendSuccessResponse(response, 200, 'Lấy trust score thành công.', {
      donorAddress: donorAddress.toLowerCase(),
      trustScore
    });
  } catch (error) {
    logger.error('Lấy trust score thất bại.', {
      donorAddress,
      errorMessage: (error as Error).message
    });
    sendErrorFromUnknown(response, error, 'Không thể lấy trust score.');
  }
}

/**
 * Hàm xử lý request lấy trust score đầy đủ kèm breakdown theo địa chỉ donor.
 * Mục đích: endpoint authenticated trả về full DonorTrustScoreRecord để frontend giải thích factors.
 * Trả 404 nếu donor chưa có bản ghi.
 *
 * @param request - Request đã được authentication middleware gắn authenticatedUser.
 * @param response - Response để trả JSON.
 */
export async function handleGetTrustScoreDetail(
  request: AuthenticatedRequest,
  response: Response
): Promise<void> {
  const donorAddress = request.params.donorAddress;

  if (!donorAddress || !ETHEREUM_ADDRESS_PATTERN.test(donorAddress)) {
    sendErrorResponse(response, 400, 'Địa chỉ ví không hợp lệ.', 'INVALID_ADDRESS');
    return;
  }

  try {
    const record = await getTrustScoreDetailForDonor(donorAddress);
    if (!record) {
      sendErrorResponse(response, 404, 'Chưa có bản ghi trust score cho donor này.', 'NOT_FOUND');
      return;
    }
    sendSuccessResponse(response, 200, 'Lấy chi tiết trust score thành công.', record);
  } catch (error) {
    logger.error('Lấy chi tiết trust score thất bại.', {
      donorAddress,
      errorMessage: (error as Error).message
    });
    sendErrorFromUnknown(response, error, 'Không thể lấy chi tiết trust score.');
  }
}

/**
 * Hàm xử lý request trigger recalculate trust score cho một donor.
 * Mục đích: endpoint admin-only cho phép operator ép cập nhật score thay vì đợi scheduler chạy.
 *
 * @param request - Request đã qua authentication + role middleware.
 * @param response - Response để trả JSON.
 */
export async function handleRecalculateTrustScore(
  request: AuthenticatedRequest,
  response: Response
): Promise<void> {
  const donorAddress = request.params.donorAddress;

  if (!donorAddress || !ETHEREUM_ADDRESS_PATTERN.test(donorAddress)) {
    sendErrorResponse(response, 400, 'Địa chỉ ví không hợp lệ.', 'INVALID_ADDRESS');
    return;
  }

  try {
    const updatedRecord = await recalculateTrustScoreForDonor(donorAddress);
    sendSuccessResponse(response, 200, 'Đã tính lại trust score thành công.', updatedRecord);
  } catch (error) {
    logger.error('Tính lại trust score thất bại.', {
      donorAddress,
      errorMessage: (error as Error).message
    });
    sendErrorFromUnknown(response, error, 'Không thể tính lại trust score.');
  }
}