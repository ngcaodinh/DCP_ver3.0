import type { Request, Response } from 'express';
import { getLogger } from '../config/logger';
import { getPublicFeedbackFrontendUrl } from '../config/publicFeedbackRuntimeConfig';
import { ApplicationError } from '../utils/applicationError';
import { sendErrorFromUnknown, sendErrorResponse, sendSuccessResponse } from '../utils/apiResponse';
import { getPublicFeedbackClientIp } from '../utils/publicFeedbackClientIdentity';
import {
  publicFeedbackProjectIdSchema,
  publicFeedbackSubmitSchema
} from '../validators/publicFeedbackSubmitValidator';
import {
  getPublicFeedbackFormContext,
  submitSingleFeedback
} from '../services/publicFeedbackSubmit.service';

const logger = getLogger();

/** Chọn trạng thái truy vấn an toàn cho redirect HTML, không phản chiếu mã lỗi tùy ý vào URL. */
function getRedirectStatus(errorCode: string): string {
  switch (errorCode) {
    case 'DUPLICATE_SUBMISSION': return 'duplicate';
    case 'TICKET_EXPIRED':
    case 'TICKET_ALREADY_USED': return 'expired';
    case 'PROJECT_NOT_ACCEPTING_FEEDBACK': return 'closed';
    case 'RATE_LIMIT_EXCEEDED': return 'ratelimit';
    case 'VALIDATION_ERROR':
    case 'INVALID_TICKET':
    case 'PROJECT_NOT_FOUND': return 'invalid';
    default: return 'error';
  }
}

/** Xác định request form từ trình duyệt cần redirect 303 về route feedback hay trả JSON. */
function shouldRedirectToFeedback(request: Request): boolean {
  const acceptHeader = request.get('accept') || '';
  return acceptHeader.split(',').some(mediaType => mediaType.trim().toLowerCase().startsWith('text/html'));
}

/** Redirect về frontend bằng URL cấu hình, không nối chuỗi từ input ngoài projectId đã kiểm tra. */
function redirectToFeedback(response: Response, projectId: string, status: string): void {
  const frontendUrl = getPublicFeedbackFrontendUrl();
  response.redirect(303, `${frontendUrl}/feedback/${encodeURIComponent(projectId)}?status=${status}`);
}

/** Xử lý submit feedback public theo thương lượng nội dung giữa HTML form và JSON API. */
export async function submitSingleFeedbackController(request: Request, response: Response): Promise<void> {
  const rawProjectId = typeof request.body?.projectId === 'string' ? request.body.projectId : '';
  const wantsHtml = shouldRedirectToFeedback(request);
  const parsedPayload = publicFeedbackSubmitSchema.safeParse(request.body);

  if (!parsedPayload.success) {
    const hasOnlyMissingTicketError = parsedPayload.error.issues.length === 1 &&
      parsedPayload.error.issues[0]?.path.join('.') === 'submissionTicket';
    if (wantsHtml && rawProjectId) {
      redirectToFeedback(response, rawProjectId.trim(), 'invalid');
      return;
    }
    sendErrorResponse(
      response,
      400,
      hasOnlyMissingTicketError ? 'Ticket không hợp lệ.' : 'Thông tin feedback chưa hợp lệ.',
      hasOnlyMissingTicketError ? 'INVALID_TICKET' : 'VALIDATION_ERROR',
      parsedPayload.error.issues.map(issue => ({
        field: issue.path.join('.') || 'unknown',
        message: issue.message
      }))
    );
    return;
  }

  if (parsedPayload.data.contactEmail) {
    logger.warn('Feedback honeypot triggered.', { projectId: parsedPayload.data.projectId });
    if (wantsHtml) {
      redirectToFeedback(response, parsedPayload.data.projectId, 'success');
      return;
    }
    sendSuccessResponse(response, 201, 'Feedback đã được ghi nhận.', { feedbackId: null, isFlagged: false });
    return;
  }

  try {
    const result = await submitSingleFeedback(parsedPayload.data, getPublicFeedbackClientIp(request));
    if (wantsHtml) {
      redirectToFeedback(response, parsedPayload.data.projectId, 'success');
      return;
    }
    sendSuccessResponse(response, 201, 'Feedback đã được ghi nhận.', {
      feedbackId: result.feedbackId,
      isFlagged: result.isFlagged
    });
  } catch (error) {
    if (wantsHtml) {
      const errorCode = error instanceof ApplicationError ? error.errorCode : 'INTERNAL_ERROR';
      if (!(error instanceof ApplicationError)) {
        logger.error('Public feedback submit failed.', {
          projectId: parsedPayload.data.projectId,
          errorCode: 'INTERNAL_ERROR'
        });
      }
      redirectToFeedback(response, parsedPayload.data.projectId, getRedirectStatus(errorCode));
      return;
    }
    sendErrorFromUnknown(response, error, 'Không thể gửi feedback. Vui lòng thử lại.');
  }
}

/** Trả context SSR cho form và ticket, đồng thời phân biệt 404 với project chưa mở nhận feedback. */
export async function getFeedbackFormContextController(request: Request, response: Response): Promise<void> {
  const parsedProjectId = publicFeedbackProjectIdSchema.safeParse(request.params.projectId);
  if (!parsedProjectId.success) {
    sendErrorResponse(response, 400, 'projectId không hợp lệ.', 'VALIDATION_ERROR');
    return;
  }

  try {
    const context = await getPublicFeedbackFormContext(parsedProjectId.data);
    sendSuccessResponse(response, 200, 'Lấy context feedback thành công.', context);
  } catch (error) {
    sendErrorFromUnknown(response, error, 'Không thể lấy context feedback.');
  }
}
