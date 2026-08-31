import { Request, Response } from 'express';
import { ethers } from 'ethers';
import {
  createDepositRequest,
  getDepositTransactionStatus,
  processDepositWebhook,
  reconcilePendingDepositPayment
} from '../services/depositService';
import { findDepositTransactionByOrderCode, listRecentDepositTransactionsByUserId } from '../models/depositModel';
import { findUserById } from '../models/authModel';
import { getLogger } from '../config/logger';
import { getBlockchainRpcUrl } from '../config/blockchainRpc';
import { ApplicationError } from '../utils/applicationError';
import { sanitizeProviderError } from '../utils/sanitizeProviderError';

const charityTokenAbi = ['function balanceOf(address account) view returns (uint256)'];

const logger = getLogger();

/**
 * Hàm rút trích chi tiết lỗi đọc số dư để log có ích nhưng không làm lộ payload RPC.
 * Mục đích: provider đôi khi không gán `message`; ưu tiên shortMessage/reason/code đã được sanitize.
 */
function getSafeTokenBalanceErrorDetail(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return sanitizeProviderError(error.message) || 'UNKNOWN_ERROR';
  }

  if (typeof error === 'object' && error !== null) {
    const providerError = error as { shortMessage?: unknown; reason?: unknown; code?: unknown };
    const errorDetail = [providerError.shortMessage, providerError.reason, providerError.code]
      .find((value) => typeof value === 'string' && value.trim().length > 0);
    if (typeof errorDetail === 'string') {
      return sanitizeProviderError(errorDetail) || 'UNKNOWN_ERROR';
    }
  }

  return 'UNKNOWN_ERROR';
}

/**
 * Hàm xử lý tạo payment link cho nghiệp vụ deposit.
 * Mục đích: validate dữ liệu đầu vào và trả paymentUrl cho frontend redirect.
 */
export async function handleCreateDeposit(request: Request, response: Response): Promise<void> {
  const authenticatedRequest = request as Request & { authenticatedUser?: { userId: string; role: string } };

  if (!authenticatedRequest.authenticatedUser) {
    response.status(401).json({ message: 'Bạn chưa đăng nhập hoặc phiên đăng nhập không hợp lệ.' });
    return;
  }

  const amountVnd = Number(request.body?.amountVnd);
  const paymentFlow = request.body?.paymentFlow === 'AUDITOR_ONBOARDING'
    ? 'AUDITOR_ONBOARDING'
    : request.body?.paymentFlow === 'AUDITOR_PORTAL'
      ? 'AUDITOR_PORTAL'
      : undefined;

  try {
    const user = await findUserById(authenticatedRequest.authenticatedUser.userId);
    if (!user) {
      response.status(404).json({ message: 'Không tìm thấy thông tin người dùng.' });
      return;
    }

    const createResult = await createDepositRequest({
      userId: user.id,
      walletAddress: user.walletAddress,
      amountVnd,
      correlationId: user.correlationId,
      paymentFlow
    });

    response.status(201).json(createResult);
  } catch (error) {
    logger.error('Tạo payment link deposit thất bại.', { errorMessage: (error as Error).message });
    response.status(400).json({ message: (error as Error).message || 'Tạo payment link thất bại.' });
  }
}

/**
 * Hàm kiểm tra nhanh endpoint webhook PayOS có hoạt động hay không.
 * Mục đích: trả HTTP 200 cho request GET/health-check từ dashboard PayOS.
 */
export async function handleDepositWebhookHealth(_request: Request, response: Response): Promise<void> {
  response.status(200).json({ message: 'Webhook URL hoạt động.' });
}

/**
 * Hàm xử lý webhook PayOS cho deposit.
 * Mục đích: verify webhook và thực thi xử lý idempotency theo orderCode.
 */
