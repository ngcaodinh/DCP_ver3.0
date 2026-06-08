/**
 * Controller xử lý các endpoint cho guest deposit PayOS.
 * Bao gồm: tạo payment link, sponsor UserOp, webhook PayOS, và poll status.
 *
 * Luồng mới:
 * 1. FE build unsigned UserOp → call /api/guest/deposit/sponsor
 * 2. BE: mint tokens → sponsor via Paymaster → attach paymasterAndData
 * 3. BE trả về userOpHash + paymasterAndData
 * 4. FE: sign userOpHash với owner key → redirect sang PayOS
 * 5. PayOS webhook → BE submit signed UserOp to Bundler → donate() executes
 */
import { Request, Response } from 'express';
import crypto from 'crypto';
import { createGuestDeposit, findGuestDepositByOrderCodeRepo, updateGuestDepositStatus } from '../repositories/guestDepositRepository';
import { createPayosPaymentLink, verifyPayosWebhookChecksum } from '../services/payosService';
import { mintAndAutoDonate, type SignedUserOp } from '../services/guestDepositService';
import { GuestSessionRequest } from '../middleware/guestAuthMiddleware';
import { getLogger } from '../config/logger';
import { findProjectById } from '../repositories/projectRepository';
import { getZeroDevConfig } from '../config/zeroDev';

const logger = getLogger();

const MIN_GUEST_DEPOSIT_AMOUNT = 10000;
const MAX_GUEST_DEPOSIT_AMOUNT = 200000;

