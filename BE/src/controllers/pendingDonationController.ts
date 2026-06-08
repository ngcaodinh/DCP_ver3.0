/**
 * Controller xử lý HTTP requests cho pending donation endpoint (Frontend Sweeper).
 * Nhiệm vụ: cho phép frontend polling kiểm tra xem session có pending donation hay không.
 * Được gọi bởi GuestWalletProvider khi hasPendingDonation flag được set.
 */
import { Request, Response } from 'express';
import { updateGuestWalletSession } from '../repositories/guestWalletSessionRepository';
import { sendErrorResponse, sendSuccessResponse, sendErrorFromUnknown } from '../utils/apiResponse';
import { GuestSessionRequest } from '../middleware/guestAuthMiddleware';
import { getLogger } from '../config/logger';

const logger = getLogger();

/**
 * Response shape cho pending donation status.
 */
type PendingDonationStatus = {
  sessionId: string;
  walletAddress: string;
  hasPendingDonation: boolean;
  donationCount: number;
  totalDonatedAmount: number;
  status: string;
};

/**
 * Hàm xử lý lấy trạng thái pending donation của một session.
 * Endpoint: GET /api/guest/pending-donation
 * Middleware: guestAuthMiddleware đã verify token và gắn guestSession vào request.
 *
 * Response trả về:
 * - hasPendingDonation: true nếu reconciliation worker đã set flag
 * - donationCount, totalDonatedAmount: thông tin donation hiện tại
 */
export async function handleGetPendingDonationStatus(
  request: GuestSessionRequest,
  response: Response
): Promise<void> {
  const guestSession = request.guestSession;
  if (!guestSession) {
    sendErrorResponse(response, 401, 'Vui lòng cung cấp guest session token hợp lệ.', 'GUEST_SESSION_REQUIRED');
    return;
  }

  try {
    // Sử dụng trực tiếp guestSession từ middleware mà không cần query lại DB.
    // Middleware đã attach đầy đủ fields: hasPendingDonation, donationCount, totalDonatedAmount.
    const guestSessionData = guestSession;

    const status: PendingDonationStatus = {
      sessionId: guestSessionData.sessionId,
      walletAddress: guestSessionData.walletAddress,
      hasPendingDonation: guestSessionData.hasPendingDonation,
      donationCount: guestSessionData.donationCount,
      totalDonatedAmount: guestSessionData.totalDonatedAmount,
      status: guestSessionData.status
    };

    logger.info('Pending donation status queried.', {
      sessionId: guestSessionData.sessionId,
      hasPendingDonation: guestSessionData.hasPendingDonation
    });

    sendSuccessResponse(response, 200, 'Lấy trạng thái pending donation thành công.', status);
  } catch (error: unknown) {
    logger.error('Lỗi khi lấy pending donation status.', {
      errorMessage: error instanceof Error ? error.message : String(error),
      sessionId: guestSession.sessionId
    });
    sendErrorFromUnknown(response, error, 'Không thể lấy trạng thái pending donation.');
  }
}

/**
 * Hàm xử lý xóa flag pending donation sau khi frontend đã resume thành công.
 * Endpoint: POST /api/guest/pending-donation/clear
 * Middleware: guestAuthMiddleware đã verify token.
 *
 * Khi frontend sweep thành công, gọi endpoint này để clear flag.
 */
export async function handleClearPendingDonation(
  request: GuestSessionRequest,
  response: Response
): Promise<void> {
  const guestSession = request.guestSession;
  if (!guestSession) {
    sendErrorResponse(response, 401, 'Vui lòng cung cấp guest session token hợp lệ.', 'GUEST_SESSION_REQUIRED');
    return;
  }

  try {
    // Sử dụng guestSession từ middleware thay vì fetch lại từ DB
    // (request.guestSession đã được auth middleware xác thực)
    const updatedSession = await updateGuestWalletSession(guestSession.sessionId, {
      hasPendingDonation: false,
      updatedAt: new Date()
    });

    if (!updatedSession) {
      sendErrorResponse(response, 404, 'Phiên guest không tìm thấy.', 'SESSION_NOT_FOUND');
      return;
    }

    logger.info('Clearing pending donation flag.', {
      sessionId: guestSession.sessionId
    });

    sendSuccessResponse(response, 200, 'Đã xóa flag pending donation.', {
      sessionId: guestSession.sessionId,
      hasPendingDonation: false
    });
  } catch (error: unknown) {
    logger.error('Lỗi khi xóa pending donation flag.', {
      errorMessage: error instanceof Error ? error.message : String(error),
      sessionId: guestSession.sessionId
    });
    sendErrorFromUnknown(response, error, 'Không thể xóa flag pending donation.');
  }
}
