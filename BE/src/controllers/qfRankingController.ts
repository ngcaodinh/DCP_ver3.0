/**
 * Controller xử lý HTTP request cho Trust-Adjusted QF Ranking API.
 * Validate input bằng Zod, mask address, map response chuẩn hóa.
 */
import { z } from 'zod';
import type { Response } from 'express';
import { sendSuccessResponse, sendErrorResponse, sendErrorFromUnknown } from '../utils/apiResponse';
import { getTrustAdjustedQfRankings } from '../services/qf-ranking.service';
import { getLogger } from '../config/logger';
import type { AuthenticatedRequest } from '../middleware/authenticationMiddleware';
import { findUserWalletAddressById } from '../models/authModel';

const logger = getLogger();

/**
 * Schema validation cho query params của /rankings/trust-adjusted.
 * projectId: required
 * roundId: optional
 * sortBy: original hoặc trustAdjusted, default trustAdjusted
 * donorAddress: optional full wallet address for myRanking
 * page: coerced number, min 1, default 1
 * limit: coerced number, min 1, max 50, default 20
 */
const QfRankingQuerySchema = z.object({
  projectId: z.string().min(1, 'projectId là bắt buộc'),
  roundId: z.string().optional(),
  sortBy: z.enum(['trustAdjusted', 'original']).default('trustAdjusted'),
  donorAddress: z.string().trim().toLowerCase()
    .regex(/^0x[0-9a-f]{40}$/, 'donorAddress phải là địa chỉ ví hợp lệ')
    .optional(),
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
  request: AuthenticatedRequest,
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

    const { projectId, roundId, sortBy, donorAddress, page, limit } = parsed.data;

    if (donorAddress && !request.authenticatedUser) {
      sendErrorResponse(response, 401, 'Cần đăng nhập để xem xếp hạng cá nhân.', 'UNAUTHENTICATED');
      return;
    }

    let authorizedDonorAddress: string | undefined;
    if (donorAddress && request.authenticatedUser) {
      const walletAddress = await findUserWalletAddressById(request.authenticatedUser.userId);
      if (!walletAddress || walletAddress.toLowerCase() !== donorAddress) {
        sendErrorResponse(response, 403, 'Không được phép xem xếp hạng của ví khác.', 'FORBIDDEN');
        return;
      }
      authorizedDonorAddress = donorAddress;
    }

    logger.info('GET /rankings/trust-adjusted request', {
      projectId,
      roundId,
      sortBy,
      page,
      limit
    });

    const rankingResponse = await getTrustAdjustedQfRankings({
      projectId,
      roundId,
      sortBy,
      donorAddress: authorizedDonorAddress,
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
