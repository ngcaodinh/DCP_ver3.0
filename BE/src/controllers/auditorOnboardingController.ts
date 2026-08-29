import { Request, Response } from 'express';
import { z } from 'zod';
import {
  executeAuditorStake,
  getAuditorOnboardingStatus,
  registerAuditorIntent,
  resumeAuditorIntent,
  requestAuditorUnstake,
  updateAuditorPayoutAccountForUser,
  withdrawAuditorStake
} from '../services/auditorOnboardingService';
import { createAuditorRewardWithdrawalPayout } from '../services/auditorPayoutCreationService';
import { cancelAuditorRewardPayoutAfterManualReview, retryAuditorPayoutBurnAfterManualReview } from '../services/auditorPayoutService';
import { auditorPayoutAccountSchema } from '../validators/auditorPayoutAccountValidator';
import { sendErrorFromUnknown, sendSuccessResponse } from '../utils/apiResponse';
import type { AuthenticatedRequest } from '../middleware/authenticationMiddleware';
import { ApplicationError } from '../utils/applicationError';
import { recordAdminAuditLog } from '../services/audit-log.service';
import { getAuditorEarnings, getAuditorStakeOverview } from '../services/auditorPortalReadService';

const registerSchema = z.object({
  identityToken: z.string().trim().min(20),
  fullName: z.string().trim().min(1).max(200).optional(),
  payoutAccount: auditorPayoutAccountSchema
});
const resumeSchema = z.object({ identityToken: z.string().trim().min(20) });
const stakeSchema = z.object({ amount: z.coerce.bigint().positive().optional() });
const unstakeSchema = z.object({ amount: z.coerce.bigint().positive() });
const rewardWithdrawSchema = z.object({ amountVnd: z.coerce.number().int().positive() });
const intentParamsSchema = z.object({ intentId: z.string().uuid() });
const retryPayoutBurnParamsSchema = z.object({ payoutId: z.string().uuid() });
const retryPayoutBurnSchema = z.object({
  payosTransferId: z.string().trim().min(1).max(200),
  reason: z.string().trim().min(10).max(1_000)
});
const cancelRewardPayoutSchema = z.object({ reason: z.string().trim().min(10).max(1_000) });
const stakeOverviewQuerySchema = z.object({ withExitEligibility: z.enum(['1']).optional() });

function getCorrelationId(request: Request): string | undefined {
  return request.headers['x-request-id']?.toString();
}

function getAuthenticatedUserId(request: Request): string | null {
  return (request as AuthenticatedRequest).authenticatedUser?.userId ?? null;
}

export async function handleRegisterAuditorIntent(request: Request, response: Response): Promise<void> {
  const parsed = registerSchema.safeParse(request.body);
  if (!parsed.success) {
    sendErrorFromUnknown(response, new ApplicationError('Dữ liệu đăng ký Kiểm toán viên không hợp lệ.', 400, 'VALIDATION_ERROR'), 'Dữ liệu đăng ký Kiểm toán viên không hợp lệ.', getCorrelationId(request));
    return;
  }
  try {
    const result = await registerAuditorIntent({
      ...parsed.data,
      ipAddress: request.headers['x-client-ip']?.toString() || request.ip || 'unknown',
      userAgent: request.headers['x-client-user-agent']?.toString() || 'unknown'
    });
    sendSuccessResponse(response, 201, 'Đã tạo yêu cầu đăng ký Kiểm toán viên.', result, result.correlationId);
  } catch (error) {
    sendErrorFromUnknown(response, error, 'Không thể tạo yêu cầu đăng ký Kiểm toán viên.', getCorrelationId(request));
  }
}

