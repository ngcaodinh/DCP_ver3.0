import type { Response } from 'express';
import { z } from 'zod';
import { type AuthenticatedRequest } from '../middleware/authenticationMiddleware';
import { recordAdminAuditLog } from '../services/audit-log.service';
import {
  confirmGovernanceBootstrap,
  createGovernanceSeat,
  getVerifiedGovernanceBootstrapState,
  listGovernanceSeats,
  suspendGovernanceSeat
} from '../services/governanceSeatService';
import { sendErrorFromUnknown, sendErrorResponse, sendSuccessResponse } from '../utils/apiResponse';
import { extractAuditRequestContext } from '../utils/auditRequestContext';

const createSeatSchema = z.object({
  walletAddress: z.string().trim().min(1).max(128),
  role: z.enum(['executive_chair', 'executive_member']),
  displayName: z.string().trim().min(1).max(160)
}).strict();

const walletAddressParamsSchema = z.object({ walletAddress: z.string().trim().min(1).max(128) });
const bootstrapConfirmationSchema = z.object({
  transactionHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/)
}).strict();

/** Lấy các ghế hiện tại; route middleware đã xác minh admin hoặc Ủy ban còn hiệu lực. */
export async function handleGetGovernanceSeats(
  _request: AuthenticatedRequest,
  response: Response
): Promise<void> {
  try {
    sendSuccessResponse(response, 200, 'Đã lấy danh sách ghế Ủy ban.', await listGovernanceSeats());
  } catch (error) {
    sendErrorFromUnknown(response, error, 'Không thể lấy danh sách ghế Ủy ban.');
  }
}

/** Trả proof bootstrap bền vững để UI không suy ra trạng thái mở chỉ vì mất RPC hoặc biến môi trường. */
export async function handleGetGovernanceBootstrapState(
  _request: AuthenticatedRequest,
  response: Response
): Promise<void> {
  try {
    sendSuccessResponse(response, 200, 'Đã lấy proof bootstrap Ủy ban.', await getVerifiedGovernanceBootstrapState());
  } catch (error) {
    sendErrorFromUnknown(response, error, 'Không thể lấy proof bootstrap Ủy ban.');
  }
}

/** Tạo một ghế mới và ghi audit canonical, không bao giờ nhận private key từ client. */
export async function handleCreateGovernanceSeat(
  request: AuthenticatedRequest,
  response: Response
): Promise<void> {
  if (!request.authenticatedUser) {
    sendErrorResponse(response, 401, 'Bạn chưa đăng nhập.', 'UNAUTHENTICATED');
    return;
  }
  const parsed = createSeatSchema.safeParse(request.body);
  if (!parsed.success) {
    sendErrorResponse(response, 400, 'Dữ liệu ghế Ủy ban không hợp lệ.', 'VALIDATION_ERROR');
    return;
  }
  try {
    const seat = await createGovernanceSeat(parsed.data);
    await recordAdminAuditLog({
      actorType: 'ADMIN',
      adminId: request.authenticatedUser.userId,
      adminRole: request.authenticatedUser.role,
      actionType: 'COMMITTEE_SEAT_CREATED',
      targetId: seat.userId,
      targetType: 'COMMITTEE_SEAT',
      requestContext: extractAuditRequestContext(request),
      context: { role: seat.role, displayName: seat.displayName }
    });
    sendSuccessResponse(response, 201, 'Đã cấp ghế Ủy ban.', seat);
  } catch (error) {
    sendErrorFromUnknown(response, error, 'Không thể cấp ghế Ủy ban.');
  }
}

/** Xác minh transaction bootstrap bằng RPC rồi lưu proof server-side để restart không phụ thuộc state của trình duyệt. */
export async function handleConfirmGovernanceBootstrap(
  request: AuthenticatedRequest,
  response: Response
): Promise<void> {
  if (!request.authenticatedUser) {
    sendErrorResponse(response, 401, 'Bạn chưa đăng nhập.', 'UNAUTHENTICATED');
    return;
  }
  const parsed = bootstrapConfirmationSchema.safeParse(request.body);
  if (!parsed.success) {
    sendErrorResponse(response, 400, 'Transaction bootstrap không hợp lệ.', 'VALIDATION_ERROR');
    return;
  }
  try {
    const state = await confirmGovernanceBootstrap(parsed.data);
    await recordAdminAuditLog({
      actorType: 'ADMIN',
      adminId: request.authenticatedUser.userId,
      adminRole: request.authenticatedUser.role,
      actionType: 'COMMITTEE_SEATS_BOOTSTRAPPED',
      targetId: state.contractAddress,
      targetType: 'COMMITTEE_SEAT',
      requestContext: extractAuditRequestContext(request),
      context: { transactionHash: state.transactionHash, chainId: state.chainId, seatCount: state.seats.length }
    });
    sendSuccessResponse(response, 200, 'Đã xác minh và lưu proof bootstrap Ủy ban.', state);
  } catch (error) {
    sendErrorFromUnknown(response, error, 'Không thể xác minh bootstrap Ủy ban.');
  }
}

/** Thu ghế bằng cách suspend và bump authVersion; record lịch sử không bị xóa. */
export async function handleSuspendGovernanceSeat(
  request: AuthenticatedRequest,
  response: Response
): Promise<void> {
  if (!request.authenticatedUser) {
    sendErrorResponse(response, 401, 'Bạn chưa đăng nhập.', 'UNAUTHENTICATED');
    return;
  }
  const parsed = walletAddressParamsSchema.safeParse(request.params);
  if (!parsed.success) {
    sendErrorResponse(response, 400, 'Địa chỉ ví ghế không hợp lệ.', 'VALIDATION_ERROR');
    return;
  }
  try {
    const seat = await suspendGovernanceSeat(parsed.data.walletAddress);
    await recordAdminAuditLog({
      actorType: 'ADMIN',
      adminId: request.authenticatedUser.userId,
      adminRole: request.authenticatedUser.role,
      actionType: 'COMMITTEE_SEAT_SUSPENDED',
      targetId: seat.userId,
      targetType: 'COMMITTEE_SEAT',
      requestContext: extractAuditRequestContext(request),
      context: { role: seat.role, displayName: seat.displayName }
    });
    sendSuccessResponse(response, 200, 'Đã thu ghế Ủy ban và thu hồi phiên đang mở.', seat);
  } catch (error) {
    sendErrorFromUnknown(response, error, 'Không thể thu ghế Ủy ban.');
  }
}
