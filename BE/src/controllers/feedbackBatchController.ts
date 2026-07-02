/**
 * Controller xử lý batch upload feedback.
 * Điều phối HTTP request, gọi service và trả về response chuẩn hóa.
 */

import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/authenticationMiddleware';
import { sendErrorResponse, sendSuccessResponse, sendErrorFromUnknown } from '../utils/apiResponse';
import {
  processCsvBatchFeedback,
  processJsonBatchFeedback,
  MAX_BATCH_SIZE,
  MAX_UPLOAD_SIZE_BYTES
} from '../services/feedbackBatch.service';
import { getLogger } from '../config/logger';

const logger = getLogger();

/**
 * Giới hạn rate limit cho feedback batch endpoint.
 * 10 requests mỗi phút cho mỗi IP.
 */
const FEEDBACK_BATCH_RATE_LIMIT_WINDOW_MS = 60_000;
const FEEDBACK_BATCH_MAX_REQUESTS = 10;

/**
 * Hàm lấy userId đã xác thực để dùng làm organizationId.
 * Với endpoint này, userId từ JWT đóng vai trò organization identifier vì
 * role đã được verify bởi middleware auth.
 */
function getAuthenticatedUserId(request: AuthenticatedRequest, response: Response): string | null {
  const user = request.authenticatedUser;
  if (!user) {
    sendErrorResponse(response, 401, 'Thiếu thông tin xác thực người dùng.', 'UNAUTHENTICATED');
    return null;
  }

  if (!user.userId) {
    sendErrorResponse(response, 403, 'Người dùng không hợp lệ.', 'INVALID_USER');
    return null;
  }

  return user.userId;
}

/**
 * Controller xử lý batch upload feedback từ CSV file hoặc JSON array.
 * Endpoint: POST /api/feedback/batch
 * 
 * Hỗ trợ hai format:
 * - multipart/form-data với field 'file' chứa CSV
 * - application/json với body là array [{projectId, beneficiaryName, rating, comment, submittedAt, location?}]
 * 
 * Response: {success, failed, errors: [{rowNumber, reason}], flaggedCount}
 */
export async function batchUploadFeedbackController(
  request: AuthenticatedRequest,
  response: Response
): Promise<void> {
  const userId = getAuthenticatedUserId(request, response);
  if (!userId) {
    return;
  }

  try {
    const contentType = request.headers['content-type'] || '';
    const isMultipart = contentType.includes('multipart/form-data');

    let result;

    if (isMultipart) {
      // Xử lý CSV file upload
      const file = request.file;
      if (!file) {
        sendErrorResponse(response, 400, 'File CSV không được cung cấp.', 'MISSING_FILE');
        return;
      }

      if (file.size > MAX_UPLOAD_SIZE_BYTES) {
        sendErrorResponse(response, 400, `File size exceeds ${MAX_UPLOAD_SIZE_BYTES / (1024 * 1024)}MB limit.`, 'FILE_TOO_LARGE');
        return;
      }

      // Validate MIME type (CSV)
      const allowedMimeTypes = ['text/csv', 'text/plain', 'application/csv'];
      if (!allowedMimeTypes.includes(file.mimetype.toLowerCase())) {
        sendErrorResponse(response, 400, 'File phải là CSV.', 'INVALID_FILE_TYPE');
        return;
      }

      result = await processCsvBatchFeedback(file.buffer, userId);

      logger.info('CSV batch feedback uploaded', {
        organizationId: userId,
        fileName: file.originalname,
        fileSize: file.size,
        totalItems: result.success,
        failedCount: result.failed,
        flaggedCount: result.flaggedCount
      });
    } else {
      // Xử lý JSON array
      const body = request.body;

      if (!body || typeof body !== 'object') {
        sendErrorResponse(response, 400, 'Request body phải là JSON object hoặc array.', 'INVALID_BODY');
        return;
      }

      // Hỗ trợ cả body là array trực tiếp hoặc object có field feedbacks
      const feedbacks = Array.isArray(body) ? body : body.feedbacks;
      if (!Array.isArray(feedbacks)) {
        sendErrorResponse(response, 400, 'Request body phải chứa feedbacks array.', 'INVALID_BODY_FORMAT');
        return;
      }

      if (feedbacks.length > MAX_BATCH_SIZE) {
        sendErrorResponse(response, 400, 'Batch size exceeds 1000 limit.', 'BATCH_SIZE_EXCEEDED');
        return;
      }

      if (feedbacks.length === 0) {
        sendErrorResponse(response, 400, 'Phải có ít nhất 1 feedback.', 'EMPTY_BATCH');
        return;
      }

      result = await processJsonBatchFeedback(feedbacks, userId);

      logger.info('JSON batch feedback uploaded', {
        organizationId: userId,
        totalItems: feedbacks.length,
        successCount: result.success,
        failedCount: result.failed,
        flaggedCount: result.flaggedCount
      });
    }

    if (result.isDuplicate) {
      sendSuccessResponse(
        response,
        200,
        'Batch already submitted. Duplicate detected based on content hash.',
        {
          success: 0,
          failed: 0,
          errors: [],
          flaggedCount: 0,
          isDuplicate: true
        }
      );
      return;
    }

    sendSuccessResponse(
      response,
      200,
      'Batch feedback processed successfully.',
      {
        success: result.success,
        failed: result.failed,
        errors: result.errors,
        flaggedCount: result.flaggedCount
      }
    );
  } catch (error: unknown) {
    const errorMessage = (error as Error).message;

    if (errorMessage.includes('Batch size exceeds 1000 limit')) {
      sendErrorResponse(response, 400, 'Batch size exceeds 1000 limit.', 'BATCH_SIZE_EXCEEDED');
      return;
    }

    if (errorMessage.includes('File size exceeds')) {
      sendErrorResponse(response, 400, errorMessage, 'FILE_TOO_LARGE');
      return;
    }

    if (errorMessage.includes('Invalid CSV')) {
      sendErrorResponse(response, 400, 'Invalid CSV format.', 'INVALID_CSV');
      return;
    }

    logger.error('Batch feedback processing error', {
      organizationId: userId,
      errorMessage: errorMessage
    });

    sendErrorFromUnknown(response, error, 'Không thể xử lý batch feedback.');
  }
}

/**
 * Export constants cho rate limiter sử dụng.
 */
export const FEEDBACK_BATCH_RATE_LIMIT_CONFIG = {
  maxRequests: FEEDBACK_BATCH_MAX_REQUESTS,
  windowMs: FEEDBACK_BATCH_RATE_LIMIT_WINDOW_MS,
  bucketName: 'feedback-batch'
};