type GuestDepositStatusResponse = {
  status: string;
  orderCode: string;
  amount: number;
  projectId: string;
  mintTxHash: string | null;
  userOpHash: string | null;
  donationTxHash: string | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type SponsorRequestBody = {
  projectId: string;
  amount: number;
  unsignedUserOp: {
    sender: string;
    nonce: string;
    initCode: string;
    callData: string;
    callGasLimit?: string;
    verificationGasLimit?: string;
    preVerificationGas?: string;
    maxFeePerGas?: string;
    maxPriorityFeePerGas?: string;
  };
  gasLimits?: {
    callGasLimit: string;
    verificationGasLimit: string;
    preVerificationGas: string;
  };
};

type SponsorResponseData = {
  paymasterAndData: string;
  userOpHash: string;
  sponsorshipId: string;
  orderCode: string;
  paymentUrl: string;
};

/**
 * Hàm xử lý sponsor UserOp và tạo payment link cho guest deposit.
 * POST /api/guest/deposit/sponsor
 *
 * Quy trình:
 * 1. Validate request body
 * 2. Sponsor via ZeroDev Paymaster (attach paymasterAndData) — KHÔNG mint token ở đây
 * 3. Tạo PayOS payment link
 * 4. Lưu deposit record với status PENDING_PAYMENT
 * 5. Trả về paymasterAndData + userOpHash để FE sign
 *
 * Lưu ý: Token được mint sau khi PayOS webhook xác nhận thanh toán thành công.
 * Việc mint TRƯỚC thanh toán sẽ dẫn đến double mint khi submit endpoint gọi lại mint.
 */
export async function handleSponsorGuestDeposit(
  request: Request,
  response: Response
): Promise<void> {
  const guestRequest = request as GuestSessionRequest;

  if (!guestRequest.guestSession) {
    response.status(401).json({ message: 'Vui lòng khởi tạo ví guest trước.' });
    return;
  }

  const { sessionId, walletAddress } = guestRequest.guestSession;

  const body = request.body as SponsorRequestBody;
  const amount = Number(body?.amount);
  const projectId = String(body?.projectId || '').trim();
  const unsignedUserOp = body?.unsignedUserOp;

  // Validate amount
  if (!Number.isFinite(amount) || !Number.isInteger(amount)) {
    response.status(400).json({ message: 'Số tiền nạp phải là số nguyên hợp lệ.' });
    return;
  }

  if (amount < MIN_GUEST_DEPOSIT_AMOUNT) {
    response.status(400).json({
      message: `Số tiền nạp tối thiểu là ${MIN_GUEST_DEPOSIT_AMOUNT.toLocaleString('vi-VN')} token.`
    });
    return;
  }

  if (amount > MAX_GUEST_DEPOSIT_AMOUNT) {
    response.status(400).json({
      message: `Số tiền nạp tối đa là ${MAX_GUEST_DEPOSIT_AMOUNT.toLocaleString('vi-VN')} token.`
    });
    return;
  }

  // Validate projectId
  if (!projectId || projectId.length < 10) {
    response.status(400).json({ message: 'projectId không hợp lệ.' });
    return;
  }

  // Validate project tồn tại
  try {
    const project = await findProjectById(projectId);
    if (!project) {
      response.status(404).json({ message: 'Dự án không tồn tại.' });
      return;
    }
    if (project.status !== 'ACTIVE') {
      response.status(400).json({ message: 'Dự án không còn nhận quyên góp.' });
      return;
    }
  } catch {
    response.status(500).json({ message: 'Không thể xác minh dự án. Vui lòng thử lại.' });
    return;
  }

  // Validate unsignedUserOp
  if (!unsignedUserOp || typeof unsignedUserOp !== 'object') {
    response.status(400).json({ message: 'unsignedUserOp là bắt buộc.' });
    return;
  }

  if (!unsignedUserOp.sender || typeof unsignedUserOp.sender !== 'string') {
    response.status(400).json({ message: 'unsignedUserOp.sender là bắt buộc.' });
    return;
  }

  if (unsignedUserOp.sender.toLowerCase() !== walletAddress.toLowerCase()) {
    response.status(403).json({ message: 'Sender address không khớp với session wallet.' });
    return;
  }

  if (!unsignedUserOp.callData || typeof unsignedUserOp.callData !== 'string') {
    response.status(400).json({ message: 'unsignedUserOp.callData là bắt buộc.' });
    return;
  }

  const orderCode = String(Date.now() + Math.floor(Math.random() * 999));
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  const returnUrl = `${appUrl}/donations/${projectId}?orderCode=${orderCode}`;

  logger.info('Bắt đầu sponsor guest deposit.', {
    sessionId,
    walletAddress,
    amount,
    projectId,
    orderCode
  });

  // === Bước 1: Sponsor via ZeroDev Paymaster (KHÔNG mint token ở đây) ===

  // === Bước 2: Sponsor via ZeroDev Paymaster ===
  let paymasterAndDataValue: string;
  let userOpHashValue: string;
  let sponsorshipIdValue: string;

  try {
    const config = getZeroDevConfig();
    const paymasterUrl = config.paymasterUrl;
    const entryPointAddress = config.entryPointAddress;
    const projectIdZeroDev = config.projectId;

    sponsorshipIdValue = crypto.randomUUID();

    // Normalize unsignedUserOp
    const normalizedUserOp = {
      sender: String(unsignedUserOp.sender),
      nonce: String(unsignedUserOp.nonce || '0'),
      initCode: String(unsignedUserOp.initCode || '0x'),
      callData: String(unsignedUserOp.callData),
      callGasLimit: String(unsignedUserOp.callGasLimit || '0x50000'),
      verificationGasLimit: String(unsignedUserOp.verificationGasLimit || '0x50000'),
      preVerificationGas: String(unsignedUserOp.preVerificationGas || '0x50000'),
      maxFeePerGas: String(unsignedUserOp.maxFeePerGas || '0x59682f00'),
      maxPriorityFeePerGas: String(unsignedUserOp.maxPriorityFeePerGas || '0x59682f00'),
      paymasterAndData: '0x',
      signature: '0x'
    };

    const endpoint = `https://rpc.zerodev.app/api/v3/${projectIdZeroDev}/paymaster`;

    const paymasterResponse = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'pm_sponsorUserOperation',
        params: [
          normalizedUserOp,
          {
            entryPoint: entryPointAddress,
            chainId: 80002 // Polygon Amoy
          }
        ],
        id: 1
      })
    });

    if (!paymasterResponse.ok) {
      const rawBody = await paymasterResponse.text().catch(() => '[unreadable]');
      throw new Error(`Paymaster error: ${paymasterResponse.status} ${rawBody}`);
    }

    const paymasterResult = (await paymasterResponse.json()) as {
      result?: { paymasterAndData: string; userOpHash: string };
      error?: { message?: string };
    };

    if (paymasterResult.error || !paymasterResult.result) {
      throw new Error(`Paymaster error: ${paymasterResult.error?.message || 'Unknown'}`);
    }

    paymasterAndDataValue = paymasterResult.result.paymasterAndData;
    userOpHashValue = paymasterResult.result.userOpHash;

    logger.info('Paymaster sponsorship thành công.', {
      orderCode,
      sponsorshipId: sponsorshipIdValue,
      userOpHash: userOpHashValue ? `${userOpHashValue.substring(0, 10)}...[REDACTED]` : undefined
    });
  } catch (error) {
    logger.error('Paymaster sponsorship thất bại.', {
      sessionId,
      orderCode,
      errorMessage: (error as Error).message
    });
    response.status(400).json({ message: `Paymaster sponsorship thất bại: ${(error as Error).message}` });
    return;
  }

  // === Bước 2: Tạo PayOS payment link ===
  let paymentUrlValue: string;
  try {
    const payosResult = await createPayosPaymentLink({
      orderCode,
      amountVnd: amount,
      description: `GUEST_DONATE${orderCode.slice(-6)}`,
      returnUrl,
      cancelUrl: `${appUrl}/donations/${projectId}`
    });
    paymentUrlValue = payosResult.paymentUrl;
  } catch (error) {
    logger.error('Tạo PayOS payment link thất bại.', {
      sessionId,
      orderCode,
      errorMessage: (error as Error).message
    });
    response.status(400).json({ message: `Tạo payment link thất bại: ${(error as Error).message}` });
    return;
  }

  // === Bước 3: Lưu deposit record ===
  const now = new Date();
  try {
    await createGuestDeposit({
      id: crypto.randomUUID(),
      orderCode,
      guestSessionId: sessionId,
      walletAddress,
      projectId,
      amount,
      amountVnd: amount,
      paymentUrl: paymentUrlValue,
      returnUrl,
      status: 'PENDING_PAYMENT',
      mintTxHash: null,
      userOpHash: userOpHashValue,
      donationTxHash: null,
      errorMessage: null,
      payosTransactionId: null,
      createdAt: now,
      updatedAt: now,
      webhookProcessedAt: null
    });
  } catch (error) {
    logger.error('Lưu deposit record thất bại.', {
      sessionId,
      orderCode,
      errorMessage: (error as Error).message
    });
    response.status(500).json({ message: 'Không thể lưu deposit record.' });
    return;
  }

  logger.info('Sponsor guest deposit thành công.', {
    orderCode,
    sessionId,
    walletAddress,
    amount,
    sponsorshipId: sponsorshipIdValue
  });

  // Trả về data để FE sign và redirect PayOS
  const resultData: SponsorResponseData = {
    paymasterAndData: paymasterAndDataValue,
    userOpHash: userOpHashValue,
    sponsorshipId: sponsorshipIdValue,
    orderCode,
    paymentUrl: paymentUrlValue
  };

  response.status(200).json(resultData);
}

