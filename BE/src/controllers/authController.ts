import { Request, Response } from 'express';
import {
  getMyActiveSessions,
  loginWithGoogle,
  refreshAccessToken,
  logFailedGoogleLogin,
  revokeAllRefreshSessionsForUser
} from '../services/authService';
import {
  getMyOrganizationProfile,
  getOrganizationKycSubmissionsByUserId,
  getPendingOrganizationKycSubmissions,
  reviewOrganizationKycSubmission,
  submitBeneficiaryBankAccount,
  submitOrganizationKyc
} from '../services/organizationKycService';
import { findUserById } from '../models/authModel';
import { getLogger } from '../config/logger';
import { sendErrorFromUnknown, sendErrorResponse, sendSuccessResponse } from '../utils/apiResponse';

const logger = getLogger();

type GoogleLoginPayload = {
  identityToken: string;
  role: 'donor' | 'organization';
};

/**
 * Hàm đọc payload đăng nhập Google từ request.
 * Mục đích: chuẩn hóa dữ liệu idToken và vai trò người dùng trước khi xử lý.
 */
function extractGoogleLoginPayload(request: Request): GoogleLoginPayload | null {
  const identityToken = request.body?.idToken;
  const role = request.body?.role;

  if (typeof identityToken !== 'string' || identityToken.trim().length === 0) {
    return null;
  }

  if (role !== 'donor' && role !== 'organization') {
    return null;
  }

  return {
    identityToken: identityToken.trim(),
    role
  };
}

/**
 * Hàm lấy metadata thiết bị từ request.
 * Mục đích: đảm bảo luôn có IP và User-Agent hợp lệ.
 */
function extractRequestMetadata(request: Request): { ipAddress: string; userAgent: string } {
  const ipAddress = request.headers['x-client-ip'];
  const userAgent = request.headers['x-client-user-agent'];

  const normalizedIp = typeof ipAddress === 'string' && ipAddress.trim().length > 0 ? ipAddress.trim() : 'unknown';
  const normalizedUserAgent =
    typeof userAgent === 'string' && userAgent.trim().length > 0 ? userAgent.trim() : 'unknown';

  return { ipAddress: normalizedIp, userAgent: normalizedUserAgent };
}

/**
 * Hàm lấy payload làm mới token.
 * Mục đích: đảm bảo refresh token và session id hợp lệ.
 */
function extractRefreshPayload(request: Request): { refreshSessionId: string; refreshToken: string } | null {
  const refreshSessionId = request.body?.refreshSessionId;
  const refreshToken = request.body?.refreshToken;

  if (typeof refreshSessionId !== 'string' || refreshSessionId.trim().length === 0) {
    return null;
  }

  if (typeof refreshToken !== 'string' || refreshToken.trim().length === 0) {
    return null;
  }

  return {
    refreshSessionId: refreshSessionId.trim(),
    refreshToken: refreshToken.trim()
  };
}


/**
 * Hàm lấy thông tin người dùng đã xác thực từ request.
 * Mục đích: chuẩn hóa cách đọc authenticatedUser do middleware gắn vào.
 */
function getAuthenticatedUser(request: Request): { userId: string; role: string } | null {
  const authenticatedRequest = request as Request & {
    authenticatedUser?: { userId: string; role: string };
  };

  if (!authenticatedRequest.authenticatedUser) {
    return null;
  }

  return authenticatedRequest.authenticatedUser;
}

/**
 * Hàm xử lý đăng nhập Google.
 * Mục đích: xác thực token, tạo ví blockchain và trả access/refresh token.
 */
