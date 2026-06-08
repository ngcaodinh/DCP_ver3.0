import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/authenticationMiddleware';
import {
  getAdminDashboardAuditLogs,
  getAdminDashboardMetrics,
  getAdminDashboardTimelineEvents,
  getAdminSystemErrorLogs,
  getAdminGuestSessionSummary,
  listAdminGuestSessions,
  invalidateAdminGuestSession,
  type SystemErrorLogCategory,
  type SystemErrorLogReadStateFilter,
  type AdminGuestSessionListFilters,
  updateAdminSystemErrorLogReadState
} from '../services/adminDashboardService';
import { sendErrorFromUnknown, sendErrorResponse, sendSuccessResponse } from '../utils/apiResponse';

/**
 * Hàm parse giá trị category cho API log lỗi.
 * Mục đích: chỉ cho phép lọc theo nhóm lỗi hợp lệ để tránh query sai ngữ nghĩa.
 */
function parseSystemErrorLogCategory(rawCategory: unknown): SystemErrorLogCategory | 'all' | null {
  if (typeof rawCategory === 'undefined' || rawCategory === null || rawCategory === '') {
    return 'all';
  }

  const normalizedCategory = String(rawCategory).trim();
  const allowedCategoryList: Array<SystemErrorLogCategory | 'all'> = [
    'all',
    'TRANSFER_TIMEOUT_15_MINUTES',
    'DEPOSIT',
    'DISBURSEMENT',
    'AUTH'
  ];

  return allowedCategoryList.includes(normalizedCategory as SystemErrorLogCategory | 'all')
    ? (normalizedCategory as SystemErrorLogCategory | 'all')
    : null;
}

/**
 * Hàm parse giá trị readState cho API log lỗi.
 * Mục đích: đồng bộ filter read/unread theo đúng các trạng thái backend hỗ trợ.
 */
function parseSystemErrorLogReadState(rawReadState: unknown): SystemErrorLogReadStateFilter | null {
  if (typeof rawReadState === 'undefined' || rawReadState === null || rawReadState === '') {
    return 'all';
  }

  const normalizedReadState = String(rawReadState).trim();
  const allowedReadStateList: SystemErrorLogReadStateFilter[] = ['all', 'read', 'unread'];

  return allowedReadStateList.includes(normalizedReadState as SystemErrorLogReadStateFilter)
    ? (normalizedReadState as SystemErrorLogReadStateFilter)
    : null;
}

/**
 * Hàm parse giá trị số nguyên từ request param với clamp và default.
 * Mục đích: tái sử dụng logic parse cho cả limit và page params, tránh trùng lặp code.
 *
 * @param raw - Giá trị thô từ request
 * @param min - Giá trị tối thiểu
 * @param max - Giá trị tối đa
 * @param fallback - Giá trị trả về khi invalid
 */
