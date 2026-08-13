import { Response } from 'express';
import { getLogger } from '../config/logger';
import { AuthenticatedRequest } from '../middleware/authenticationMiddleware';
import {
  getSybilUserList,
  getSybilUserDetail,
  toggleSybilStatus,
  getSybilSummaryMetrics,
  type SybilTogglePayload,
  type SybilUserListResponse,
  type SybilUserDetailRecord,
  type SybilSummaryMetrics
} from '../services/sybilService';
import { sendErrorFromUnknown, sendErrorResponse, sendSuccessResponse } from '../utils/apiResponse';

const logger = getLogger();

/** Hàm parse số nguyên dương từ query. Mục đích: dùng chung cho validate input API. */
function parsePositiveInteger(value: unknown): number | null {
  const parsedValue = Number(value);
  if (!Number.isFinite(parsedValue) || !Number.isInteger(parsedValue) || parsedValue <= 0) {
    return null;
  }
  return parsedValue;
}

/**
 * Hàm xử lý request lấy danh sách người dùng cho Sybil dashboard (phân trang).
 * Mục đích: cung cấp API endpoint GET /api/sybil/users — trả dữ liệu thật từ MongoDB.
 *
 * Query params:
 * - page: số trang (default: 1)
 * - limit: số items/trang (default: 10)
 * - riskLevel: lọc theo mức độ rủi ro ('low' | 'medium' | 'high' | 'critical' | 'all')
 * - sybilStatus: lọc theo trạng thái Sybil ('sybil' | 'normal' | 'all')
 * - search: tìm kiếm theo wallet address, email, hoặc userId
 */
export async function handleGetSybilUserList(
  request: AuthenticatedRequest,
  response: Response
): Promise<void> {
  if (!request.authenticatedUser) {
    sendErrorResponse(response, 401, 'Bạn chưa đăng nhập hoặc phiên đăng nhập không hợp lệ.', 'UNAUTHENTICATED');
    return;
  }

  const pageNumber = parsePositiveInteger(request.query.page) ?? 1;
  const pageSize = parsePositiveInteger(request.query.limit) ?? 10;
  const filterRiskLevel = String(request.query.riskLevel || 'all');
  const filterSybilStatus = String(request.query.sybilStatus || 'all');
  const searchQuery = String(request.query.search || '').trim();

  const allowedRiskLevels = ['all', 'low', 'medium', 'high', 'critical'];
  const allowedSybilStatuses = ['all', 'sybil', 'normal'];

  if (!allowedRiskLevels.includes(filterRiskLevel)) {
    sendErrorResponse(response, 400, 'Tham số riskLevel không hợp lệ.', 'VALIDATION_ERROR');
    return;
  }
  if (!allowedSybilStatuses.includes(filterSybilStatus)) {
    sendErrorResponse(response, 400, 'Tham số sybilStatus không hợp lệ.', 'VALIDATION_ERROR');
    return;
  }

  try {
    const result: SybilUserListResponse = await getSybilUserList(
      pageNumber,
      pageSize,
      filterRiskLevel !== 'all' ? filterRiskLevel : undefined,
      filterSybilStatus !== 'all' ? filterSybilStatus : undefined,
      searchQuery || undefined
    );

    sendSuccessResponse(
      response,
      200,
      'Lấy danh sách người dùng Sybil thành công.',
      result
    );
  } catch (error) {
    logger.error('Lấy danh sách Sybil user thất bại.', { errorMessage: (error as Error).message });
    sendErrorFromUnknown(response, error, 'Không thể lấy danh sách người dùng Sybil.');
  }
}

/**
 * Hàm xử lý request lấy chi tiết một người dùng.
 * Mục đích: cung cấp API endpoint GET /api/sybil/users/:userId — trả dữ liệu đầy đủ kèm donation history.
 */
export async function handleGetSybilUserDetail(
  request: AuthenticatedRequest,
  response: Response
): Promise<void> {
  if (!request.authenticatedUser) {
    sendErrorResponse(response, 401, 'Bạn chưa đăng nhập hoặc phiên đăng nhập không hợp lệ.', 'UNAUTHENTICATED');
    return;
  }

  const userId = String(request.params.userId || '').trim();
  if (!userId) {
    sendErrorResponse(response, 400, 'Thiếu tham số userId.', 'VALIDATION_ERROR');
    return;
  }

  try {
    const result: SybilUserDetailRecord | null = await getSybilUserDetail(userId);

    if (!result) {
      sendErrorResponse(response, 404, 'Không tìm thấy người dùng với userId đã cung cấp.', 'NOT_FOUND');
      return;
    }

    sendSuccessResponse(
      response,
      200,
      'Lấy chi tiết người dùng Sybil thành công.',
      result
    );
  } catch (error) {
    logger.error('Lấy chi tiết Sybil user thất bại.', {
      userId,
      errorMessage: (error as Error).message
    });
    sendErrorFromUnknown(response, error, 'Không thể lấy chi tiết người dùng Sybil.');
  }
}