/** Khôi phục onboarding Auditor đã có sau khi Google chứng minh quyền sở hữu tài khoản. */
export async function handleResumeAuditorIntent(request: Request, response: Response): Promise<void> {
  const parsed = resumeSchema.safeParse(request.body);
  if (!parsed.success) {
    sendErrorFromUnknown(response, new ApplicationError('Dữ liệu khôi phục hồ sơ Kiểm toán viên không hợp lệ.', 400, 'VALIDATION_ERROR'), 'Dữ liệu khôi phục hồ sơ Kiểm toán viên không hợp lệ.', getCorrelationId(request));
    return;
  }
  try {
    const result = await resumeAuditorIntent({
      ...parsed.data,
      ipAddress: request.headers['x-client-ip']?.toString() || request.ip || 'unknown',
      userAgent: request.headers['x-client-user-agent']?.toString() || 'unknown'
    });
    sendSuccessResponse(response, 200, 'Đã khôi phục hồ sơ Kiểm toán viên đang chờ kích hoạt.', result, result.correlationId);
  } catch (error) {
    sendErrorFromUnknown(response, error, 'Không thể khôi phục hồ sơ Kiểm toán viên.', getCorrelationId(request));
  }
}

export async function handleExecuteAuditorStake(request: Request, response: Response): Promise<void> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return;
  const parsed = stakeSchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    sendErrorFromUnknown(response, new ApplicationError('Số tiền đặt cọc không hợp lệ.', 400, 'VALIDATION_ERROR'), 'Số tiền đặt cọc không hợp lệ.', getCorrelationId(request));
    return;
  }
  try {
    const result = parsed.data.amount === undefined
      ? await executeAuditorStake(userId)
      : await executeAuditorStake(userId, parsed.data.amount);
    sendSuccessResponse(response, 202, 'Giao dịch đặt cọc đang được xác minh.', result, getCorrelationId(request));
  } catch (error) {
    sendErrorFromUnknown(response, error, 'Không thể gửi giao dịch đặt cọc.', getCorrelationId(request));
  }
}

export async function handleRequestAuditorUnstake(request: Request, response: Response): Promise<void> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return;
  const parsed = unstakeSchema.safeParse(request.body);
  if (!parsed.success) {
    sendErrorFromUnknown(response, new ApplicationError('Số tiền rút cọc không hợp lệ.', 400, 'VALIDATION_ERROR'), 'Số tiền rút cọc không hợp lệ.', getCorrelationId(request));
    return;
  }
  try {
    const result = await requestAuditorUnstake(userId, parsed.data.amount);
    sendSuccessResponse(response, 202, 'Yêu cầu rút cọc đang được gửi lên blockchain.', result, getCorrelationId(request));
  } catch (error) {
    sendErrorFromUnknown(response, error, 'Không thể yêu cầu rút cọc.', getCorrelationId(request));
  }
}

export async function handleWithdrawAuditorStake(request: Request, response: Response): Promise<void> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return;
  try {
    const result = await withdrawAuditorStake(userId);
    sendSuccessResponse(response, 200, 'Đã tạo lệnh chi trả tiền rút cọc.', result, getCorrelationId(request));
  } catch (error) {
    sendErrorFromUnknown(response, error, 'Không thể rút cọc.', getCorrelationId(request));
  }
}

/** Tạo payout cho toàn bộ hoặc một phần DCT thưởng đã được credit vào ví Auditor. */
export async function handleWithdrawAuditorReward(request: Request, response: Response): Promise<void> {
  const authenticatedUser = (request as AuthenticatedRequest).authenticatedUser;
  if (!authenticatedUser) return;
  if (authenticatedUser.role !== 'auditor') {
    sendErrorFromUnknown(response, new ApplicationError('Chỉ tài khoản Kiểm toán viên mới có thể rút tiền thưởng.', 403, 'FORBIDDEN'), 'Không thể rút tiền thưởng.', getCorrelationId(request));
    return;
  }
  const parsed = rewardWithdrawSchema.safeParse(request.body);
  if (!parsed.success) {
    sendErrorFromUnknown(response, new ApplicationError('Số tiền thưởng rút không hợp lệ.', 400, 'VALIDATION_ERROR'), 'Số tiền thưởng rút không hợp lệ.', getCorrelationId(request));
    return;
  }
  try {
    const payout = await createAuditorRewardWithdrawalPayout({ auditorUserId: authenticatedUser.userId, amountVnd: parsed.data.amountVnd });
    sendSuccessResponse(response, 202, 'Đã tạo lệnh chi trả tiền thưởng.', { payoutId: payout.payoutId }, getCorrelationId(request));
  } catch (error) {
    sendErrorFromUnknown(response, error, 'Không thể rút tiền thưởng.', getCorrelationId(request));
  }
}

