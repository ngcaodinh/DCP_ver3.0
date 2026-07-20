/**
 * Controller xử lý HTTP request cho Trust-Adjusted QF Ranking API.
 * Validate input bằng Zod, mask address, map response chuẩn hóa.
 */
import { z } from 'zod';
import type { Request, Response } from 'express';
import { sendSuccessResponse, sendErrorResponse, sendErrorFromUnknown } from '../utils/apiResponse';
import { getTrustAdjustedQfRankings } from '../services/qf-ranking.service';
import { getLogger } from '../config/logger';

const logger = getLogger();

/**
 * Schema validation cho query params của /rankings/trust-adjusted.
 * projectId: required
 * roundId: optional
 * page: coerced number, min 1, default 1
 * limit: coerced number, min 1, max 50, default 20
 */
const QfRankingQuerySchema = z.object({
  projectId: z.string().min(1, 'projectId là bắt buộc'),
  roundId: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20)
});

/**
 * Hàm xử lý GET /rankings/trust-adjusted.
 * Không yêu cầu authentication — endpoint công khai.
 *
 * Luồng xử lý:
 * 1. Validate query params bằng Zod
 * 2. Gọi service lấy rankings
 * 3. Trả response chuẩn hóa
 */
export async function handleGetTrustAdjustedRankings(
  request: Request,
  response: Response
): Promise<void> {
  try {
    const parsed = QfRankingQuerySchema.safeParse(request.query);

    if (!parsed.success) {
      const details = parsed.error.errors.map(err => ({
        field: String(err.path.join('.')),
        message: err.message
      }));

      sendErrorResponse(
        response,
        400,
        'VALIDATION_ERROR',
        'VALIDATION_ERROR',
        details
      );
      return;
    }

    const { projectId, roundId, page, limit } = parsed.data;

    logger.info('GET /rankings/trust-adjusted request', {
      projectId,
      roundId,
      page,
      limit
    });

    const rankingResponse = await getTrustAdjustedQfRankings({
      projectId,
      roundId,
      page,
      limit
    });

    sendSuccessResponse(
      response,
      200,
      'Lấy bảng xếp hạng QF thành công',
      rankingResponse
    );
  } catch (error) {
    const projectIdForLog = typeof request.query.projectId === 'string' ? request.query.projectId : undefined;
    logger.error('Error in handleGetTrustAdjustedRankings', {
      error: error instanceof Error ? error.message : String(error),
      projectId: projectIdForLog
    });
    sendErrorFromUnknown(
      response,
      error,
      'Lỗi khi lấy bảng xếp hạng QF'
    );
  }
}
