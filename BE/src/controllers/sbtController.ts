import { Request, Response } from 'express';
import type { AuthenticatedRequest } from '../middleware/authenticationMiddleware';
import { getLogger } from '../config/logger';
import { rerunSbtMintJob } from '../services/sbtMintService';
import { sendErrorFromUnknown, sendErrorResponse, sendSuccessResponse } from '../utils/apiResponse';
import { sanitizeProviderError } from '../utils/sanitizeProviderError';
import { findProjectNamesByProjectIdList } from '../models/projectModel';
import { extractAuditRequestContext } from '../utils/auditRequestContext';
import {
  findSbtMintDlqByStatus,
  findSbtMintDlqByStatusCursor,
  decodeSbtMintDlqCursor,
  countSbtMintDlqByStatus,
  type SbtMintDlqRecord
} from '../models/sbtMintDlqModel';
const logger = getLogger();

export type SbtMintDlqListEntry = SbtMintDlqRecord & {
  projectName: string | null;
};

/** Chuyển bản ghi DLQ sang response contract và loại bỏ metadata nội bộ của MongoDB. */
function toSbtMintDlqListEntry(entry: SbtMintDlqRecord, projectName: string | null): SbtMintDlqListEntry {
  return {
    dlqId: entry.dlqId,
    mintRequestId: entry.mintRequestId,
    sbtId: entry.sbtId,
    projectId: entry.projectId,
    projectName,
    organizationId: entry.organizationId,
    beneficiaryAddress: entry.beneficiaryAddress,
    attemptNumber: entry.attemptNumber,
    lastErrorMessage: entry.lastErrorMessage,
    firstAttemptedAt: entry.firstAttemptedAt,
    dlqAt: entry.dlqAt,
    recoveredAt: entry.recoveredAt,
    recoveredBy: entry.recoveredBy,
    recoveryAttemptNumber: entry.recoveryAttemptNumber,
    lastRecoveryError: entry.lastRecoveryError ?? null,
    lastRecoveryAt: entry.lastRecoveryAt ?? null,
    status: entry.status,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt
  };
}

// ============ DLQ LIST ============

/**
 * GET /api/sbt/dlq
 * Lấy danh sách DLQ entries (phân trang) cho admin UI.
 * Actor: Admin hệ thống.
 * Query params: page hoặc cursor, limit, status (optional, default 'OPEN').
 */
export async function handleGetSbtDlqList(req: Request, res: Response): Promise<void> {
  try {
    // req.query đã được validate + coerce bởi createZodValidatorMiddleware (paginationQuerySchema)
    // Dùng validated data từ req.query thay vì manual Number() coercion — I-A5 fix
    const validatedQuery = req.query as unknown as {
      page: number;
      limit: number;
      cursor?: string;
      status?: 'OPEN' | 'RECOVERED' | 'ABANDONED';
    };
    const page = Math.max(1, Math.floor(validatedQuery.page)) || 1;
    const limit = Math.max(1, Math.min(100, Math.floor(validatedQuery.limit))) || 20;
    const skip = (page - 1) * limit;
    const status = validatedQuery.status ?? 'OPEN';
    const cursor = validatedQuery.cursor?.trim() || undefined;

    if (cursor && !decodeSbtMintDlqCursor(cursor)) {
      sendErrorResponse(res, 400, 'DLQ cursor không hợp lệ.', 'VALIDATION_ERROR');
      return;
    }

    const [listResult, totalCount, openCount] = await Promise.all([
      cursor
        ? findSbtMintDlqByStatusCursor(status, limit, cursor)
        : findSbtMintDlqByStatus(status, limit, skip).then(entries => ({ entries, nextCursor: null })),
      countSbtMintDlqByStatus(status),
      countSbtMintDlqByStatus('OPEN')
    ]);
    const { entries, nextCursor } = listResult;

    let entriesWithProjectNames: SbtMintDlqListEntry[];
    try {
      const projectIdList = [...new Set(entries.map((entry) => entry.projectId))];
      const projectRecords = await findProjectNamesByProjectIdList(projectIdList);
      const projectNameById = new Map(projectRecords.map((project) => [project.projectId, project.name]));
      entriesWithProjectNames = entries.map((entry) => toSbtMintDlqListEntry(
        entry,
        projectNameById.get(entry.projectId) ?? null
      ));
    } catch (error) {
      logger.warn('Không thể lấy tên project cho danh sách DLQ SBT.', {
        errorMessage: sanitizeProviderError(error) ?? 'UNKNOWN_ERROR'
      });
      entriesWithProjectNames = entries.map((entry) => toSbtMintDlqListEntry(entry, null));
    }

    sendSuccessResponse(res, 200, 'Lấy danh sách DLQ SBT thành công.', {
      entries: entriesWithProjectNames,
      pagination: {
        page,
        limit,
        total: totalCount,
        totalPages: Math.ceil(totalCount / limit),
        nextCursor
      },
      openCount
    });
  } catch (error) {
    logger.error('handleGetSbtDlqList thất bại.', {
      errorMessage: sanitizeProviderError(error) ?? 'UNKNOWN_ERROR'
    });
    sendErrorFromUnknown(res, error, 'Lỗi server khi lấy danh sách DLQ.');
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
export async function handleRetrySbtMintJob(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const userId = req.authenticatedUser?.userId;
    if (!userId) {
      sendErrorResponse(res, 401, 'Không có quyền truy cập.', 'UNAUTHENTICATED');
      return;
    }

    const { mintRequestId } = req.params;
    if (!mintRequestId || mintRequestId.trim().length === 0) {
      sendErrorResponse(res, 400, 'mintRequestId là bắt buộc.', 'VALIDATION_ERROR');
      return;
    }

    const auditRequestContext = extractAuditRequestContext(req);
    const result = auditRequestContext.ipAddress || auditRequestContext.userAgent
      ? await rerunSbtMintJob(mintRequestId.trim(), userId, auditRequestContext)
      : await rerunSbtMintJob(mintRequestId.trim(), userId);

    logger.info('Admin re-run SBT mint job thành công.', {
      mintRequestId,
      sbtId: result.record.sbtId,
      reRunBy: userId
    });

    sendSuccessResponse(res, 200, 'Job đã được reset và enqueued. Worker sẽ tự động xử lý mint.', {
      mintRequestId: result.record.mintRequestId,
      sbtId: result.record.sbtId,
      status: result.record.status,
      attemptNumber: result.record.attemptNumber,
      enqueued: result.enqueued,
      jobId: result.jobId
    });
  } catch (error) {
    logger.error('handleRetrySbtMintJob thất bại.', {
      mintRequestId: req.params.mintRequestId,
      errorMessage: sanitizeProviderError(error) ?? 'UNKNOWN_ERROR'
    });
    sendErrorFromUnknown(res, error, 'Lỗi server khi retry job.');
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
    sendErrorResponse(res, 401, 'Không có quyền truy cập.', 'UNAUTHENTICATED');
    return;
  }

  logger.warn('Phát hiện attempt gọi admin-mint bị cấm.', {
    // Chỉ log mintRequestId field — không log toàn bộ req.body để tránh lộ sensitive data
    mintRequestId: req.body?.mintRequestId ?? 'N/A',
    userId
  });

  sendErrorResponse(
    res,
    403,
    'Hành động này bị cấm. Không cho phép mint SBT thủ công. Vui lòng đợi Oracle verify tự động hoặc retry job từ DLQ.',
    'FORBIDDEN'
  );
}