export async function handleDepositWebhook(request: Request, response: Response): Promise<void> {
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

    // Ghi chú logic phức tạp: checksum có thể đến từ body hoặc header tùy cấu hình cổng thanh toán.
    // Cần lưu nguồn checksum để log đối soát và truy vết lỗi checksum mismatch.
    const normalizedChecksum = bodySignatureValue || signatureHeaderValue || undefined;
    const checksumSource = bodySignatureValue
      ? 'body'
      : (signatureHeaderValue ? 'header' : 'missing');

    const webhookPayload = {
      ...rawPayload,
      signature: normalizedChecksum,
      checksum: normalizedChecksum,
      checksumSource
    };

    // Ghi chú logic phức tạp: nhiều hệ thống thanh toán gửi request test không có signature.
    // Để pass bước verify URL trên dashboard, hệ thống trả 200 và không xử lý nghiệp vụ.
    const hasSignature = Boolean((webhookPayload as { signature?: string; checksum?: string }).signature
      || (webhookPayload as { signature?: string; checksum?: string }).checksum);
    const payloadOrderCode = (webhookPayload as { orderCode?: string | number }).orderCode;
    const nestedOrderCode = (
      (webhookPayload as { data?: { orderCode?: string | number } }).data?.orderCode
    );
    const hasOrderCode = Boolean(payloadOrderCode || nestedOrderCode);

    // Ghi chú logic phức tạp: một số request verify webhook từ cổng thanh toán có thể có signature
    // nhưng không có orderCode nghiệp vụ thật. Cần trả 200 để pass verify URL, tránh false-negative 400.
    if (!hasSignature || !hasOrderCode) {
      response.status(200).json({ message: 'Webhook URL hoạt động.' });
      return;
    }

    const processedTransaction = await processDepositWebhook(webhookPayload);
    response.status(200).json({
      message: 'Webhook được xử lý thành công.',
      orderCode: processedTransaction.orderCode,
      status: processedTransaction.status,
      onChainTransactionHash: processedTransaction.onChainTransactionHash
    });
  } catch (error) {
    const errorMessage = (error as Error).message || 'Webhook không hợp lệ.';

    // Ghi chú logic phức tạp: payload verify của cổng thanh toán có thể dùng orderCode mẫu
    // không tồn tại trong DB thật. Trường hợp này cần trả 200 để pass bước kích hoạt webhook URL.
    if (errorMessage.includes('Không tìm thấy giao dịch deposit theo orderCode')) {
      logger.warn('Nhận webhook test với orderCode không tồn tại, bỏ qua xử lý nghiệp vụ.', { errorMessage });
      response.status(200).json({ message: 'Webhook URL hoạt động.' });
      return;
    }

    logger.error('Xử lý webhook deposit thất bại.', { errorMessage });
    response.status(400).json({ message: errorMessage });
  }
}

/**
 * Hàm lấy trạng thái giao dịch deposit theo orderCode.
 * Mục đích: cho frontend truy vấn tiến trình thanh toán và mint token.
 */
export async function handleGetDepositStatus(request: Request, response: Response): Promise<void> {
  const authenticatedRequest = request as Request & { authenticatedUser?: { userId: string; role: string } };
  if (!authenticatedRequest.authenticatedUser) {
    response.status(401).json({ message: 'Bạn chưa đăng nhập hoặc phiên đăng nhập không hợp lệ.' });
    return;
  }

  const orderCode = request.params.orderCode;
  const shouldReconcileWithPayos = request.query.reconcile === 'true';

  try {
    // Khi browser vừa redirect từ PayOS, đối soát trước timeout nội bộ để không bỏ sót callback đến muộn.
    let transaction = shouldReconcileWithPayos
      ? await findDepositTransactionByOrderCode(orderCode)
      : await getDepositTransactionStatus(orderCode);
    if (!transaction) {
      response.status(404).json({ message: 'Không tìm thấy giao dịch theo orderCode.' });
      return;
    }

    if (transaction.userId !== authenticatedRequest.authenticatedUser.userId) {
      response.status(403).json({ message: 'Bạn không có quyền truy cập giao dịch này.' });
      return;
    }

    if (shouldReconcileWithPayos) {
      // Chỉ đối soát sau khi kiểm tra quyền sở hữu, tránh dùng endpoint này để dò trạng thái đơn của người khác.
      transaction = await reconcilePendingDepositPayment(transaction);
      if (transaction.status === 'PENDING_PAYMENT') {
        transaction = await getDepositTransactionStatus(orderCode) || transaction;
      }
    }

    // Ghi chú logic phức tạp: FE cần mốc hết hạn thanh toán để hiển thị bộ đếm ngược 15 phút.
    // Mốc này được tính từ thời điểm tạo giao dịch ban đầu (createdAt).
    const paymentExpiredAt = new Date(transaction.createdAt.getTime() + 15 * 60 * 1000);

    response.status(200).json({
      orderCode: transaction.orderCode,
      amountVnd: transaction.amountVnd,
      tokenAmount: transaction.tokenAmount,
      status: transaction.status,
      paymentUrl: transaction.paymentUrl,
      onChainTransactionHash: transaction.onChainTransactionHash,
      failureReason: transaction.failureReason,
      // Chỉ đánh dấu khi PayOS đã được xác nhận nhưng toàn bộ retry mint on-chain đều thất bại.
      isPaymentConfirmedButMintFailed: transaction.status === 'FAILED'
        && transaction.paymentConfirmedAt !== null
        && transaction.mintCompletedAt === null,
      createdAt: transaction.createdAt,
      updatedAt: transaction.updatedAt,
      paymentExpiredAt
    });
  } catch (error) {
    logger.error('Lấy trạng thái deposit thất bại.', { errorMessage: (error as Error).message });
    response.status(500).json({ message: 'Không thể lấy trạng thái giao dịch deposit.' });
  }
}

/**
 * Hàm đọc số dư token on-chain theo địa chỉ ví người dùng.
 * Mục đích: giữ nguyên độ chính xác uint256 trước khi từng endpoint quyết định định dạng response phù hợp.
 */
