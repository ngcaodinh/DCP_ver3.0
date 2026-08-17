import { Request, Response } from 'express';
import { getLogger } from '../config/logger';
import { ApplicationError } from '../utils/applicationError';
import {
  createDisbursementRequest,
  CreateDisbursementPayload,
  getDisbursementsForOrganization,
  getDisbursementsForReview,
  getDisbursementRequestSummaries,
  getLatestDisbursementApprovalLogs,
  getDisbursementDetail,
  getDisbursementsByProject,
  getMaxWithdrawableAmount,
  signDisbursementRequest,
  rejectDisbursementRequest,
  DisbursementTransferWebhookPayload
} from '../services/disbursementService';
import { processPayosWebhook } from '../services/payosWebhookService';

const logger = getLogger();

// ============ FR8: WEBHOOK CHUYỂN KHOẢN ============

/**
 * GET /api/disbursement/webhook
 * Kiểm tra nhanh endpoint webhook transfer có hoạt động hay không.
 * Actor: PayOS system health-check.
 */
export async function handleDisbursementTransferWebhookHealth(_request: Request, response: Response): Promise<void> {
  response.status(200).json({ message: 'Webhook transfer URL hoạt động.' });
}

/**
 * POST /api/disbursement/webhook
 * Xử lý webhook transfer từ PayOS cho FR8.
 * Actor: PayOS callback.
 */
export async function handleDisbursementTransferWebhook(request: Request, response: Response): Promise<void> {
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
    const checksumSource = bodySignatureValue
      ? 'body'
      : (signatureHeaderValue ? 'header' : 'missing');

    const webhookPayload: DisbursementTransferWebhookPayload = {
      ...(rawPayload as DisbursementTransferWebhookPayload),
      signature: normalizedChecksum,
      checksum: normalizedChecksum,
      checksumSource
    };

    const webhookData = (
      webhookPayload.data && typeof webhookPayload.data === 'object'
        ? webhookPayload.data
        : {}
    ) as Record<string, unknown>;

    const hasSignature = Boolean(webhookPayload.signature || webhookPayload.checksum);
    const hasBusinessIdentifier = Boolean(
      webhookPayload.transferId
      || webhookPayload.requestId
      || webhookData.transferId
      || webhookData.requestId
      || webhookData.transactionId
    );

    // Ghi chú logic phức tạp: request verify webhook từ cổng thanh toán có thể không có payload nghiệp vụ thực.
    // Trường hợp này cần trả 200 để pass bước kích hoạt webhook URL, không được xử lý nghiệp vụ.
    if (!hasSignature || !hasBusinessIdentifier) {
      response.status(200).json({ message: 'Webhook transfer URL hoạt động.' });
      return;
    }

    const webhookResult = await processPayosWebhook(
      webhookPayload,
      request.ip || request.socket.remoteAddress || 'unknown'
    );
    if (!webhookResult.disbursement) {
      response.status(200).json({ message: webhookResult.message });
      return;
    }

    const processedDisbursement = webhookResult.disbursement;
    response.status(200).json({
      message: 'Webhook transfer được xử lý thành công.',
      requestId: processedDisbursement.requestId,
      status: processedDisbursement.status,
      payosTransferStatus: processedDisbursement.payosTransferStatus,
      payosTransferId: processedDisbursement.payosTransferId
    });
  } catch (error) {
    const errorMessage = (error as Error).message || 'Webhook transfer không hợp lệ.';

    if (errorMessage.includes('Không tìm thấy disbursement theo transferId hoặc requestId')) {
      logger.warn('Nhận webhook transfer test với định danh không tồn tại, bỏ qua xử lý nghiệp vụ.', { errorMessage });
      response.status(200).json({ message: 'Webhook transfer URL hoạt động.' });
      return;
    }

    logger.error('Xử lý webhook transfer thất bại.', { errorMessage });
    response.status(400).json({ message: errorMessage });
  }
}

// ============ UC7.1: TẠO YÊU CẦU RÚT TIỀN ============

/**
 * POST /api/disbursement/create
 * Tạo yêu cầu rút tiền mới.
 * Actor: Tổ chức từ thiện (organizations).
 * Body: { projectId, amount, usagePurpose, evidenceCid, requestMode, emergencyReason?, beneficiaryBankAccount }
 */
export async function handleCreateDisbursementRequest(req: Request, res: Response): Promise<void> {
  try {
    const userId = (req as any).authenticatedUser?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Không có quyền truy cập.' });
      return;
    }

    const payload: CreateDisbursementPayload = {
      projectId: req.body.projectId,
      amount: Number(req.body.amount),
      usagePurpose: req.body.usagePurpose,
      evidenceCid: req.body.evidenceCid,
      requestMode: req.body.requestMode,
      emergencyReason: req.body.emergencyReason,
      beneficiaryBankAccount: req.body.beneficiaryBankAccount
    };

    const result = await createDisbursementRequest(userId, payload);
    logger.info(`Disbursement request created. requestId=${result.requestId} userId=${userId}`);

    res.status(201).json({
      success: true,
      data: result,
      message: 'Yêu cầu rút tiền đã được tạo thành công. Đang chờ ký duyệt theo ngưỡng chữ ký động của request.'
    });
  } catch (error) {
    if (error instanceof ApplicationError) {
      res.status(error.statusCode).json({ error: error.message, code: error.errorCode });
    } else {
      logger.error('handleCreateDisbursementRequest failed.', { errorMessage: (error as Error)?.message });
      res.status(500).json({ error: 'Lỗi server khi tạo yêu cầu rút tiền.' });
    }
  }
}