/**
 * Hàm xử lý tạo payment link cho guest deposit (legacy endpoint).
 * POST /api/guest/deposit/create
 *
 * @deprecated Sử dụng /api/guest/deposit/sponsor thay thế để hỗ trợ ZeroDev Bundler flow.
 */
export async function handleCreateGuestDeposit(
  request: Request,
  response: Response
): Promise<void> {
  const guestRequest = request as GuestSessionRequest;

  if (!guestRequest.guestSession) {
    response.status(401).json({ message: 'Vui lòng khởi tạo ví guest trước.' });
    return;
  }

  const { sessionId, walletAddress } = guestRequest.guestSession;

  const amount = Number(request.body?.amount);
  const projectId = String(request.body?.projectId || '').trim();

  // Validate amount
  if (!Number.isFinite(amount) || !Number.isInteger(amount)) {
    response.status(400).json({ message: 'Số tiền nạp phải là số nguyên hợp lệ.' });
    return;
  }

  if (amount < MIN_GUEST_DEPOSIT_AMOUNT) {
    response.status(400).json({
      message: `Số tiền nạp tối thiểu là ${MIN_GUEST_DEPOSIT_AMOUNT.toLocaleString('vi-VN')} token.`
    });
    return;
  }

  if (amount > MAX_GUEST_DEPOSIT_AMOUNT) {
    response.status(400).json({
      message: `Số tiền nạp tối đa là ${MAX_GUEST_DEPOSIT_AMOUNT.toLocaleString('vi-VN')} token.`
    });
    return;
  }

  // Validate projectId
  if (!projectId || projectId.length < 10) {
    response.status(400).json({ message: 'projectId không hợp lệ.' });
    return;
  }

  // Validate project tồn tại
  try {
    const project = await findProjectById(projectId);
    if (!project) {
      response.status(404).json({ message: 'Dự án không tồn tại.' });
      return;
    }
    if (project.status !== 'ACTIVE') {
      response.status(400).json({ message: 'Dự án không còn nhận quyên góp.' });
      return;
    }
  } catch {
    response.status(500).json({ message: 'Không thể xác minh dự án. Vui lòng thử lại.' });
    return;
  }

  const orderCode = String(Date.now() + Math.floor(Math.random() * 999));
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  const returnUrl = `${appUrl}/donations/${projectId}?orderCode=${orderCode}`;

  logger.info('Bắt đầu tạo guest deposit payment link (legacy).', {
    sessionId,
    walletAddress,
    amount,
    projectId,
    orderCode
  });

  try {
    const paymentLinkResult = await createPayosPaymentLink({
      orderCode,
      amountVnd: amount,
      description: `GUEST_DONATE${orderCode.slice(-6)}`,
      returnUrl,
      cancelUrl: `${appUrl}/donations/${projectId}`
    });

    const now = new Date();
    await createGuestDeposit({
      id: crypto.randomUUID(),
      orderCode: paymentLinkResult.orderCode,
      guestSessionId: sessionId,
      walletAddress,
      projectId,
      amount,
      amountVnd: amount,
      paymentUrl: paymentLinkResult.paymentUrl,
      returnUrl,
      status: 'PENDING_PAYMENT',
      mintTxHash: null,
      userOpHash: null,
      donationTxHash: null,
      errorMessage: null,
      payosTransactionId: null,
      createdAt: now,
      updatedAt: now,
      webhookProcessedAt: null
    });

    logger.info('Tạo guest deposit payment link thành công (legacy).', {
      orderCode: paymentLinkResult.orderCode,
      sessionId,
      walletAddress,
      amount
    });

    response.status(201).json({
      paymentUrl: paymentLinkResult.paymentUrl,
      orderCode: paymentLinkResult.orderCode
    });
  } catch (error) {
    logger.error('Tạo guest deposit payment link thất bại.', {
      sessionId,
      walletAddress,
      amount,
      projectId,
      errorMessage: (error as Error).message
    });
    response.status(400).json({ message: (error as Error).message || 'Tạo payment link thất bại.' });
  }
}

