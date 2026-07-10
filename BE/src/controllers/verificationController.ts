/**
 * Controller xử lý các endpoint xác minh giao dịch và tổng hợp dự án.
 * Mục đích: phục vụ Transparency Dashboard (Lane D) - D3.
 *
 * Endpoints:
 * - GET /api/transparency/verify/:correlationId — xác minh giao dịch cụ thể
 * - GET /api/transparency/summary/:projectId — tổng hợp dòng tiền dự án
 *
 * LƯU Ý BẢO MẬT:
 * - Endpoint là PUBLIC vì dữ liệu transaction và địa chỉ ví không phải PII nhạy cảm
 * - Rate limiting 100 req/min đã được áp dụng tại route level
 */
import { Request, Response } from 'express';
import { z } from 'zod';
import { getLogger } from '../config/logger';
import { verifyTransaction, getProjectSummary } from '../services/verification.service';

const logger = getLogger();

/**
 * Schema Zod cho params của verify endpoint.
 * correlationId là string bắt buộc — kiểm tra format hợp lệ.
 */
const verifyParamsSchema = z.object({
  correlationId: z.string().min(1, 'correlationId is required')
});

type VerifyParamsInput = z.infer<typeof verifyParamsSchema>;

/**
 * Schema Zod cho params của summary endpoint.
 * projectId là string bắt buộc.
 */
const summaryParamsSchema = z.object({
  projectId: z.string().min(1, 'projectId is required')
});

type SummaryParamsInput = z.infer<typeof summaryParamsSchema>;

/**
 * Xử lý GET /api/transparency/verify/:correlationId.
 *
 * Xác minh giao dịch theo correlationId, trả về:
 * - Thông tin nguồn tiền (PayOS) nếu có
 * - Trạng thái on-chain nếu có
 * - Tổng giải ngân liên quan
 * - Tỷ lệ raised vs disbursed
 *
 * @param request Express Request
 * @param response Express Response
 */
export async function handleVerifyTransaction(
  request: Request,
  response: Response
): Promise<void> {
  // Validate params với Zod schema
  const parseResult = verifyParamsSchema.safeParse(request.params);

  if (!parseResult.success) {
    const errors = parseResult.error.errors.map(err => ({
      field: err.path.join('.'),
      message: err.message
    }));
    response.status(400).json({
      error: 'Validation failed',
      details: errors
    });
    return;
  }

  const { correlationId } = parseResult.data;
  const normalizedCorrelationId = correlationId.trim();

  try {
    const result = await verifyTransaction(normalizedCorrelationId);

    if (!result || !result.found) {
      response.status(404).json({
        error: 'Transaction not found',
        correlationId: normalizedCorrelationId
      });
      return;
    }

    response.status(200).json(result);
  } catch (error) {
    logger.error('Verification endpoint failed.', {
      correlationId: normalizedCorrelationId,
      errorMessage: error instanceof Error ? error.message : String(error)
    });
    response.status(500).json({
      error: 'Internal server error'
    });
  }
}

/**
 * Xử lý GET /api/transparency/summary/:projectId.
 *
 * Tổng hợp dòng tiền của dự án, trả về:
 * - totalRaised: tổng tiền quyên góp
 * - totalDisbursed: tổng tiền giải ngân
 * - remaining: còn lại
 * - donorCount: số donor
 * - transactionCount: số giao dịch
 *
 * Trả về zero values nếu dự án không có transaction.
 *
 * @param request Express Request
 * @param response Express Response
 */
export async function handleGetProjectSummary(
  request: Request,
  response: Response
): Promise<void> {
  // Validate params với Zod schema
  const parseResult = summaryParamsSchema.safeParse(request.params);

  if (!parseResult.success) {
    const errors = parseResult.error.errors.map(err => ({
      field: err.path.join('.'),
      message: err.message
    }));
    response.status(400).json({
      error: 'Validation failed',
      details: errors
    });
    return;
  }

  const { projectId } = parseResult.data;
  const normalizedProjectId = projectId.trim();

  try {
    const summary = await getProjectSummary(normalizedProjectId);

    response.status(200).json(summary);
  } catch (error) {
    logger.error('Project summary endpoint failed.', {
      projectId: normalizedProjectId,
      errorMessage: error instanceof Error ? error.message : String(error)
    });
    response.status(500).json({
      error: 'Internal server error'
    });
  }
}