export async function handleGoogleLogin(request: Request, response: Response): Promise<void> {
  const googleLoginPayload = extractGoogleLoginPayload(request);
  const metadata = extractRequestMetadata(request);

  if (!googleLoginPayload) {
    logger.warn('Google login request missing identity token or role.');
    response.status(400).json({
      message: 'Thiếu thông tin xác thực Google hoặc vai trò tài khoản.'
    });
    return;
  }

  try {
    const loginResult = await loginWithGoogle(
      googleLoginPayload.identityToken,
      googleLoginPayload.role,
      metadata.ipAddress,
      metadata.userAgent
    );
    logger.info('Google login success.', { correlationId: loginResult.correlationId });

    response.status(200).json({
      accessToken: loginResult.accessToken,
      refreshToken: loginResult.refreshToken,
      csrfToken: loginResult.csrfToken,
      refreshSessionId: loginResult.refreshSessionId,
      expiresAt: loginResult.expiresAt,
      user: loginResult.user,
      correlationId: loginResult.correlationId
    });
  } catch (error) {
    logFailedGoogleLogin(
      null,
      metadata.ipAddress,
      metadata.userAgent,
      (error as Error).message
    );
    logger.error('Google login failed.', {
      errorMessage: (error as Error).message
    });
    response.status(401).json({
      message: 'Đăng nhập Google thất bại. Vui lòng thử lại.'
    });
  }
}

/**
 * Hàm xử lý làm mới access token.
 * Mục đích: xác thực refresh token và trả về token mới.
 */
export async function handleRefreshToken(request: Request, response: Response): Promise<void> {
  const payload = extractRefreshPayload(request);
  const metadata = extractRequestMetadata(request);
  const csrfTokenHeader = request.headers['x-csrf-token'];
  const csrfToken = typeof csrfTokenHeader === 'string' ? csrfTokenHeader.trim() : '';

  if (!payload || csrfToken.length === 0) {
    response.status(400).json({
      message: 'Thiếu thông tin làm mới phiên.'
    });
    return;
  }

  try {
    const refreshResult = await refreshAccessToken(
      payload.refreshSessionId,
      payload.refreshToken,
      csrfToken,
      metadata.ipAddress,
      metadata.userAgent
    );

    response.status(200).json({
      accessToken: refreshResult.accessToken,
      refreshToken: refreshResult.refreshToken,
      csrfToken: refreshResult.csrfToken,
      refreshSessionId: refreshResult.refreshSessionId,
      expiresAt: refreshResult.expiresAt
    });
  } catch (error) {
    logger.error('Refresh token failed.', {
      errorMessage: (error as Error).message
    });
    response.status(401).json({
      message: 'Làm mới token thất bại. Vui lòng đăng nhập lại.'
    });
  }
}

/**
 * Hàm xử lý nộp hồ sơ KYC cho tổ chức từ thiện.
 * Mục đích: nhận metadata tài liệu và lưu hồ sơ KYC phiên bản hóa lên hệ thống.
 */
export async function handleOrganizationKycSubmission(request: Request, response: Response): Promise<void> {
  const authenticatedRequest = request as Request & {
    authenticatedUser?: { userId: string; role: string };
  };

  if (!authenticatedRequest.authenticatedUser) {
    response.status(401).json({
      message: 'Bạn chưa đăng nhập hoặc phiên đăng nhập không hợp lệ.'
    });
    return;
  }

  if (authenticatedRequest.authenticatedUser.role !== 'honor' && authenticatedRequest.authenticatedUser.role !== 'donor') {
    response.status(403).json({
      message: 'Chỉ tài khoản role donor hoặc honor mới được nộp hồ sơ KYC.'
    });
    return;
  }

  try {
    const submissionResult = await submitOrganizationKyc(authenticatedRequest.authenticatedUser.userId, request.body);
    response.status(201).json({
      message: 'Nộp hồ sơ KYC thành công.',
      submission: submissionResult
    });
  } catch (error) {
    logger.error('Organization KYC submission failed.', {
      errorMessage: (error as Error).message
    });
    response.status(400).json({
      message: (error as Error).message
    });
  }

}

/**
 * Hàm lấy danh sách hồ sơ KYC chờ duyệt cho Regulatory.
 * Mục đích: cung cấp dữ liệu review theo đúng trạng thái PENDING_REVIEW.
 */
