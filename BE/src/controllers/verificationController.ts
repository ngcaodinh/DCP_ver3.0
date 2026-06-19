/**
 * Controller xu ly cac endpoint xac minh giao dich va tong hop du an.
 * Muc dich: phuc vu Transparency Dashboard (Lane D) - D3.
 *
 * Endpoints:
 * - GET /api/transparency/verify/:correlationId — xac minh giao dich cu the
 * - GET /api/transparency/summary/:projectId — tong hop dong tien du an
 *
 * LUU Y BAO MAT:
 * - Endpoint la PUBLIC vi du lieu transaction va dia chi vi khong phai PII nhay cam
 * - Rate limiting 100 req/min da duoc ap dung tai route level
 */
import { Request, Response } from 'express';
import { z } from 'zod';
import { verifyTransaction, getProjectSummary } from '../services/verification.service';

/**
 * Schema Zod cho params cua verify endpoint.
 * correlationId la string bat buoc — kiem tra format hop le.
 */
const verifyParamsSchema = z.object({
  correlationId: z.string().min(1, 'correlationId is required')
});

type VerifyParamsInput = z.infer<typeof verifyParamsSchema>;

/**
 * Schema Zod cho params cua summary endpoint.
 * projectId la string bat buoc.
 */
const summaryParamsSchema = z.object({
  projectId: z.string().min(1, 'projectId is required')
});

type SummaryParamsInput = z.infer<typeof summaryParamsSchema>;

/**
 * Xu ly GET /api/transparency/verify/:correlationId.
 *
 * Xac minh giao dich theo correlationId, tra ve:
 * - Thong tin nguon tien (PayOS) neu co
 * - Trang thai on-chain neu co
 * - Tong giai ngan lien quan
 * - Ty le raised vs disbursed
 *
 * @param request Express Request
 * @param response Express Response
 */
export async function handleVerifyTransaction(
  request: Request,
  response: Response
): Promise<void> {
  // Validate params voi Zod schema
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
    response.status(500).json({
      error: 'Internal server error'
    });
  }
}

/**
 * Xu ly GET /api/transparency/summary/:projectId.
 *
 * Tong hop dong tien cua du an, tra ve:
 * - totalRaised: tong tien quyen gop
 * - totalDisbursed: tong tien giai ngan
 * - remaining: con lai
 * - donorCount: so donor
 * - transactionCount: so giao dich
 *
 * Tra ve zero values neu du an khong co transaction.
 *
 * @param request Express Request
 * @param response Express Response
 */
export async function handleGetProjectSummary(
  request: Request,
  response: Response
): Promise<void> {
  // Validate params voi Zod schema
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
    response.status(500).json({
      error: 'Internal server error'
    });
  }
}