/**
 * Hàm xử lý webhook PayOS cho guest deposit.
 * POST /api/guest/deposit/webhook
 *
 * Quy trình:
 * 1. Verify checksum
 * 2. Kiểm tra payment thành công
 * 3. Submit signed UserOp lên Bundler → donate() executes
 */
export async function handleGuestDepositWebhook(
  request: Request,
  response: Response
): Promise<void> {
  try {
    const rawPayload = request.body || {};
    const signatureHeaderValue = String(
      request.headers['x-payos-signature']
      || request.headers['x-signature']
      || request.headers['x-checksum']
      || ''
    ).trim();
    const bodySignatureValue = String(
      (rawPayload as { signature?: string; checksum?: string }).signature
      || (rawPayload as { signature?: string; checksum?: string }).checksum
      || ''
    ).trim();

    const normalizedChecksum = bodySignatureValue || signatureHeaderValue || undefined;

    if (!normalizedChecksum) {
      response.status(200).json({ message: 'Webhook URL hoạt động.' });
      return;
    }

    // Trích xuất orderCode từ payload
    const payloadOrderCode = (rawPayload as { orderCode?: string | number }).orderCode;
    const nestedOrderCode = (rawPayload as { data?: { orderCode?: string | number } }).data?.orderCode;
    const orderCodeRaw = payloadOrderCode || nestedOrderCode;

    if (!orderCodeRaw) {
      response.status(200).json({ message: 'Webhook thiếu orderCode.' });
      return;
    }

    const orderCode = String(orderCodeRaw).trim();

    // Tìm guest deposit transaction
    const guestDeposit = await findGuestDepositByOrderCodeRepo(orderCode);

    if (!guestDeposit) {
      logger.warn('Webhook nhận orderCode không tồn tại trong guest deposit.', { orderCode });
      response.status(200).json({ message: 'Webhook URL hoạt động.' });
      return;
    }

    // Idempotency: nếu không phải PENDING_PAYMENT, bỏ qua
    if (guestDeposit.status !== 'PENDING_PAYMENT') {
      logger.info('Webhook đã được xử lý trước đó, bỏ qua.', {
        orderCode,
        finalStatus: guestDeposit.status
      });
      response.status(200).json({ message: 'Webhook đã được xử lý.' });
      return;
    }

    // Verify checksum
    const webhookData = (rawPayload as { data?: Record<string, unknown> }).data || rawPayload;
    const isValidChecksum = verifyPayosWebhookChecksum(
      webhookData as Record<string, unknown>,
      normalizedChecksum
    );

    if (!isValidChecksum) {
      logger.warn('Webhook checksum không hợp lệ.', { orderCode });
      response.status(200).json({ message: 'Webhook checksum không hợp lệ.' });
      return;
    }

    // Kiểm tra thanh toán thành công
    const webhookCode = String(
      (rawPayload as { code?: string | number }).code
      || (webhookData as { code?: string | number }).code
      || ''
    ).trim();
    const webhookStatus = String(
      (rawPayload as { status?: string }).status
      || (webhookData as { status?: string }).status
      || ''
    ).trim().toUpperCase();

    const isPaymentSuccess =
      (webhookCode === '00') ||
      webhookStatus === 'PAID' ||
      webhookStatus === 'SUCCESS' ||
      webhookStatus === 'COMPLETED';

    if (!isPaymentSuccess) {
      await updateGuestDepositStatus(orderCode, {
        status: 'FAILED',
        errorMessage: 'Thanh toán thất bại từ PayOS.',
        webhookProcessedAt: new Date(),
        updatedAt: new Date()
      });
      logger.info('Guest deposit thanh toán thất bại.', { orderCode });
      response.status(200).json({ message: 'Thanh toán thất bại.' });
      return;
    }

    // Cập nhật PAYMENT_CONFIRMED
    await updateGuestDepositStatus(orderCode, {
      status: 'PAYMENT_CONFIRMED',
      webhookProcessedAt: new Date(),
      updatedAt: new Date()
    });
    logger.info('Guest deposit thanh toán xác nhận, bắt đầu submit donation.', {
      orderCode
    });

    // Xử lý submit donation (trả về 200 ngay để tránh PayOS retry)
    void Promise.resolve().then(async () => {
      try {
        // Nếu đã có signed UserOp (từ sponsor endpoint), submit lên Bundler
        // Nếu không có (legacy flow), gọi mintAndAutoDonate
        if (guestDeposit.userOpHash) {
          // Legacy: đã mint trong sponsor endpoint, chỉ cần submit to Bundler
          // Trong luồng mới, signed UserOp được gửi qua endpoint riêng
          logger.info('Payment confirmed, donation flow pending user signed UserOp submission.', {
            orderCode,
            userOpHash: guestDeposit.userOpHash
          });
        } else {
          // Fallback: gọi mintAndAutoDonate cho legacy flow
          await mintAndAutoDonate({
            sessionId: guestDeposit.guestSessionId,
            walletAddress: guestDeposit.walletAddress,
            amount: guestDeposit.amount,
            projectId: guestDeposit.projectId,
            orderCode,
            signedUserOp: {
              sender: guestDeposit.walletAddress,
              nonce: '0',
              initCode: '0x',
              callData: '0x'
            } as SignedUserOp,
            paymasterAndData: '0x',
            userOpHash: ''
          });
        }
      } catch (error) {
        logger.error('Submit donation thất bại trong webhook handler.', {
          orderCode,
          errorMessage: (error as Error).message
        });
      }
    });

    response.status(200).json({ message: 'Webhook xử lý thành công.' });
  } catch (error) {
    logger.error('Xử lý webhook guest deposit thất bại.', {
      errorMessage: (error as Error).message
    });
    response.status(400).json({ message: (error as Error).message || 'Webhook không hợp lệ.' });
  }
}

