import { Request, Response } from 'express';
import { getLogger } from '../config/logger';
import { ApplicationError } from '../utils/applicationError';
import { rerunSbtMintJob } from '../services/sbtMintService';
import {
  findSbtMintDlqByStatus,
  countSbtMintDlqByStatus
} from '../models/sbtMintDlqModel';
import type { SbtMintDlqRecord } from '../models/sbtMintDlqModel';
const logger = getLogger();

// ============ DLQ LIST ============

/**
 * GET /api/sbt/dlq
 * Lấy danh sách DLQ entries (phân trang) cho admin UI.
 * Actor: Admin hệ thống.
 * Query params: page, limit, status (optional, default 'OPEN').
 */
export async function handleGetSbtDlqList(req: Request, res: Response): Promise<void> {
  try {
    // req.query đã được validate + coerce bởi createZodValidatorMiddleware (paginationQuerySchema)
    // Dùng validated data từ req.query thay vì manual Number() coercion — I-A5 fix
    const validatedQuery = req.query as { page: number; limit: number; status?: 'OPEN' | 'RECOVERED' | 'ABANDONED' };
    const page = Math.max(1, Math.floor(validatedQuery.page)) || 1;
    const limit = Math.max(1, Math.min(100, Math.floor(validatedQuery.limit))) || 20;
    const skip = (page - 1) * limit;
    const status = validatedQuery.status ?? 'OPEN';

    const [entries, totalCount, openCount] = await Promise.all([
      findSbtMintDlqByStatus(status, limit, skip),
      countSbtMintDlqByStatus(status),
      countSbtMintDlqByStatus('OPEN')
    ]);

    res.status(200).json({
      success: true,
      data: {
        entries,
        pagination: {
          page,
          limit,
          total: totalCount,
          totalPages: Math.ceil(totalCount / limit)
        },
        openCount
      }
    });
  } catch (error) {
    logger.error('handleGetSbtDlqList thất bại.', {
      errorMessage: (error as Error).message
    });
    res.status(500).json({ error: 'Lỗi server khi lấy danh sách DLQ.' });
  }
}

// ============ RETRY JOB ============

/**
 * POST /api/sbt/retry-job/:mintRequestId
 * Admin trigger re-run job từ DLQ/FAILED.
 * Actor: Admin hệ thống.
 *
 * Ràng buộc Q4:
 * - KHÔNG mint tay — chỉ reset + re-enqueue qua worker
 * - Chỉ áp dụng cho DLQ hoặc FAILED
 * - Reset attemptNumber = 0, tăng reRunCount
 */
export async function handleRetrySbtMintJob(req: Request, res: Response): Promise<void> {
  try {
    const userId = (req as unknown as { authenticatedUser?: { userId?: string } }).authenticatedUser?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Không có quyền truy cập.' });
      return;
    }

    const { mintRequestId } = req.params;
    if (!mintRequestId || mintRequestId.trim().length === 0) {
      res.status(400).json({ error: 'mintRequestId là bắt buộc.' });
      return;
    }

    const result = await rerunSbtMintJob(mintRequestId.trim(), userId);

    logger.info('Admin re-run SBT mint job thành công.', {
      mintRequestId,
      sbtId: result.record.sbtId,
      reRunBy: userId
    });

    res.status(200).json({
      success: true,
      data: {
        mintRequestId: result.record.mintRequestId,
        sbtId: result.record.sbtId,
        status: result.record.status,
        attemptNumber: result.record.attemptNumber,
        enqueued: result.enqueued,
        jobId: result.jobId
      },
      message: 'Job đã được reset và enqueued. Worker sẽ tự động xử lý mint.'
    });
  } catch (error) {
    if (error instanceof ApplicationError) {
      res.status(error.statusCode).json({ error: error.message });
      return;
    }
    const errorMessage = (error as Error).message || 'Lỗi không xác định.';

    if (errorMessage.includes('Không tìm thấy mint request')) {
      res.status(404).json({ error: errorMessage });
      return;
    }

    if (errorMessage.includes('Không thể reset mint request')) {
      res.status(409).json({ error: errorMessage });
      return;
    }

    logger.error('handleRetrySbtMintJob thất bại.', {
      mintRequestId: req.params.mintRequestId,
      errorMessage
    });
    res.status(500).json({ error: 'Lỗi server khi retry job.' });
  }
}

// ============ ADMIN MINT (FORBIDDEN) ============

/**
 * POST /api/sbt/admin-mint
 * Endpoint bị cấm theo Q4 decision — không cho mint tay.
 * Actor: Admin hệ thống.
 *
 * Response: 403 Forbidden với message rõ ràng.
 * KHÔNG gọi bất kỳ service nào — trả 403 ngay từ controller.
 */
export async function handleAdminMintSbt(req: Request, res: Response): Promise<void> {
  const userId = (req as unknown as { authenticatedUser?: { userId?: string } }).authenticatedUser?.userId;
  if (!userId) {
    res.status(401).json({ error: 'Không có quyền truy cập.' });
    return;
  }

  logger.warn('Phát hiện attempt gọi admin-mint bị cấm.', {
    // Chỉ log mintRequestId field — không log toàn bộ req.body để tránh lộ sensitive data
    mintRequestId: req.body?.mintRequestId ?? 'N/A',
    userId
  });

  res.status(403).json({
    error: 'Hành động này bị cấm. Không cho phép mint SBT thủ công. Vui lòng đợi Oracle verify tự động hoặc retry job từ DLQ.'
  });
}