/** Cho phép admin retry burn chỉ sau khi đã đối chiếu thủ công giao dịch PayOS cùng lý do audit bắt buộc. */
export async function handleRetryAuditorPayoutBurn(request: Request, response: Response): Promise<void> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return;
  const params = retryPayoutBurnParamsSchema.safeParse(request.params);
  const body = retryPayoutBurnSchema.safeParse(request.body);
  if (!params.success || !body.success) {
    sendErrorFromUnknown(response, new ApplicationError('Dữ liệu retry burn payout không hợp lệ.', 400, 'VALIDATION_ERROR'), 'Dữ liệu retry burn payout không hợp lệ.', getCorrelationId(request));
    return;
  }
  try {
    await recordAdminAuditLog({
      actorType: 'ADMIN',
      adminId: userId,
      adminRole: (request as AuthenticatedRequest).authenticatedUser?.role ?? 'admin',
      actionType: 'AUDITOR_PAYOUT_BURN_RETRY_REQUESTED',
      targetId: params.data.payoutId,
      targetType: 'AUDITOR_PAYOUT',
      reason: body.data.reason,
      ipAddress: request.headers['x-client-ip']?.toString() || request.ip || null,
      userAgent: request.headers['user-agent']?.toString() || null,
      context: { payoutId: params.data.payoutId }
    });
    await retryAuditorPayoutBurnAfterManualReview(params.data.payoutId, body.data.payosTransferId);
    sendSuccessResponse(response, 200, 'Đã gửi lại lệnh burn DCT cho payout sau khi đối chiếu PayOS.', { payoutId: params.data.payoutId }, getCorrelationId(request));
  } catch (error) {
    sendErrorFromUnknown(response, error, 'Không thể retry burn DCT cho payout.', getCorrelationId(request));
  }
}

/** Hủy payout thưởng kẹt trước PayOS sau audit admin bắt buộc để trả lại quyền rút cho Auditor. */
export async function handleCancelAuditorRewardPayout(request: Request, response: Response): Promise<void> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return;
  const params = retryPayoutBurnParamsSchema.safeParse(request.params);
  const body = cancelRewardPayoutSchema.safeParse(request.body);
  if (!params.success || !body.success) {
    sendErrorFromUnknown(response, new ApplicationError('Dữ liệu hủy payout thưởng không hợp lệ.', 400, 'VALIDATION_ERROR'), 'Dữ liệu hủy payout thưởng không hợp lệ.', getCorrelationId(request));
    return;
  }
  try {
    await recordAdminAuditLog({
      actorType: 'ADMIN',
      adminId: userId,
      adminRole: (request as AuthenticatedRequest).authenticatedUser?.role ?? 'admin',
      actionType: 'AUDITOR_REWARD_PAYOUT_CANCEL_REQUESTED',
      targetId: params.data.payoutId,
      targetType: 'AUDITOR_PAYOUT',
      reason: body.data.reason,
      ipAddress: request.headers['x-client-ip']?.toString() || request.ip || null,
      userAgent: request.headers['user-agent']?.toString() || null,
      context: { payoutId: params.data.payoutId }
    });
    await cancelAuditorRewardPayoutAfterManualReview(params.data.payoutId, body.data.reason);
    sendSuccessResponse(response, 200, 'Đã hủy payout thưởng chưa gửi PayOS và giải phóng khóa ví.', { payoutId: params.data.payoutId }, getCorrelationId(request));
  } catch (error) {
    sendErrorFromUnknown(response, error, 'Không thể hủy payout thưởng.', getCorrelationId(request));
  }
}