/**
 * Hàm xử lý request toggle trạng thái Sybil.
 * Mục đích: cung cấp API endpoint POST /api/sybil/toggle — xử lý UC5.1.
 *
 * Logic phức tạp:
 * - Chỉ Admin hoặc Regulatory Bodies được phép thực hiện (đã check ở middleware route).
 * - Validate lý do (reason) phải có ít nhất 5 ký tự — OWASP: audit trail không được để trống.
 * - Sau khi toggle, service layer ghi audit log ngay lập tức.
 * - Response trả về kết quả để frontend update UI.
 */
export async function handleToggleSybilStatus(
  request: AuthenticatedRequest,
  response: Response
): Promise<void> {
  if (!request.authenticatedUser) {
    sendErrorResponse(response, 401, 'Bạn chưa đăng nhập hoặc phiên đăng nhập không hợp lệ.', 'UNAUTHENTICATED');
    return;
  }

  const userId = String(request.body?.userId || '').trim();
  const walletAddress = String(request.body?.walletAddress || '').trim();
  const action = String(request.body?.action || '').trim();
  const reason = String(request.body?.reason || '').trim();

  // Validate required fields — OWASP A01: broken access control + A07: security logging failures
  if (!userId && !walletAddress) {
    sendErrorResponse(response, 400, 'Phải cung cấp userId hoặc walletAddress.', 'VALIDATION_ERROR');
    return;
  }
  if (!['mark', 'unmark'].includes(action)) {
    sendErrorResponse(response, 400, 'Action phải là "mark" hoặc "unmark".', 'VALIDATION_ERROR');
    return;
  }
  if (!reason || reason.length < 5) {
    sendErrorResponse(response, 400, 'Lý do thay đổi phải có ít nhất 5 ký tự.', 'VALIDATION_ERROR');
    return;
  }

  // Build payload cho service layer
  const payload: SybilTogglePayload = {
    userId,
    walletAddress,
    action: action as 'mark' | 'unmark',
    reason,
    performedBy: request.authenticatedUser.userId,
    performedByRole: request.authenticatedUser.role,
    ipAddress: (request as AuthenticatedRequest & { ipMetadata?: { ipAddress: string } }).ipMetadata?.ipAddress || 'unknown',
    userAgent: (request.headers['user-agent'] as string) || 'unknown'
  };

  try {
    const result = await toggleSybilStatus(payload);

    // Log thành công cho OWASP A07: security logging — mọi thao tác nhạy cảm đều phải được ghi nhận.
    logger.info('[SYBIL-TOGGLE] Sybil status changed.', {
      performedByRole: request.authenticatedUser.role,
      userId,
      walletAddress,
      action,
      reason,
      performedBy: request.authenticatedUser.userId
    });

    sendSuccessResponse(
      response,
      200,
      result.message,
      result
    );
  } catch (error) {
    logger.error('Toggle Sybil status thất bại.', {
      userId,
      walletAddress,
      action,
      errorMessage: (error as Error).message
    });
    sendErrorFromUnknown(response, error, 'Không thể thay đổi trạng thái Sybil.');
  }
}

/**
 * Hàm xử lý request lấy metrics tổng hợp cho Sybil dashboard.
 * Mục đích: cung cấp API endpoint GET /api/sybil/summary-metrics — số liệu tổng quan thay vì mock data.
 */
export async function handleGetSybilSummaryMetrics(
  request: AuthenticatedRequest,
  response: Response
): Promise<void> {
  if (!request.authenticatedUser) {
    sendErrorResponse(response, 401, 'Bạn chưa đăng nhập hoặc phiên đăng nhập không hợp lệ.', 'UNAUTHENTICATED');
    return;
  }

  try {
    const result: SybilSummaryMetrics = await getSybilSummaryMetrics();

    sendSuccessResponse(
      response,
      200,
      'Lấy metrics tổng hợp Sybil thành công.',
      result
    );
  } catch (error) {
    logger.error('Lấy Sybil summary metrics thất bại.', { errorMessage: (error as Error).message });
    sendErrorFromUnknown(response, error, 'Không thể lấy metrics tổng hợp Sybil.');
  }
}
