import type { Response } from 'express';
import { z } from 'zod';
import type { AuthenticatedRequest } from '../middleware/authenticationMiddleware';
import {
  getPendingDisbursementCommitteeCases,
  prepareDisbursementVoteSignature,
  recoverDeadLetterDisbursementCommitteeExecution,
  voteOnDisbursement
} from '../services/disbursementCommitteeVoting.service';
import { recordAdminAuditLog } from '../services/audit-log.service';
import { sendErrorFromUnknown, sendErrorResponse, sendSuccessResponse } from '../utils/apiResponse';
import { extractAuditRequestContext } from '../utils/auditRequestContext';

const disbursementVoteSchema = z.object({
  decision: z.enum(['APPROVE', 'REJECT']),
  reason: z.string().trim().min(10).max(500),
  gpsRiskAcknowledged: z.boolean().optional().default(false),
  eip712Signature: z.object({
    signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
    signingRequestId: z.string().uuid()
  }).optional()
}).strict();
const disbursementSigningPayloadSchema = z.object({ decision: z.enum(['APPROVE', 'REJECT']), reason: z.string().trim().min(10).max(500) }).strict();
const recoverDeadLetterExecutionSchema = z.object({
  scope: z.enum(['EXECUTION', 'ON_CHAIN_DECISION']).default('EXECUTION'),
  reason: z.string().trim().min(20).max(500)
}).strict();

const disbursementVoteParamsSchema = z.object({ requestId: z.string().trim().min(1).max(200) });

/** Trả hàng chờ chỉ thuộc snapshot của ủy viên đang đăng nhập. */
export async function handleGetExecutivePendingDisbursements(
  request: AuthenticatedRequest,
  response: Response
): Promise<void> {
  if (!request.authenticatedUser) {
    sendErrorResponse(response, 401, 'Bạn chưa đăng nhập.', 'UNAUTHENTICATED');
    return;
  }
  try {
    const rawCursor = typeof request.query.cursor === 'string' ? request.query.cursor.trim() : '';
    const rawLimit = Number(request.query.limit || 20);
    const limitCount = Number.isInteger(rawLimit) && rawLimit >= 1 && rawLimit <= 50 ? rawLimit : 20;
    sendSuccessResponse(
      response,
      200,
      'Đã lấy hàng chờ biểu quyết giải ngân.',
      await getPendingDisbursementCommitteeCases(request.authenticatedUser.userId, rawCursor || null, limitCount)
    );
  } catch (error) {
    sendErrorFromUnknown(response, error, 'Không thể lấy hàng chờ biểu quyết giải ngân.');
  }
}

/** Ghi vote người thật vào snapshot; ký on-chain chỉ được worker kỹ thuật thực hiện sau khi đạt 3/5. */
export async function handleVoteOnDisbursement(
  request: AuthenticatedRequest,
  response: Response
): Promise<void> {
  if (!request.authenticatedUser) {
    sendErrorResponse(response, 401, 'Bạn chưa đăng nhập.', 'UNAUTHENTICATED');
    return;
  }
  const params = disbursementVoteParamsSchema.safeParse(request.params);
  const body = disbursementVoteSchema.safeParse(request.body);
  if (!params.success || !body.success) {
    sendErrorResponse(response, 400, 'Phiếu biểu quyết giải ngân không hợp lệ.', 'VALIDATION_ERROR');
    return;
  }
  try {
    const result = await voteOnDisbursement(request.authenticatedUser.userId, {
      requestId: params.data.requestId,
      ...body.data,
      requestContext: extractAuditRequestContext(request)
    });
    sendSuccessResponse(response, 200, 'Đã ghi nhận phiếu biểu quyết giải ngân.', result);
  } catch (error) {
    sendErrorFromUnknown(response, error, 'Không thể ghi nhận phiếu biểu quyết giải ngân.');
  }
}

/** Chuẩn bị payload EIP-712 từ epoch/domain server-side trước khi mở MetaMask. */
export async function handlePrepareDisbursementVoteSignature(
  request: AuthenticatedRequest,
  response: Response
): Promise<void> {
  if (!request.authenticatedUser) {
    sendErrorResponse(response, 401, 'Bạn chưa đăng nhập.', 'UNAUTHENTICATED');
    return;
  }
  const params = disbursementVoteParamsSchema.safeParse(request.params);
  const body = disbursementSigningPayloadSchema.safeParse(request.body);
  if (!params.success || !body.success) {
    sendErrorResponse(response, 400, 'Yêu cầu tạo payload chữ ký không hợp lệ.', 'VALIDATION_ERROR');
    return;
  }
  try {
    sendSuccessResponse(response, 200, 'Đã tạo payload chữ ký EIP-712.', await prepareDisbursementVoteSignature(request.authenticatedUser.userId, {
      requestId: params.data.requestId,
      decision: body.data.decision,
      reason: body.data.reason
    }));
  } catch (error) {
    sendErrorFromUnknown(response, error, 'Không thể tạo payload chữ ký EIP-712.');
  }
}

/** Khôi phục có audit một DLQ signer hoặc relay sau khi admin đã kiểm tra lỗi hạ tầng hoặc contract. */
export async function handleRecoverDeadLetterDisbursementExecution(
  request: AuthenticatedRequest,
  response: Response
): Promise<void> {
  if (!request.authenticatedUser) {
    sendErrorResponse(response, 401, 'Bạn chưa đăng nhập.', 'UNAUTHENTICATED');
    return;
  }
  const params = disbursementVoteParamsSchema.safeParse(request.params);
  const body = recoverDeadLetterExecutionSchema.safeParse(request.body);
  if (!params.success || !body.success) {
    sendErrorResponse(response, 400, 'Dữ liệu khôi phục execution không hợp lệ.', 'VALIDATION_ERROR');
    return;
  }
  try {
    await recoverDeadLetterDisbursementCommitteeExecution(params.data.requestId, body.data.scope);
    await recordAdminAuditLog({
      actorType: 'ADMIN',
      adminId: request.authenticatedUser.userId,
      adminRole: request.authenticatedUser.role,
      actionType: body.data.scope === 'ON_CHAIN_DECISION'
        ? 'DISBURSEMENT_COMMITTEE_ON_CHAIN_DECISION_RECOVERED'
        : 'DISBURSEMENT_COMMITTEE_EXECUTION_RECOVERED',
      targetId: params.data.requestId,
      targetType: 'DISBURSEMENT_REQUEST',
      reason: body.data.reason,
      requestContext: extractAuditRequestContext(request),
      context: body.data.scope === 'ON_CHAIN_DECISION'
        ? { requestId: params.data.requestId, scope: body.data.scope, onChainDecisionStatus: 'PENDING' }
        : { requestId: params.data.requestId, executionStatus: 'PENDING' }
    });
    const recoveryTarget = body.data.scope === 'ON_CHAIN_DECISION' ? 'quyết định on-chain' : 'execution';
    sendSuccessResponse(response, 200, `Đã đưa hồ sơ DEAD_LETTER về hàng đợi ${recoveryTarget}.`, { requestId: params.data.requestId, scope: body.data.scope });
  } catch (error) {
    sendErrorFromUnknown(response, error, 'Không thể khôi phục execution giải ngân.');
  }
}