/** Cập nhật tài khoản nhận payout với schema whitelist và không bao giờ nhận bankCode từ client. */
export async function handleUpdateAuditorPayoutAccount(request: Request, response: Response): Promise<void> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return;
  const parsed = auditorPayoutAccountSchema.safeParse(request.body);
  if (!parsed.success) {
    sendErrorFromUnknown(response, new ApplicationError('Dữ liệu tài khoản ngân hàng không hợp lệ.', 400, 'VALIDATION_ERROR'), 'Dữ liệu tài khoản ngân hàng không hợp lệ.', getCorrelationId(request));
    return;
  }
  try {
    const account = await updateAuditorPayoutAccountForUser(userId, parsed.data);
    sendSuccessResponse(response, 200, 'Đã cập nhật tài khoản ngân hàng nhận tiền.', account, getCorrelationId(request));
  } catch (error) {
    sendErrorFromUnknown(response, error, 'Không thể cập nhật tài khoản ngân hàng.', getCorrelationId(request));
  }
}

export async function handleGetAuditorOnboardingStatus(request: Request, response: Response): Promise<void> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return;
  const parsed = intentParamsSchema.safeParse(request.params);
  if (!parsed.success) {
    sendErrorFromUnknown(response, new ApplicationError('Mã yêu cầu không hợp lệ.', 400, 'VALIDATION_ERROR'), 'Mã yêu cầu không hợp lệ.', getCorrelationId(request));
    return;
  }
  try {
    const result = await getAuditorOnboardingStatus(parsed.data.intentId, userId);
    sendSuccessResponse(response, 200, 'Đã lấy trạng thái đăng ký Kiểm toán viên.', result, getCorrelationId(request));
  } catch (error) {
    sendErrorFromUnknown(response, error, 'Không thể lấy trạng thái đăng ký Kiểm toán viên.', getCorrelationId(request));
  }
}

/** Trả tổng quan cọc cho chính Auditor, không dùng fresh-role guard để tài khoản bị suspend vẫn xem được tài sản. */
export async function handleGetAuditorStakeOverview(request: Request, response: Response): Promise<void> {
  const authenticatedUser = (request as AuthenticatedRequest).authenticatedUser;
  if (!authenticatedUser) return;
  if (authenticatedUser.role !== 'auditor') {
    sendErrorFromUnknown(response, new ApplicationError('Chỉ tài khoản Kiểm toán viên mới xem được thông tin này.', 403, 'FORBIDDEN'), 'Không thể lấy tổng quan cọc.', getCorrelationId(request));
    return;
  }
  const query = stakeOverviewQuerySchema.safeParse(request.query);
  if (!query.success) {
    sendErrorFromUnknown(response, new ApplicationError('Query tổng quan cọc không hợp lệ.', 400, 'VALIDATION_ERROR'), 'Không thể lấy tổng quan cọc.', getCorrelationId(request));
    return;
  }
  try {
    const withExitEligibility = query.data.withExitEligibility === '1';
    sendSuccessResponse(response, 200, 'Đã lấy tổng quan cọc.', await getAuditorStakeOverview(authenticatedUser.userId, withExitEligibility), getCorrelationId(request));
  } catch (error) {
    sendErrorFromUnknown(response, error, 'Không thể lấy tổng quan cọc.', getCorrelationId(request));
  }
}

/** Trả sổ tiền đã che PII cho chính Auditor với giới hạn đọc hữu hạn. */
export async function handleGetAuditorEarnings(request: Request, response: Response): Promise<void> {
  const authenticatedUser = (request as AuthenticatedRequest).authenticatedUser;
  if (!authenticatedUser) return;
  if (authenticatedUser.role !== 'auditor') {
    sendErrorFromUnknown(response, new ApplicationError('Chỉ tài khoản Kiểm toán viên mới xem được thông tin này.', 403, 'FORBIDDEN'), 'Không thể lấy lịch sử tiền.', getCorrelationId(request));
    return;
  }
  try {
    sendSuccessResponse(response, 200, 'Đã lấy lịch sử tiền.', await getAuditorEarnings(authenticatedUser.userId, request.query.limit), getCorrelationId(request));
  } catch (error) {
    sendErrorFromUnknown(response, error, 'Không thể lấy lịch sử tiền.', getCorrelationId(request));
  }
}