function parseIntParam(raw: unknown, min: number, max: number, fallback: number): number {
  if (typeof raw === 'undefined' || raw === null || raw === '') {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

/**
 * Hàm parse tham số limit cho API log lỗi.
 * Mục đích: giới hạn kích thước dữ liệu trả về, giảm rủi ro lạm dụng tài nguyên.
 */
function parseSystemErrorLogLimit(rawLimitCount: unknown): number | null {
  const result = parseIntParam(rawLimitCount, 1, 200, 0);
  return result === 0 ? null : result;
}

/**
 * Hàm parse cờ isRead từ body request.
 * Mục đích: kiểm soát kiểu dữ liệu đầu vào khi cập nhật trạng thái đọc log lỗi.
 */
function parseSystemErrorLogReadFlag(rawIsRead: unknown): boolean | null {
  if (typeof rawIsRead === 'undefined') {
    return true;
  }

  if (typeof rawIsRead !== 'boolean') {
    return null;
  }

  return rawIsRead;
}

/**
 * Hàm parse tham số limit cho guest session list.
 * Mục đích: giới hạn kích thước trang trong khoảng 1-100, default = 20.
 */
function parseLimitParam(rawLimit: unknown): number {
  return parseIntParam(rawLimit, 1, 100, 20);
}

/**
 * Hàm parse tham số phân trang page cho guest session list.
 * Mục đích: đảm bảo page luôn là số nguyên dương, default = 1.
 */
function parsePageParam(rawPage: unknown): number {
  return parseIntParam(rawPage, 1, 999999, 1);
}

/**
 * Hàm parse và validate sessionId thành UUID hợp lệ.
 * Mục đích: ngăn IDOR bằng cách chỉ chấp nhận UUID chuẩn cho invalidate endpoint.
 */
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseAndValidateSessionId(rawSessionId: unknown): string | null {
  const value = String(rawSessionId || '').trim();
  return value && UUID_V4_REGEX.test(value) ? value : null;
}

/**
 * Hàm xử lý request lấy metric tổng quan hệ thống cho admin.
 * Mục đích: trả số liệu thật phục vụ khối KPI của trang `/admin`.
 */
export async function handleGetAdminDashboardMetrics(request: AuthenticatedRequest, response: Response): Promise<void> {
  if (!request.authenticatedUser) {
    sendErrorResponse(response, 401, 'Bạn chưa đăng nhập hoặc phiên đăng nhập không hợp lệ.', 'UNAUTHENTICATED');
    return;
  }

  try {
    const metrics = await getAdminDashboardMetrics();
    sendSuccessResponse(response, 200, 'Lấy metrics tổng quan hệ thống thành công.', metrics);
  } catch (error) {
    sendErrorFromUnknown(response, error, 'Không thể lấy metrics tổng quan hệ thống.');
  }
}

/**
 * Hàm xử lý request lấy timeline tổng quan cho admin.
 * Mục đích: trả danh sách hoạt động gần đây bằng dữ liệu thật từ backend.
 */
export async function handleGetAdminDashboardTimeline(request: AuthenticatedRequest, response: Response): Promise<void> {
  if (!request.authenticatedUser) {
    sendErrorResponse(response, 401, 'Bạn chưa đăng nhập hoặc phiên đăng nhập không hợp lệ.', 'UNAUTHENTICATED');
    return;
  }

  try {
    const events = await getAdminDashboardTimelineEvents();
    sendSuccessResponse(response, 200, 'Lấy timeline tổng quan thành công.', { events });
  } catch (error) {
    sendErrorFromUnknown(response, error, 'Không thể lấy timeline tổng quan.');
  }
}

/**
 * Hàm xử lý request lấy audit log tổng quan cho admin.
 * Mục đích: trả dữ liệu kiểm toán thật để hiển thị bảng nhật ký trên dashboard.
 */
export async function handleGetAdminDashboardAuditLogs(request: AuthenticatedRequest, response: Response): Promise<void> {
  if (!request.authenticatedUser) {
    sendErrorResponse(response, 401, 'Bạn chưa đăng nhập hoặc phiên đăng nhập không hợp lệ.', 'UNAUTHENTICATED');
    return;
  }

  try {
    const logs = await getAdminDashboardAuditLogs();
    sendSuccessResponse(response, 200, 'Lấy audit log tổng quan thành công.', { logs });
  } catch (error) {
    sendErrorFromUnknown(response, error, 'Không thể lấy audit log tổng quan.');
  }
}

/**
 * Hàm xử lý request lấy danh sách log lỗi hệ thống cho Admin.
 * Mục đích: cung cấp dữ liệu phân loại lỗi, hỗ trợ Admin theo dõi và kiểm soát trạng thái xử lý.
 */
export async function handleGetAdminSystemErrorLogs(request: AuthenticatedRequest, response: Response): Promise<void> {
  if (!request.authenticatedUser) {
    sendErrorResponse(response, 401, 'Bạn chưa đăng nhập hoặc phiên đăng nhập không hợp lệ.', 'UNAUTHENTICATED');
    return;
  }

  const category = parseSystemErrorLogCategory(request.query.category);
  if (!category) {
    sendErrorResponse(response, 400, 'category không hợp lệ.', 'INVALID_SYSTEM_ERROR_LOG_CATEGORY');
    return;
  }

  const readState = parseSystemErrorLogReadState(request.query.readState);
  if (!readState) {
    sendErrorResponse(response, 400, 'readState không hợp lệ.', 'INVALID_SYSTEM_ERROR_LOG_READ_STATE');
    return;
  }

  const limitCount = parseSystemErrorLogLimit(request.query.limitCount);
  if (!limitCount) {
    sendErrorResponse(response, 400, 'limitCount phải nằm trong khoảng từ 1 đến 200.', 'INVALID_SYSTEM_ERROR_LOG_LIMIT');
    return;
  }

  try {
    const errorLogs = await getAdminSystemErrorLogs(request.authenticatedUser.userId, {
      category,
      readState,
      limitCount
    });

    sendSuccessResponse(response, 200, 'Lấy log lỗi hệ thống thành công.', errorLogs);
  } catch (error) {
    sendErrorFromUnknown(response, error, 'Không thể lấy log lỗi hệ thống.');
  }
}

/**
 * Hàm xử lý request cập nhật trạng thái đọc cho một log lỗi hệ thống.
 * Mục đích: cho phép Admin đánh dấu log đã đọc hoặc hoàn tác về chưa đọc.
 */
export async function handleUpdateAdminSystemErrorLogReadState(request: AuthenticatedRequest, response: Response): Promise<void> {
  if (!request.authenticatedUser) {
    sendErrorResponse(response, 401, 'Bạn chưa đăng nhập hoặc phiên đăng nhập không hợp lệ.', 'UNAUTHENTICATED');
    return;
  }

  const normalizedLogId = String(request.params.logId || '').trim();
  if (!normalizedLogId) {
    sendErrorResponse(response, 400, 'logId không hợp lệ.', 'INVALID_SYSTEM_ERROR_LOG_ID');
    return;
  }

  const isRead = parseSystemErrorLogReadFlag(request.body?.isRead);
  if (isRead === null) {
    sendErrorResponse(response, 400, 'isRead phải là boolean.', 'INVALID_SYSTEM_ERROR_LOG_READ_FLAG');
    return;
  }

  try {
    const updatedReadState = await updateAdminSystemErrorLogReadState(
      request.authenticatedUser.userId,
      normalizedLogId,
      isRead
    );

    sendSuccessResponse(response, 200, 'Cập nhật trạng thái đọc log lỗi thành công.', updatedReadState);
  } catch (error) {
    sendErrorFromUnknown(response, error, 'Không thể cập nhật trạng thái đọc log lỗi.');
  }
}

/**
 * Hàm xây dựng bộ lọc từ query params cho guest session list API.
 * Mục đích: parse và validate các tham số lọc từ request, loại bỏ tham số rỗng/invalid.
 */
const VALID_GUEST_SESSION_STATUSES = ['ACTIVE', 'EXPIRED', 'CLAIMED', 'PURGED'] as const;

function buildGuestSessionFilters(
  query: Record<string, unknown>
): { filters: AdminGuestSessionListFilters; invalidStatus: boolean } {
  const rawStatus = query.status;
  const isValidStatus = typeof rawStatus === 'string' && VALID_GUEST_SESSION_STATUSES.includes(rawStatus as (typeof VALID_GUEST_SESSION_STATUSES)[number]);

  return {
    filters: {
      status: isValidStatus ? rawStatus as AdminGuestSessionListFilters['status'] : undefined,
      walletAddress: typeof query.walletAddress === 'string' ? query.walletAddress : undefined,
      ipAddress: typeof query.ipAddress === 'string' ? query.ipAddress : undefined,
      startDate: typeof query.startDate === 'string' ? query.startDate : undefined,
      endDate: typeof query.endDate === 'string' ? query.endDate : undefined
    },
    invalidStatus: typeof rawStatus === 'string' && !isValidStatus
  };
}

/**
 * Hàm xử lý request lấy thống kê tổng quan guest sessions cho Admin.
 * Mục đích: trả KPI cards về sessions, gas sponsored, donation amounts.
 */
export async function handleGetAdminGuestSessionSummary(
  request: AuthenticatedRequest,
  response: Response
): Promise<void> {
  if (!request.authenticatedUser) {
    sendErrorResponse(response, 401, 'Bạn chưa đăng nhập hoặc phiên đăng nhập không hợp lệ.', 'UNAUTHENTICATED');
    return;
  }

  try {
    const summary = await getAdminGuestSessionSummary();
    sendSuccessResponse(response, 200, 'Lấy thống kê guest sessions thành công.', summary);
  } catch (error) {
    sendErrorFromUnknown(response, error, 'Không thể lấy thống kê guest sessions.');
  }
}

/**
 * Hàm xử lý request lấy danh sách guest sessions có phân trang cho Admin.
 * Mục đích: trả bảng sessions với filter theo status, wallet, IP, ngày tạo.
 */
export async function handleListAdminGuestSessions(
  request: AuthenticatedRequest,
  response: Response
): Promise<void> {
  if (!request.authenticatedUser) {
    sendErrorResponse(response, 401, 'Bạn chưa đăng nhập hoặc phiên đăng nhập không hợp lệ.', 'UNAUTHENTICATED');
    return;
  }

  const page = parsePageParam(request.query.page);
  const limit = parseLimitParam(request.query.limit);
  const { filters, invalidStatus } = buildGuestSessionFilters(request.query as Record<string, unknown>);

  if (invalidStatus) {
    sendErrorResponse(response, 400, 'status không hợp lệ. Chỉ chấp nhận: ACTIVE, EXPIRED, CLAIMED, PURGED.', 'INVALID_GUEST_SESSION_STATUS');
    return;
  }

  try {
    const result = await listAdminGuestSessions(page, limit, filters);
    sendSuccessResponse(response, 200, 'Lấy danh sách guest sessions thành công.', result);
  } catch (error) {
    sendErrorFromUnknown(response, error, 'Không thể lấy danh sách guest sessions.');
  }
}

/**
 * Hàm xử lý request vô hiệu hóa một guest session của Admin.
 * Mục đích: cho phép admin manually expire session khi phát hiện hành vi bất thường.
 */
export async function handleInvalidateAdminGuestSession(
  request: AuthenticatedRequest,
  response: Response
): Promise<void> {
  if (!request.authenticatedUser) {
    sendErrorResponse(response, 401, 'Bạn chưa đăng nhập hoặc phiên đăng nhập không hợp lệ.', 'UNAUTHENTICATED');
    return;
  }

  const sessionId = parseAndValidateSessionId(request.params.sessionId);
  if (!sessionId) {
    sendErrorResponse(response, 400, 'sessionId phải là UUID hợp lệ.', 'INVALID_GUEST_SESSION_ID');
    return;
  }

  try {
    const result = await invalidateAdminGuestSession(sessionId);
    sendSuccessResponse(response, 200, 'Vô hiệu hóa guest session thành công.', result);
  } catch (error) {
    sendErrorFromUnknown(response, error, 'Không thể vô hiệu hóa guest session.');
  }
}