export async function handleGetPendingOrganizationKycSubmissions(request: Request, response: Response): Promise<void> {
  const authenticatedRequest = request as Request & {
    authenticatedUser?: { userId: string; role: string };
  };

  if (!authenticatedRequest.authenticatedUser) {
    response.status(401).json({
      message: 'Bạn chưa đăng nhập hoặc phiên đăng nhập không hợp lệ.'
    });
    return;
  }

  if (authenticatedRequest.authenticatedUser.role !== 'regulatory' && authenticatedRequest.authenticatedUser.role !== 'admin') {
    response.status(403).json({
      message: 'Bạn không có quyền xem danh sách hồ sơ KYC chờ duyệt. Chỉ cơ quan regulatory hoặc admin được phép.'
    });
    return;
  }

  const pendingSubmissionList = await getPendingOrganizationKycSubmissions();
  response.status(200).json({
    submissions: pendingSubmissionList
  });
}

/**
 * Hàm xử lý duyệt hoặc từ chối hồ sơ KYC.
 * Mục đích: cập nhật trạng thái hồ sơ theo hành động review từ Regulatory.
 */
export async function handleReviewOrganizationKycSubmission(request: Request, response: Response): Promise<void> {
  const authenticatedRequest = request as Request & {
    authenticatedUser?: { userId: string; role: string };
  };

  if (!authenticatedRequest.authenticatedUser) {
    response.status(401).json({
      message: 'Bạn chưa đăng nhập hoặc phiên đăng nhập không hợp lệ.'
    });
    return;
  }

  if (authenticatedRequest.authenticatedUser.role !== 'regulatory' && authenticatedRequest.authenticatedUser.role !== 'admin') {
    response.status(403).json({
      message: 'Bạn không có quyền duyệt hồ sơ KYC. Chỉ cơ quan regulatory hoặc admin được phép.'
    });
    return;
  }

  const submissionId = typeof request.params.submissionId === 'string' ? request.params.submissionId.trim() : '';
  if (submissionId.length === 0) {
    response.status(400).json({
      message: 'Thiếu submissionId để xử lý hồ sơ.'
    });
    return;
  }

  try {
    const reviewResult = await reviewOrganizationKycSubmission(authenticatedRequest.authenticatedUser.userId, {
      submissionId,
      reviewPayload: request.body
    });

    logger.info('Organization KYC review completed.');

    response.status(200).json({
      message: 'Cập nhật trạng thái hồ sơ KYC thành công.',
      submission: reviewResult.submission,
      accountUpdate: reviewResult.accountUpdate
    });
  } catch (error) {
    logger.error('Organization KYC review failed.', {
      errorMessage: (error as Error).message
    });

    response.status(400).json({
      message: (error as Error).message
    });
  }
}

/**
 * Hàm lấy danh sách hồ sơ KYC của tổ chức đang đăng nhập.
 * Mục đích: trả dữ liệu thật cho FE kiểm tra trạng thái approved/verified của tài khoản thụ hưởng.
 */
export async function handleGetMyOrganizationKycSubmissions(request: Request, response: Response): Promise<void> {
  const authenticatedUser = getAuthenticatedUser(request);

  if (!authenticatedUser) {
    sendErrorResponse(response, 401, 'Bạn chưa đăng nhập hoặc phiên đăng nhập không hợp lệ.', 'UNAUTHENTICATED');
    return;
  }

  try {
    const submissionList = await getOrganizationKycSubmissionsByUserId(authenticatedUser.userId);
    sendSuccessResponse(response, 200, 'Lấy danh sách hồ sơ KYC của tổ chức thành công.', {
      submissions: submissionList
    });
  } catch (error: unknown) {
    sendErrorFromUnknown(response, error, 'Không thể tải danh sách hồ sơ KYC của tổ chức.');
  }
}

/**
 * Hàm lấy danh sách phiên đăng nhập đang hoạt động của user hiện tại.
 * Mục đích: trả dữ liệu thật cho tab Cài đặt → Bảo mật ở frontend.
 */
export async function handleGetMyActiveSessions(request: Request, response: Response): Promise<void> {
  const authenticatedUser = getAuthenticatedUser(request);

  if (!authenticatedUser) {
    sendErrorResponse(response, 401, 'Bạn chưa đăng nhập hoặc phiên đăng nhập không hợp lệ.', 'UNAUTHENTICATED');
    return;
  }

  try {
    const activeSessionList = await getMyActiveSessions(authenticatedUser.userId);
    sendSuccessResponse(response, 200, 'Lấy danh sách phiên hoạt động thành công.', {
      sessions: activeSessionList
    });
  } catch (error: unknown) {
    sendErrorFromUnknown(response, error, 'Không thể tải danh sách phiên hoạt động.');
  }
}