/**
 * Hàm xử lý submit signed UserOp sau khi PayOS redirect.
 * POST /api/guest/deposit/submit
 *
 * Quy trình:
 * 1. Validate signed UserOp
 * 2. Submit lên Bundler → EntryPoint executes donate()
 */
export async function handleSubmitGuestDonation(
  request: Request,
  response: Response
): Promise<void> {
  const guestRequest = request as GuestSessionRequest;

  if (!guestRequest.guestSession) {
    response.status(401).json({ message: 'Vui lòng khởi tạo ví guest trước.' });
    return;
  }

  const { sessionId, walletAddress } = guestRequest.guestSession;

  const body = request.body as {
    orderCode?: string;
    signedUserOp?: SignedUserOp;
    paymasterAndData?: string;
    userOpHash?: string;
  };

  const orderCode = String(body?.orderCode || '').trim();
  const signedUserOp = body?.signedUserOp;
  const paymasterAndData = String(body?.paymasterAndData || '0x');
  const userOpHash = String(body?.userOpHash || '').trim();

  if (!orderCode) {
    response.status(400).json({ message: 'orderCode là bắt buộc.' });
    return;
  }

  if (!signedUserOp) {
    response.status(400).json({ message: 'signedUserOp là bắt buộc.' });
    return;
  }

  if (!signedUserOp.sender || typeof signedUserOp.sender !== 'string') {
    response.status(400).json({ message: 'signedUserOp.sender là bắt buộc.' });
    return;
  }

  if (signedUserOp.sender.toLowerCase() !== walletAddress.toLowerCase()) {
    response.status(403).json({ message: 'Sender address không khớp với session wallet.' });
    return;
  }

  if (!signedUserOp.signature || typeof signedUserOp.signature !== 'string') {
    response.status(400).json({ message: 'signedUserOp.signature là bắt buộc.' });
    return;
  }

  if (!signedUserOp.callData || typeof signedUserOp.callData !== 'string') {
    response.status(400).json({ message: 'signedUserOp.callData là bắt buộc.' });
    return;
  }

  // Tìm deposit record
  const guestDeposit = await findGuestDepositByOrderCodeRepo(orderCode);
  if (!guestDeposit) {
    response.status(404).json({ message: 'Không tìm thấy giao dịch.' });
    return;
  }

  if (guestDeposit.guestSessionId !== sessionId) {
    response.status(403).json({ message: 'Bạn không có quyền truy cập giao dịch này.' });
    return;
  }

  // Kiểm tra status - chỉ submit khi đã thanh toán
  if (guestDeposit.status !== 'PAYMENT_CONFIRMED' && guestDeposit.status !== 'MINTING') {
    response.status(400).json({
      message: `Không thể submit donation. Trạng thái hiện tại: ${guestDeposit.status}`
    });
    return;
  }

  logger.info('Bắt đầu submit signed UserOp lên Bundler.', {
    orderCode,
    sessionId,
    walletAddress,
    userOpHash: userOpHash ? `${userOpHash.substring(0, 10)}...[REDACTED]` : undefined
  });

  try {
    // Gọi mintAndAutoDonate - đã mint rồi nên sẽ skip mint và submit luôn
    // Tuy nhiên flow hiện tại mint trong sponsor endpoint, nên ở đây chỉ submit
    // Do mintAndAutoDonate cần cả mint + submit, ta tách riêng

    // Submit signed UserOp lên Bundler
    const { mintAndAutoDonate } = await import('../services/guestDepositService');

    const result = await mintAndAutoDonate({
      sessionId,
      walletAddress,
      amount: guestDeposit.amount,
      projectId: guestDeposit.projectId,
      orderCode,
      signedUserOp,
      paymasterAndData,
      userOpHash
    });

    logger.info('Submit signed UserOp thành công.', {
      orderCode,
      donationTxHash: result.donationTxHash
    });

    response.status(200).json({
      success: true,
      donationTxHash: result.donationTxHash,
      mintTxHash: result.mintTxHash
    });
  } catch (error) {
    logger.error('Submit signed UserOp thất bại.', {
      orderCode,
      errorMessage: (error as Error).message
    });

    await updateGuestDepositStatus(orderCode, {
      status: 'DONATION_FAILED',
      errorMessage: `Submit donation thất bại: ${(error as Error).message}`,
      updatedAt: new Date()
    });

    response.status(400).json({
      message: `Submit donation thất bại: ${(error as Error).message}`
    });
  }
}

