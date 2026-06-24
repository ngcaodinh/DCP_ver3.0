/**
 * Controller xử lý endpoint khởi tạo thanh toán PayOS cho guest donation.
 * Luồng: tạo payment link → lưu record → trả về QR cho FE hiển thị.
 * Sau khi user thanh toán, PayOS webhook sẽ trigger mint + relay.
 *
 * Endpoint: POST /api/guest/payos/init
 * Auth: guestAuthMiddleware (JWT verify)
 */
import { Request, Response } from 'express';
import crypto from 'crypto';
import { createPayosPaymentLink } from '../services/payosService';
import { GuestSessionRequest } from '../middleware/guestAuthMiddleware';
import { findProjectById } from '../repositories/projectRepository';
import { createGuestPayosDonation, findGuestPayosDonationByOrderCode } from '../repositories/guestPayosDonationRepository';
import { getLogger } from '../config/logger';
import { sendErrorResponse } from '../utils/apiResponse';

const logger = getLogger();

const MIN_GUEST_DONATION_AMOUNT = 1;
const MAX_GUEST_DONATION_AMOUNT = 200000;

type PayosInitRequestBody = {
  projectId: string;
  amount: number;
};

/**
 * Xử lý khởi tạo thanh toán PayOS cho guest donation.
 * Tạo payment link PayOS và lưu record để theo dõi trạng thái.
 */
export async function handleInitGuestPayosDonation(
  request: Request,
  response: Response
): Promise<void> {
  const guestRequest = request as GuestSessionRequest;

  if (!guestRequest.guestSession) {
    sendErrorResponse(response, 401, 'Vui lòng khởi tạo ví guest trước.', 'GUEST_SESSION_REQUIRED');
    return;
  }

  const { sessionId, walletAddress } = guestRequest.guestSession;
  const body = request.body as PayosInitRequestBody;

  if (!body.projectId || typeof body.projectId !== 'string') {
    sendErrorResponse(response, 400, 'projectId là bắt buộc.', 'INVALID_REQUEST');
    return;
  }

  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || !Number.isInteger(amount) || amount < MIN_GUEST_DONATION_AMOUNT) {
    sendErrorResponse(response, 400, `Số token quyên góp tối thiểu là ${MIN_GUEST_DONATION_AMOUNT} token.`, 'INVALID_REQUEST');
    return;
  }

  if (amount > MAX_GUEST_DONATION_AMOUNT) {
    sendErrorResponse(response, 400, `Số token quyên góp tối đa là ${MAX_GUEST_DONATION_AMOUNT.toLocaleString()} token/lần.`, 'INVALID_REQUEST');
    return;
  }

  const projectId = body.projectId.trim();

  const project = await findProjectById(projectId);
  if (!project) {
    sendErrorResponse(response, 404, 'Dự án không tồn tại.', 'PROJECT_NOT_FOUND');
    return;
  }
  if (project.status !== 'ACTIVE') {
    sendErrorResponse(response, 400, 'Dự án không còn nhận quyên góp.', 'PROJECT_INACTIVE');
    return;
  }

  // Dùng UUID để tạo orderCode duy nhất — entropy đủ lớn (122 bits).
  // Thay Math.random() vì không cryptographically secure.
  const orderCode = crypto.randomUUID().replace(/-/g, '').substring(0, 18);
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  const returnUrl = `${appUrl}/donations/${projectId}?payosOrder=${orderCode}`;
  const cancelUrl = `${appUrl}/donations/${projectId}`;

  logger.info('Khởi tạo PayOS donation cho guest.', {
    sessionId,
    walletAddress,
    amount,
    projectId,
    orderCode
  });

  let paymentUrl: string;
  try {
    const payosResult = await createPayosPaymentLink({
      orderCode,
      amountVnd: amount,
      description: `DCP${orderCode.slice(-8)}`,
      returnUrl,
      cancelUrl
    });
    paymentUrl = payosResult.paymentUrl;
  } catch (error) {
    logger.error('Tạo PayOS payment link thất bại.', {
      sessionId,
      orderCode,
      errorMessage: (error as Error).message
    });
    sendErrorResponse(response, 400, `Không thể tạo mã thanh toán: ${(error as Error).message}`, 'PAYTOS_ERROR');
    return;
  }

  const now = new Date();
  try {
    await createGuestPayosDonation({
      id: crypto.randomUUID(),
      orderCode,
      guestSessionId: sessionId,
      walletAddress,
      projectId,
      amount,
      status: 'PENDING_PAYMENT',
      payosTransactionId: null,
      paymentUrl,
      returnUrl,
      mintTxHash: null,
      relayTxHash: null,
      errorMessage: null,
      createdAt: now,
      updatedAt: now
    });
  } catch (error) {
    logger.error('Lưu GuestPayosDonation record thất bại.', {
      sessionId,
      orderCode,
      errorMessage: (error as Error).message
    });
    sendErrorResponse(response, 500, 'Không thể lưu donation record.', 'INTERNAL_ERROR');
    return;
  }

  logger.info('PayOS donation init thành công.', { orderCode });

  response.status(200).json({
    success: true,
    message: '',
    data: {
      orderCode,
      paymentUrl,
      amount,
      projectId
    }
  });
}

/**
 * Lấy trạng thái thanh toán PayOS của một donation.
 * Endpoint: GET /api/guest/payos/status/:orderCode
 * Auth: guestAuthMiddleware
 */
export async function handleGetGuestPayosDonationStatus(
  request: Request,
  response: Response
): Promise<void> {
  const guestRequest = request as GuestSessionRequest;

  if (!guestRequest.guestSession) {
    sendErrorResponse(response, 401, 'Vui lòng khởi tạo ví guest trước.', 'GUEST_SESSION_REQUIRED');
    return;
  }

  const orderCode = String(request.params.orderCode || '').trim();
  if (!orderCode) {
    sendErrorResponse(response, 400, 'orderCode là bắt buộc.', 'INVALID_REQUEST');
    return;
  }

  const donation = await findGuestPayosDonationByOrderCode(orderCode);
  if (!donation) {
    sendErrorResponse(response, 404, 'Không tìm thấy donation.', 'NOT_FOUND');
    return;
  }

  if (donation.guestSessionId !== guestRequest.guestSession.sessionId) {
    sendErrorResponse(response, 403, 'Bạn không có quyền xem donation này.', 'FORBIDDEN');
    return;
  }

  response.status(200).json({
    success: true,
    message: '',
    data: {
      orderCode: donation.orderCode,
      status: donation.status,
      amount: donation.amount,
      projectId: donation.projectId,
      relayTxHash: donation.relayTxHash,
      mintTxHash: donation.mintTxHash,
      errorMessage: donation.errorMessage,
      createdAt: donation.createdAt,
      updatedAt: donation.updatedAt
    }
  });
}
