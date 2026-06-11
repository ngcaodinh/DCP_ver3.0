import type { Request, Response } from 'express';
import { sendSuccessResponse, sendErrorFromUnknown } from '../utils/apiResponse';
import {
  getPendingManualReview,
  getManualReviewDetail,
  manualApprove,
  manualReject
} from '../services/manualReviewService';

/**
 * GET /api/disbursements/pending-review
 * Mục đích: lấy danh sách disbursement đang chờ xử lý tay (payosTransferStatus = MANUAL_REVIEW).
 */
export async function handleGetPendingManualReview(req: Request, res: Response): Promise<void> {
  try {
    const items = await getPendingManualReview();
    sendSuccessResponse(res, 200, 'Lấy danh sách pending review thành công.', { items, total: items.length });
  } catch (error) {
    sendErrorFromUnknown(res, error, 'Không thể lấy danh sách pending review.');
  }
}

/**
 * GET /api/disbursements/:id/detail
 * Mục đích: chi tiết một disbursement MANUAL_REVIEW kèm transfer logs và audit logs.
 */
export async function handleGetManualReviewDetail(req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  if (!id || !id.trim()) {
    res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Thiếu request ID.' } });
    return;
  }
  try {
    const detail = await getManualReviewDetail(id);
    sendSuccessResponse(res, 200, 'Lấy chi tiết manual review thành công.', detail);
  } catch (error) {
    sendErrorFromUnknown(res, error, 'Không thể lấy chi tiết manual review.');
  }
}

/**
 * POST /api/disbursements/:id/manual-approve
 * Mục đích: admin approve → re-enqueue PayOS transfer từ đầu.
 * authenticatedUser.userId đã được gắn bởi authMiddleware.
 */
export async function handleManualApprove(req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  if (!id || !id.trim()) {
    res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Thiếu request ID.' } });
    return;
  }
  const adminUserId = (req as any).authenticatedUser?.userId as string ?? 'unknown';
  try {
    await manualApprove(id, adminUserId);
    sendSuccessResponse(res, 200, 'Manual approve thành công. Đã đẩy lại vào queue.', { requestId: id });
  } catch (error) {
    sendErrorFromUnknown(res, error, 'Manual approve thất bại.');
  }
}

/**
 * POST /api/disbursements/:id/manual-reject
 * Mục đích: admin reject với lý do rõ ràng → status = REJECTED.
 * Body: { reason: string } — tối thiểu 10 ký tự.
 */
export async function handleManualReject(req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  if (!id || !id.trim()) {
    res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Thiếu request ID.' } });
    return;
  }
  const adminUserId = (req as any).authenticatedUser?.userId as string ?? 'unknown';
  const { reason } = req.body as { reason?: string };

  if (!reason || typeof reason !== 'string' || reason.trim().length < 10) {
    res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'reason phải có ít nhất 10 ký tự.' }
    });
    return;
  }

  try {
    await manualReject(id, adminUserId, reason.trim());
    sendSuccessResponse(res, 200, 'Manual reject thành công.', { requestId: id });
  } catch (error) {
    sendErrorFromUnknown(res, error, 'Manual reject thất bại.');
  }
}