/**
 * Hàm xử lý lấy trạng thái guest deposit.
 * GET /api/guest/deposit/status?orderCode=xxx
 */
export async function handleGetGuestDepositStatus(
  request: Request,
  response: Response
): Promise<void> {
  const guestRequest = request as GuestSessionRequest;

  if (!guestRequest.guestSession) {
    response.status(401).json({ message: 'Vui lòng khởi tạo ví guest trước.' });
    return;
  }

  const { sessionId } = guestRequest.guestSession;

  const orderCode = String(request.query?.orderCode || '').trim();

  if (!orderCode) {
    response.status(400).json({ message: 'orderCode là bắt buộc.' });
    return;
  }

  try {
    const guestDeposit = await findGuestDepositByOrderCodeRepo(orderCode);

    if (!guestDeposit) {
      response.status(404).json({ message: 'Không tìm thấy giao dịch theo orderCode.' });
      return;
    }

    // Chỉ cho phép session sở hữu giao dịch
    if (guestDeposit.guestSessionId !== sessionId) {
      response.status(403).json({ message: 'Bạn không có quyền truy cập giao dịch này.' });
      return;
    }

    const statusResponse: GuestDepositStatusResponse = {
      status: guestDeposit.status,
      orderCode: guestDeposit.orderCode,
      amount: guestDeposit.amount,
      projectId: guestDeposit.projectId,
      mintTxHash: guestDeposit.mintTxHash,
      userOpHash: guestDeposit.userOpHash,
      donationTxHash: guestDeposit.donationTxHash,
      errorMessage: guestDeposit.errorMessage,
      createdAt: guestDeposit.createdAt,
      updatedAt: guestDeposit.updatedAt
    };

    response.status(200).json(statusResponse);
  } catch (error) {
    logger.error('Lấy trạng thái guest deposit thất bại.', {
      orderCode,
      sessionId,
      errorMessage: (error as Error).message
    });
    response.status(500).json({ message: 'Không thể lấy trạng thái giao dịch.' });
  }
}