// ============ UC7.2: KÝ DUYỆT YÊU CẦU RÚT TIỀN ============

/**
 * POST /api/disbursement/:requestId/sign
 * Ký duyệt yêu cầu rút tiền.
 * Actor: Admin hệ thống / Đại diện tổ chức từ thiện / Cơ quan giám sát.
 * Body: { comment? }
 */
export async function handleSignDisbursementRequest(req: Request, res: Response): Promise<void> {
  try {
    const userId = (req as any).authenticatedUser?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Không có quyền truy cập.' });
      return;
    }

    const { requestId } = req.params;
    const { comment } = req.body as { comment?: string };

    if (!requestId) {
      res.status(400).json({ error: 'Thiếu requestId bắt buộc.' });
      return;
    }

    const result = await signDisbursementRequest(userId, requestId, comment);
    logger.info(`Disbursement signed. requestId=${requestId} userId=${userId}`);

    res.status(200).json({
      success: true,
      data: result,
      message: result.status === 'APPROVED'
        ? `Đã đủ chữ ký (${result.approvals.length}/${result.requiredApprovals}). Hệ thống đang tự động thực thi chuyển khoản FR8.`
        : `Chữ ký của bạn đã được ghi nhận (${result.approvals.length}/${result.requiredApprovals}).`
    });
  } catch (error) {
    if (error instanceof ApplicationError) {
      res.status(error.statusCode).json({ error: error.message, code: error.errorCode });
    } else {
      logger.error('handleSignDisbursementRequest failed.', { errorMessage: (error as Error)?.message });
      res.status(500).json({ error: 'Lỗi server khi ký duyệt.' });
    }
  }
}

/**
 * POST /api/disbursement/:requestId/reject
 * Từ chối yêu cầu rút tiền.
 * Actor: Admin hệ thống / Đại diện tổ chức từ thiện / Cơ quan giám sát.
 * Body: { reason }
 */
export async function handleRejectDisbursementRequest(req: Request, res: Response): Promise<void> {
  try {
    const userId = (req as any).authenticatedUser?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Không có quyền truy cập.' });
      return;
    }

    const { requestId } = req.params;
    const { reason } = req.body as { reason: string };

    if (!requestId) {
      res.status(400).json({ error: 'Thiếu requestId bắt buộc.' });
      return;
    }

    if (!reason || reason.trim().length < 5) {
      res.status(400).json({ error: 'Lý do từ chối phải tối thiểu 5 ký tự.', code: 'VALIDATION_ERROR' });
      return;
    }

    const result = await rejectDisbursementRequest(userId, requestId, reason);
    logger.info(`Disbursement rejected. requestId=${requestId} userId=${userId}`);

    res.status(200).json({
      success: true,
      data: result,
      message: 'Yêu cầu rút tiền đã bị từ chối.'
    });
  } catch (error) {
    if (error instanceof ApplicationError) {
      res.status(error.statusCode).json({ error: error.message, code: error.errorCode });
    } else {
      logger.error('handleRejectDisbursementRequest failed.', { errorMessage: (error as Error)?.message });
      res.status(500).json({ error: 'Lỗi server khi từ chối.' });
    }
  }
}

// ============ CÁC ENDPOINT TRUY VẤN ============

/**
 * GET /api/disbursement/me
 * Lấy danh sách yêu cầu của tổ chức đang đăng nhập.
 * Actor: Tổ chức từ thiện.
 */
export async function handleGetMyDisbursements(req: Request, res: Response): Promise<void> {
  try {
    const userId = (req as any).authenticatedUser?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Không có quyền truy cập.' });
      return;
    }

    const result = await getDisbursementsForOrganization(userId);
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    if (error instanceof ApplicationError) {
      res.status(error.statusCode).json({ error: error.message, code: error.errorCode });
    } else {
      logger.error('handleGetMyDisbursements failed.', { errorMessage: (error as Error)?.message });
      res.status(500).json({ error: 'Lỗi server khi lấy danh sách.' });
    }
  }
}

/**
 * GET /api/disbursement/pending
 * Lấy danh sách yêu cầu chờ ký duyệt.
 * Actor: Admin hệ thống / Cơ quan giám sát.
 */
