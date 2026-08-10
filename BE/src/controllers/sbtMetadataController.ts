import type { Response } from 'express';
import type { AuthenticatedRequest } from '../middleware/authenticationMiddleware';
import { getLogger } from '../config/logger';
import {
  getSbtGallery,
  getSbtListByProject,
  getSbtTokenDetail,
  updateSbtStatus
} from '../services/sbt-metadata.service';
import { sendErrorFromUnknown, sendErrorResponse, sendSuccessResponse } from '../utils/apiResponse';
import { sanitizeProviderError } from '../utils/sanitizeProviderError';

const logger = getLogger();

/** Xử lý GET gallery SBT toàn cục hoặc theo project với response envelope chuẩn. */
export async function handleGetSbtGallery(
  request: AuthenticatedRequest,
  response: Response
): Promise<void> {
  const { page, limit, projectId } = request.query as unknown as {
    page: number;
    limit: number;
    projectId?: string;
  };

  try {
    const result = await getSbtGallery(page, limit, projectId);
    sendSuccessResponse(response, 200, 'Lấy gallery SBT thành công.', result);
  } catch (error) {
    logger.error('Lấy gallery SBT thất bại.', {
      projectId,
      errorMessage: sanitizeProviderError(error) ?? 'UNKNOWN_ERROR'
    });
    sendErrorFromUnknown(response, error, 'Không thể lấy gallery SBT.');
  }
}

/** Xử lý GET gallery SBT theo project với response envelope chuẩn. */
export async function handleGetSbtListByProject(
  request: AuthenticatedRequest,
  response: Response
): Promise<void> {
  const { projectId } = request.params as { projectId: string };
  const { page, limit } = request.query as unknown as { page: number; limit: number };

  try {
    const result = await getSbtListByProject(projectId, page, limit);
    sendSuccessResponse(response, 200, 'Lấy danh sách SBT theo dự án thành công.', result);
  } catch (error) {
    logger.error('Lấy danh sách SBT theo dự án thất bại.', {
      projectId,
      errorMessage: sanitizeProviderError(error) ?? 'UNKNOWN_ERROR'
    });
    sendErrorFromUnknown(response, error, 'Không thể lấy danh sách SBT theo dự án.');
  }
}

/** Xử lý GET detail SBT, cho phép degrade IPFS nhưng vẫn báo đúng lỗi RPC/on-chain. */
export async function handleGetSbtTokenDetail(
  request: AuthenticatedRequest,
  response: Response
): Promise<void> {
  const { tokenId } = request.params as unknown as { tokenId: number };

  try {
    const result = await getSbtTokenDetail(tokenId);
    sendSuccessResponse(response, 200, 'Lấy chi tiết SBT thành công.', result);
  } catch (error) {
    logger.error('Lấy chi tiết SBT thất bại.', {
      tokenId,
      errorMessage: sanitizeProviderError(error) ?? 'UNKNOWN_ERROR'
    });
    sendErrorFromUnknown(response, error, 'Không thể lấy chi tiết SBT.');
  }
}

/** Xử lý POST cập nhật status on-chain và truyền userId làm audit actor xuống service. */
export async function handleUpdateSbtStatus(
  request: AuthenticatedRequest,
  response: Response
): Promise<void> {
  const authenticatedUser = request.authenticatedUser;
  if (!authenticatedUser) {
    sendErrorResponse(response, 401, 'Bạn chưa đăng nhập hoặc phiên đăng nhập không hợp lệ.', 'UNAUTHENTICATED');
    return;
  }

  const body = request.body as { tokenId: number; newStatus: string; reason: string };
  try {
    const result = await updateSbtStatus(body.tokenId, body.newStatus, body.reason, authenticatedUser.userId);
    sendSuccessResponse(response, 200, 'Cập nhật trạng thái SBT thành công.', result);
  } catch (error) {
    logger.error('Cập nhật trạng thái SBT thất bại.', {
      tokenId: body.tokenId,
      updatedBy: authenticatedUser.userId,
      errorMessage: sanitizeProviderError(error) ?? 'UNKNOWN_ERROR'
    });
    sendErrorFromUnknown(response, error, 'Không thể cập nhật trạng thái SBT.');
  }
}
