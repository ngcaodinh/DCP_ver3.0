import { Response } from 'express';
import { getLogger } from '../config/logger';
import { AuthenticatedRequest } from '../middleware/authenticationMiddleware';
import { triggerSbtMintFromOracle, isTransactionStuck, verifyOracleTriggerRequest } from '../services/sbt-trigger.service';
import { validateSbtTriggerBody } from '../validators/sbtTrigger.validator';
import { sendSuccessResponse, sendErrorResponse } from '../utils/apiResponse';

const logger = getLogger();

/**
 * POST /api/oracle/sbt-trigger
 * Endpoint trigger mint SBT từ Oracle service sau khi verify thành công.
 *
 * Actor: Oracle service (JWT role = "oracle").
 * Auth: JWT + role "oracle" được kiểm tra bởi middleware trong route.
 *
 * Flow:
 * 1. Validate request body bằng Zod schema
 * 2. Gọi triggerSbtMintFromOracle service (idempotent)
 * 3. Trả về mintRequestId + status
 *
 * Ràng buộc:
 * - Non-oracle role → 403 (middleware đã handle)
 * - Gas sponsorship: EOA signing với IMPACT_SBT_MINTER_PRIVATE_KEY (không dùng Account Abstraction)
 * - Stuck tx: được xử lý bởi cron-based sbtMintRecoveryScheduler (C2)
 *
 * @param req - AuthenticatedRequest với authenticatedUser.role = "oracle"
 * @param res - Express Response
 */
export async function handleSbtTrigger(
  req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  try {
    // Validate request body
    const validationResult = validateSbtTriggerBody(req.body);
    if (!validationResult.isValid) {
      sendErrorResponse(
        res,
        400,
        'Validation failed.',
        'VALIDATION_ERROR',
        validationResult.errors
      );
      return;
    }

    await verifyOracleTriggerRequest(validationResult.data.verificationId, {
      signature: req.get('x-oracle-signature') ?? undefined,
      timestamp: req.get('x-oracle-timestamp') ?? undefined,
      nonce: req.get('x-oracle-nonce') ?? undefined
    });

    // Trigger mint — service xử lý idempotency (duplicate = return existing)
    // Controller đã validate req.body, nên service nhận validated data trực tiếp
    const result = await triggerSbtMintFromOracle(validationResult.data);

    // [N-B4] Bỏ qua stuck check cho duplicate response — đã có record trong DB
    // với transactionHash cũ, stuck tx warning không có ý nghĩa cho requests đã xử lý
    const stuckWarning = result.duplicate || !isTransactionStuck(result.record)
      ? undefined
      : 'Warning: Transaction appears stuck (>5 min pending). Recovery will be handled by cron job.';

    logger.info('SBT trigger thành công.', {
      mintRequestId: result.record.mintRequestId,
      sbtId: result.record.sbtId,
      verificationId: validationResult.data.verificationId,
      status: result.record.status
    });

    sendSuccessResponse(res, result.duplicate ? 200 : 201, 'SBT mint request đã được tạo.', {
      mintRequestId: result.record.mintRequestId,
      sbtId: result.record.sbtId,
      status: result.record.status,
      transactionHash: result.record.transactionHash,
      duplicate: result.duplicate,
      enqueued: result.enqueued,
      warning: stuckWarning
    });
  } catch (error) {
    const errorMessage = (error as Error).message || 'Lỗi không xác định.';

    logger.error('handleSbtTrigger thất bại.', {
      errorMessage,
      verificationId: req.body?.verificationId ?? 'N/A'
    });

    // Validation errors đã được format từ service
    const applicationError = error as { statusCode?: number; code?: string; errorCode?: string };
    if (typeof applicationError.statusCode === 'number') {
      sendErrorResponse(
        res,
        applicationError.statusCode,
        errorMessage,
        applicationError.errorCode ?? applicationError.code ?? 'REQUEST_FAILED'
      );
      return;
    }
    if (errorMessage.startsWith('Validation failed:')) {
      sendErrorResponse(res, 400, errorMessage, 'VALIDATION_ERROR');
      return;
    }

    sendErrorResponse(res, 500, 'Lỗi server khi trigger SBT mint.', 'INTERNAL_ERROR');
  }
}
