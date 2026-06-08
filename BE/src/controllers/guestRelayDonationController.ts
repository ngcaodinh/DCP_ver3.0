/**
 * Controller xử lý HTTP requests cho guest relay donation endpoint.
 * Nhiệm vụ: parse input → gọi service → trả response.
 * Không chứa business logic.
 *
 * Endpoint: POST /api/guest/relay/donate
 * Auth: guestAuthMiddleware (JWT verify)
 */
import { Request, Response } from 'express';
import { ethers } from 'ethers';
import { executeGuestRelayedDonation } from '../services/guestRelayDonationService';
import { sendErrorResponse, sendErrorFromUnknown } from '../utils/apiResponse';
import { GuestSessionRequest } from '../middleware/guestAuthMiddleware';
import { getLogger } from '../config/logger';
import { ApplicationError } from '../utils/applicationError';

const logger = getLogger();

/**
 * Hàm extract metadata từ request headers.
 */
function extractRequestMetadata(request: Request): { ipAddress: string; userAgent: string } {
  const ipAddress = request.ip || 'unknown';
  const userAgent =
    typeof request.headers['user-agent'] === 'string'
      ? request.headers['user-agent']
      : 'unknown';
  return { ipAddress, userAgent };
}

/**
 * Hàm validate EVM wallet address.
 */
function isValidEthereumAddress(address: string): boolean {
  try {
    ethers.getAddress(address);
    return true;
  } catch {
    return false;
  }
}

/**
 * Hàm xử lý relay donation cho guest wallet.
 * Endpoint: POST /api/guest/relay/donate
 *
 * Quy trình:
 * 1. Validate guest session (từ middleware)
 * 2. Validate request body (projectId, amount, sessionId)
 * 3. Validate sender wallet khớp session
 * 4. Gọi executeGuestRelayedDonation() service
 * 5. Return transactionHash
 */
export async function handleGuestRelayedDonation(
  request: GuestSessionRequest,
  response: Response
): Promise<void> {
  const guestSession = request.guestSession;
  if (!guestSession) {
    sendErrorResponse(response, 401, 'Vui lòng cung cấp guest session token hợp lệ.', 'GUEST_SESSION_REQUIRED');
    return;
  }

  const { ipAddress, userAgent } = extractRequestMetadata(request);

  const body = request.body as {
    projectId?: string;
    amount?: number;
    sessionId?: string;
    sender?: string;
  };

  // Validate projectId
  if (!body.projectId || typeof body.projectId !== 'string') {
    sendErrorResponse(response, 400, 'projectId là bắt buộc.', 'INVALID_REQUEST');
    return;
  }

  // Validate amount
  if (typeof body.amount !== 'number' || body.amount <= 0) {
    sendErrorResponse(response, 400, 'amount phải là số lớn hơn 0.', 'INVALID_REQUEST');
    return;
  }

  // Validate sessionId
  if (!body.sessionId || typeof body.sessionId !== 'string') {
    sendErrorResponse(response, 400, 'sessionId là bắt buộc.', 'INVALID_REQUEST');
    return;
  }

  // Validate sessionId khớp với JWT token
  if (body.sessionId !== guestSession.sessionId) {
    sendErrorResponse(response, 403, 'sessionId không khớp với token.', 'FORBIDDEN');
    return;
  }

  // Validate sender address
  if (!body.sender || typeof body.sender !== 'string') {
    sendErrorResponse(response, 400, 'sender là bắt buộc.', 'INVALID_REQUEST');
    return;
  }

  if (!isValidEthereumAddress(body.sender)) {
    sendErrorResponse(response, 400, 'Địa chỉ sender không hợp lệ.', 'INVALID_WALLET_ADDRESS');
    return;
  }

  if (body.sender.toLowerCase() !== guestSession.walletAddress.toLowerCase()) {
    sendErrorResponse(response, 403, 'Sender address không khớp với session wallet.', 'FORBIDDEN');
    return;
  }

  try {
    const result = await executeGuestRelayedDonation({
      sessionId: body.sessionId,
      projectId: body.projectId,
      amount: body.amount,
      walletAddress: body.sender,
      ipAddress,
      userAgent
    });

    logger.info('Guest relay donation completed via API.', {
      transactionHash: result.transactionHash,
      sessionId: result.sessionId,
      projectId: result.projectId,
      amount: result.amount
    });

    response.status(200).json({
      success: true,
      message: 'Quyên góp thành công.',
      data: result
    });
  } catch (error: unknown) {
    logger.warn('Guest relay donation failed.', {
      errorMessage: error instanceof Error ? error.message : String(error),
      sessionId: guestSession.sessionId,
      projectId: body.projectId
    });

    if (error instanceof ApplicationError) {
      sendErrorResponse(response, error.statusCode, error.message, error.errorCode);
      return;
    }
    sendErrorFromUnknown(response, error, 'Không thể thực hiện quyên góp. Vui lòng thử lại.');
  }
}