async function getOnChainTokenBalance(walletAddress: string): Promise<bigint> {
  const blockchainRpcUrl = getBlockchainRpcUrl();
  const charityTokenContractAddress = String(process.env.CHARITY_TOKEN_CONTRACT_ADDRESS || '').trim();

  if (!blockchainRpcUrl) {
    throw new ApplicationError('Dịch vụ blockchain chưa được cấu hình để đọc số dư. Vui lòng thử lại sau.', 503, 'BLOCKCHAIN_UNAVAILABLE');
  }
  if (!ethers.isAddress(charityTokenContractAddress)) {
    throw new ApplicationError('Cấu hình token DCT không hợp lệ. Vui lòng thử lại sau.', 503, 'BLOCKCHAIN_UNAVAILABLE');
  }
  if (!ethers.isAddress(walletAddress)) {
    throw new ApplicationError('Địa chỉ Smart Account không hợp lệ. Vui lòng đăng nhập lại để hệ thống đồng bộ tài khoản.', 409, 'SMART_ACCOUNT_MISMATCH');
  }

  try {
    const readOnlyProvider = new ethers.JsonRpcProvider(blockchainRpcUrl);
    const charityTokenContract = new ethers.Contract(charityTokenContractAddress, charityTokenAbi, readOnlyProvider);
    return await charityTokenContract.balanceOf(walletAddress) as bigint;
  } catch (error) {
    if (error instanceof ApplicationError) {
      throw error;
    }

    throw new ApplicationError('Không thể kết nối blockchain để đọc số dư Smart Account. Vui lòng thử lại sau.', 502, 'BLOCKCHAIN_UNAVAILABLE');
  }
}

/**
 * Hàm lấy dữ liệu sidebar của trang deposit.
 * Mục đích: trả thông tin hồ sơ, số dư token và lịch sử nạp tiền gần đây theo user hiện tại.
 */
export async function handleGetDepositSidebar(request: Request, response: Response): Promise<void> {
  const authenticatedRequest = request as Request & { authenticatedUser?: { userId: string; role: string } };
  if (!authenticatedRequest.authenticatedUser) {
    response.status(401).json({ message: 'Bạn chưa đăng nhập hoặc phiên đăng nhập không hợp lệ.' });
    return;
  }

  try {
    const user = await findUserById(authenticatedRequest.authenticatedUser.userId);
    if (!user) {
      response.status(404).json({ message: 'Không tìm thấy thông tin người dùng.' });
      return;
    }

    const tokenBalanceOnChain = await getOnChainTokenBalance(user.walletAddress);
    // Sidebar kế thừa contract number hiện tại; endpoint /balance riêng trả decimal string để luồng đặt cọc không mất chính xác uint256.
    const tokenBalanceForSidebar = Number(tokenBalanceOnChain);
    const recentTransactions = await listRecentDepositTransactionsByUserId(user.id, 5);

    response.status(200).json({
      profile: {
        fullName: user.fullName,
        role: user.role,
        walletAddress: user.walletAddress
      },
      tokenBalance: tokenBalanceForSidebar,
      tokenBalanceOnChain: tokenBalanceForSidebar,
      recentDeposits: recentTransactions.map((transaction) => ({
        orderCode: transaction.orderCode,
        amountVnd: transaction.amountVnd,
        tokenAmount: transaction.tokenAmount,
        status: transaction.status,
        onChainTransactionHash: transaction.onChainTransactionHash,
        createdAt: transaction.createdAt,
        updatedAt: transaction.updatedAt
      }))
    });
  } catch (error) {
    logger.error('Lấy dữ liệu sidebar deposit thất bại.', { errorMessage: (error as Error).message });
    response.status(500).json({ message: 'Không thể lấy dữ liệu sidebar deposit.' });
  }
}

/**
 * Hàm xử lý lấy số dư token on-chain của người dùng hiện tại.
 * Mục đích: trả về balance để hiển thị trên trang chi tiết dự án.
 */
export async function handleGetTokenBalance(request: Request, response: Response): Promise<void> {
  const authenticatedRequest = request as Request & { authenticatedUser?: { userId: string; role: string } };

  if (!authenticatedRequest.authenticatedUser) {
    response.status(401).json({ message: 'Bạn chưa đăng nhập hoặc phiên đăng nhập không hợp lệ.' });
    return;
  }

  try {
    const user = await findUserById(authenticatedRequest.authenticatedUser.userId);
    if (!user) {
      response.status(404).json({ message: 'Không tìm thấy thông tin người dùng.' });
      return;
    }

    const tokenBalanceOnChain = await getOnChainTokenBalance(user.walletAddress);

    response.status(200).json({ tokenBalance: tokenBalanceOnChain.toString() });
  } catch (error) {
    const applicationError = error instanceof ApplicationError
      ? error
      : new ApplicationError('Không thể tải số dư Smart Account. Vui lòng thử lại sau.', 503, 'BLOCKCHAIN_UNAVAILABLE');
    logger.error('Lấy số dư token thất bại.', {
      authenticatedUserId: authenticatedRequest.authenticatedUser.userId,
      errorCode: applicationError.errorCode,
      errorName: error instanceof Error ? error.name : 'UnknownError',
      errorMessage: getSafeTokenBalanceErrorDetail(error)
    });
    response.status(applicationError.statusCode).json({
      message: applicationError.message,
      errorCode: applicationError.errorCode
    });
  }
}
