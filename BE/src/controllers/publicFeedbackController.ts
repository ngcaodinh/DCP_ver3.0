/**
 * Controller xử lý public feedback APIs.
 * Không yêu cầu authentication, chỉ trả về feedback không bị flag.
 */

import { Request, Response } from 'express';
import { sendErrorResponse, sendSuccessResponse } from '../utils/apiResponse';
import {
  getPublicFeedbackList,
  getPublicFeedbackStats
} from '../services/publicFeedback.service';

/**
 * Default page size cho pagination.
 */
const DEFAULT_PAGE = 1;

/**
 * Default items per page.
 */
const DEFAULT_LIMIT = 20;

/**
 * Maximum items per page để tránh query quá nhiều data.
 */
const MAX_LIMIT = 50;

/**
 * Controller lấy danh sách feedback công khai với pagination.
 * Endpoint: GET /api/feedback/public/:projectId
 * 
 * @param request - Express request với params.projectId và query.page, query.limit
 * @param response - Express response
 */
export async function getPublicFeedbackListController(
  request: Request,
  response: Response
): Promise<void> {
  try {
    const { projectId } = request.params;

    if (!projectId || typeof projectId !== 'string') {
      sendErrorResponse(response, 400, 'Thiếu hoặc không hợp lệ projectId.', 'VALIDATION_ERROR');
      return;
    }

    // Parse pagination params với defaults
    let page = DEFAULT_PAGE;
    let limit = DEFAULT_LIMIT;

    const pageParam = request.query.page;
    const limitParam = request.query.limit;

    if (pageParam !== undefined && pageParam !== '') {
      const parsedPage = parseInt(pageParam as string, 10);
      if (isNaN(parsedPage) || parsedPage < 1) {
        sendErrorResponse(response, 400, 'Page phải là số nguyên dương.', 'VALIDATION_ERROR');
        return;
      }
      page = parsedPage;
    }

    if (limitParam !== undefined && limitParam !== '') {
      const parsedLimit = parseInt(limitParam as string, 10);
      if (isNaN(parsedLimit) || parsedLimit < 1) {
        sendErrorResponse(response, 400, 'Limit phải là số nguyên dương.', 'VALIDATION_ERROR');
        return;
      }
      // Enforce max limit
      limit = Math.min(parsedLimit, MAX_LIMIT);
    }

    const result = await getPublicFeedbackList(projectId, page, limit);

    sendSuccessResponse(
      response,
      200,
      'Lấy danh sách feedback thành công.',
      result
    );
  } catch (error) {
    console.error('Error in getPublicFeedbackListController:', error);
    sendErrorResponse(response, 500, 'Đã xảy ra lỗi khi lấy danh sách feedback.', 'INTERNAL_ERROR');
  }
}

/**
 * Controller lấy thống kê feedback công khai cho một dự án.
 * Endpoint: GET /api/feedback/stats/:projectId
 * 
 * @param request - Express request với params.projectId
 * @param response - Express response
 */
export async function getPublicFeedbackStatsController(
  request: Request,
  response: Response
): Promise<void> {
  try {
    const { projectId } = request.params;

    if (!projectId || typeof projectId !== 'string') {
      sendErrorResponse(response, 400, 'Thiếu hoặc không hợp lệ projectId.', 'VALIDATION_ERROR');
      return;
    }

    const stats = await getPublicFeedbackStats(projectId);

    sendSuccessResponse(
      response,
      200,
      'Lấy thống kê feedback thành công.',
      stats
    );
  } catch (error) {
    console.error('Error in getPublicFeedbackStatsController:', error);
    sendErrorResponse(response, 500, 'Đã xảy ra lỗi khi lấy thống kê feedback.', 'INTERNAL_ERROR');
  }
}