export async function handleGetPendingDisbursements(req: Request, res: Response): Promise<void> {
  try {
    const userId = (req as any).authenticatedUser?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Không có quyền truy cập.' });
      return;
    }

    const result = await getDisbursementsForReview(userId);
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    if (error instanceof ApplicationError) {
      res.status(error.statusCode).json({ error: error.message, code: error.errorCode });
    } else {
      logger.error('handleGetPendingDisbursements failed.', { errorMessage: (error as Error)?.message });
      res.status(500).json({ error: 'Lỗi server khi lấy danh sách.' });
    }
  }
}

/**
 * GET /api/disbursement/requests
 * Lấy danh sách tóm tắt cho dashboard ký duyệt.
 * Actor: Admin hệ thống / Cơ quan giám sát.
 */
export async function handleGetDisbursementRequestSummaries(req: Request, res: Response): Promise<void> {
  try {
    const userId = (req as any).authenticatedUser?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Không có quyền truy cập.' });
      return;
    }

    const requests = await getDisbursementRequestSummaries(userId);
    res.status(200).json({ success: true, data: { requests } });
  } catch (error) {
    if (error instanceof ApplicationError) {
      res.status(error.statusCode).json({ error: error.message, code: error.errorCode });
    } else {
      logger.error('handleGetDisbursementRequestSummaries failed.', { errorMessage: (error as Error)?.message });
      res.status(500).json({ error: 'Lỗi server khi lấy danh sách tóm tắt giải ngân.' });
    }
  }
}

/**
 * GET /api/disbursement/approval-logs
 * Lấy nhật ký ký duyệt gần nhất cho dashboard.
 * Actor: Admin hệ thống / Cơ quan giám sát.
 */
export async function handleGetDisbursementApprovalLogs(req: Request, res: Response): Promise<void> {
  try {
    const userId = (req as any).authenticatedUser?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Không có quyền truy cập.' });
      return;
    }

    const rawLimitCount = Number(req.query.limit);
    const limitCount = Number.isFinite(rawLimitCount)
      ? Math.max(1, Math.min(100, Math.floor(rawLimitCount)))
      : 20;

    const logs = await getLatestDisbursementApprovalLogs(userId, limitCount);
    res.status(200).json({ success: true, data: { logs } });
  } catch (error) {
    if (error instanceof ApplicationError) {
      res.status(error.statusCode).json({ error: error.message, code: error.errorCode });
    } else {
      logger.error('handleGetDisbursementApprovalLogs failed.', { errorMessage: (error as Error)?.message });
      res.status(500).json({ error: 'Lỗi server khi lấy nhật ký ký duyệt.' });
    }
  }
}

/**
 * GET /api/disbursement/:requestId
 * Lấy chi tiết yêu cầu rút tiền.
 * Actor: Admin hệ thống / Cơ quan giám sát / Tổ chức từ thiện.
 */
export async function handleGetDisbursementDetail(req: Request, res: Response): Promise<void> {
  try {
    const userId = (req as any).authenticatedUser?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Không có quyền truy cập.' });
      return;
    }

    const { requestId } = req.params;
    if (!requestId) {
      res.status(400).json({ error: 'Thiếu requestId bắt buộc.' });
      return;
    }

    const result = await getDisbursementDetail(userId, requestId);
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    if (error instanceof ApplicationError) {
      res.status(error.statusCode).json({ error: error.message, code: error.errorCode });
    } else {
      logger.error('handleGetDisbursementDetail failed.', { errorMessage: (error as Error)?.message });
      res.status(500).json({ error: 'Lỗi server khi lấy chi tiết.' });
    }
  }
}

/**
 * GET /api/disbursement/project/:projectId
 * Lấy lịch sử giải ngân theo dự án.
 * Actor: Public (optional authentication).
 */
export async function handleGetDisbursementsByProject(req: Request, res: Response): Promise<void> {
  try {
    const { projectId } = req.params;
    if (!projectId) {
      res.status(400).json({ error: 'Thiếu projectId bắt buộc.' });
      return;
    }

    const result = await getDisbursementsByProject(projectId);
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    if (error instanceof ApplicationError) {
      res.status(error.statusCode).json({ error: error.message, code: error.errorCode });
    } else {
      logger.error('handleGetDisbursementsByProject failed.', { errorMessage: (error as Error)?.message });
      res.status(500).json({ error: 'Lỗi server khi lấy lịch sử giải ngân.' });
    }
  }
}

/**
 * GET /api/disbursement/max-withdrawable/:projectId
 * Lấy số dư khả dụng tối đa cho withdrawal.
 * Actor: Tổ chức từ thiện.
 */
export async function handleGetMaxWithdrawable(req: Request, res: Response): Promise<void> {
  try {
    const { projectId } = req.params;
    if (!projectId) {
      res.status(400).json({ error: 'Thiếu projectId bắt buộc.' });
      return;
    }

    const result = await getMaxWithdrawableAmount(projectId);
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    if (error instanceof ApplicationError) {
      res.status(error.statusCode).json({ error: error.message, code: error.errorCode });
    } else {
      logger.error('handleGetMaxWithdrawable failed.', { errorMessage: (error as Error)?.message });
      res.status(500).json({ error: 'Lỗi server khi lấy số dư.' });
    }
  }
}