/**
 * Hàm lấy profile tổ chức của user hiện tại.
 * Mục đích: trả dữ liệu thật cho tab Cài đặt → Tổ chức ở frontend.
 */
export async function handleGetMyOrganizationProfile(request: Request, response: Response): Promise<void> {
  const authenticatedUser = getAuthenticatedUser(request);

  if (!authenticatedUser) {
    sendErrorResponse(response, 401, 'Bạn chưa đăng nhập hoặc phiên đăng nhập không hợp lệ.', 'UNAUTHENTICATED');
    return;
  }

  try {
    const organizationProfile = await getMyOrganizationProfile(authenticatedUser.userId);
    sendSuccessResponse(response, 200, 'Lấy thông tin tổ chức thành công.', {
      profile: organizationProfile
    });
  } catch (error: unknown) {
    sendErrorFromUnknown(response, error, 'Không thể tải thông tin tổ chức.');
  }
}


/**
 * Hàm nộp thông tin tài khoản ngân hàng thụ hưởng của tổ chức đang đăng nhập.
 * Mục đích: tạo hồ sơ trạng thái chờ duyệt để regulatory/admin review.
 */
export async function handleSubmitBeneficiaryBankAccount(request: Request, response: Response): Promise<void> {
  const authenticatedUser = getAuthenticatedUser(request);

  if (!authenticatedUser) {
    response.status(401).json({
      message: 'Bạn chưa đăng nhập hoặc phiên đăng nhập không hợp lệ.'
    });
    return;
  }

  try {
    const submissionResult = await submitBeneficiaryBankAccount(authenticatedUser.userId, request.body);
    const responseStatusCode = submissionResult.isExistingPendingSubmission ? 200 : 201;
    const responseMessage = submissionResult.isExistingPendingSubmission
      ? 'Yêu cầu duyệt tài khoản đang ở trạng thái chờ xác minh.'
      : 'Đã gửi duyệt tài khoản ngân hàng thành công.';

    response.status(responseStatusCode).json({
      message: responseMessage,
      submission: submissionResult
    });
  } catch (error) {
    const errorMessage = (error as Error).message;
    // Phân biệt lỗi trùng lặp tài khoản ngân hàng (HTTP 409) với các lỗi khác (HTTP 400).
    const isDuplicateBankAccount = errorMessage.includes('đã được liên kết với tổ chức khác');
    response.status(isDuplicateBankAccount ? 409 : 400).json({
      message: errorMessage
    });
  }
}



/**
 * Hàm xử lý đăng xuất tất cả thiết bị.
 * Mục đích: thu hồi toàn bộ refresh session theo userId từ access token.
 */
export async function handleLogoutAll(request: Request, response: Response): Promise<void> {
  const authenticatedUser = getAuthenticatedUser(request);

  if (!authenticatedUser) {
    response.status(401).json({
      message: 'Bạn chưa đăng nhập hoặc phiên đăng nhập không hợp lệ.'
    });
    return;
  }

  await revokeAllRefreshSessionsForUser(authenticatedUser.userId);
  response.status(200).json({
    message: 'Đã đăng xuất khỏi tất cả thiết bị.'
  });
}

/**
 * Hàm lấy hồ sơ người dùng hiện tại theo access token.
 * Mục đích: trả về thông tin tối thiểu phục vụ guard phân quyền ở frontend.
 */
export async function handleGetCurrentUserProfile(request: Request, response: Response): Promise<void> {
  const authenticatedUser = getAuthenticatedUser(request);

  if (!authenticatedUser) {
    response.status(401).json({
      message: 'Bạn chưa đăng nhập hoặc phiên đăng nhập không hợp lệ.'
    });
    return;
  }

  const user = await findUserById(authenticatedUser.userId);
  if (!user) {
    response.status(404).json({
      message: 'Không tìm thấy thông tin người dùng.'
    });
    return;
  }

  response.status(200).json({
    user: {
      id: user.id,
      fullName: user.fullName,
      role: user.role
    }
  });
}

