/**
 * Router cho các endpoint feedback public.
 * Không yêu cầu xác thực, nhưng mọi endpoint đều có giới hạn tốc độ.
 */

import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { createRateLimitMiddleware } from '../middleware/rateLimitMiddleware';
import {
  getPublicFeedbackListController,
  getPublicFeedbackStatsController
} from '../controllers/publicFeedbackController';
import {
  getFeedbackFormContextController,
  submitSingleFeedbackController
} from '../controllers/publicFeedbackSubmitController';
import { PUBLIC_FEEDBACK_SUBMISSION_POLICY } from '../constants/publicFeedbackPolicy';
import { publicFeedbackClientIdentityFallbackTotal } from '../config/metricsRegistry';
import {
  getPublicFeedbackClientIp,
  verifyPublicFeedbackClientIp
} from '../utils/publicFeedbackClientIdentity';

/** Giới hạn tốc độ chung cho các endpoint đọc feedback, giữ nguyên hợp đồng F3. */
const PUBLIC_FEEDBACK_RATE_LIMIT_CONFIG = {
  maxRequests: 30,
  windowMs: 60_000,
  bucketName: 'public-feedback'
};

/** Giới hạn riêng cho các request SSR mà mỗi người mở form cần thực hiện một lần. */
const FEEDBACK_PAGE_RATE_LIMIT_CONFIG = {
  maxRequests: PUBLIC_FEEDBACK_SUBMISSION_POLICY.minute.maxRequests,
  windowMs: PUBLIC_FEEDBACK_SUBMISSION_POLICY.minute.windowMs
};

/** Giới hạn tốc độ submit feedback, có dư địa cho 40 người dùng cùng một IP NAT. */
const SINGLE_FEEDBACK_RATE_LIMIT_CONFIG = {
  maxRequests: PUBLIC_FEEDBACK_SUBMISSION_POLICY.minute.maxRequests,
  windowMs: PUBLIC_FEEDBACK_SUBMISSION_POLICY.minute.windowMs,
  bucketName: 'feedback:single'
};

/** Ghi nhận route SSR nào đang rơi về IP nội bộ để lỗi topology không bị che khuất bởi rate limit. */
function createFeedbackIdentityObservationMiddleware(routeName: string) {
  return (request: Request, _response: Response, next: NextFunction): void => {
    const { isVerified } = verifyPublicFeedbackClientIp(request);
    if (!isVerified) {
      publicFeedbackClientIdentityFallbackTotal.inc({ route: routeName });
    }
    next();
  };
}

/**
 * Tạo router cho các route feedback public.
 * @returns Express Router đã được cấu hình.
 */
export function createPublicFeedbackRoutes(): Router {
  const router = Router();

  // Tạo các bucket riêng để lượt mở form không tranh ngân sách với danh sách hoặc submit.
  const publicFeedbackRateLimiter = createRateLimitMiddleware(
    PUBLIC_FEEDBACK_RATE_LIMIT_CONFIG.maxRequests,
    PUBLIC_FEEDBACK_RATE_LIMIT_CONFIG.windowMs,
    {
      bucketName: PUBLIC_FEEDBACK_RATE_LIMIT_CONFIG.bucketName,
      clientIpResolver: getPublicFeedbackClientIp
    }
  );
  const feedbackFormContextRateLimiter = createRateLimitMiddleware(
    FEEDBACK_PAGE_RATE_LIMIT_CONFIG.maxRequests,
    FEEDBACK_PAGE_RATE_LIMIT_CONFIG.windowMs,
    {
      bucketName: 'feedback:form-context',
      clientIpResolver: getPublicFeedbackClientIp
    }
  );
  const feedbackStatsRateLimiter = createRateLimitMiddleware(
    FEEDBACK_PAGE_RATE_LIMIT_CONFIG.maxRequests,
    FEEDBACK_PAGE_RATE_LIMIT_CONFIG.windowMs,
    {
      bucketName: 'feedback:stats',
      clientIpResolver: getPublicFeedbackClientIp
    }
  );
  const singleFeedbackRateLimiter = createRateLimitMiddleware(
    SINGLE_FEEDBACK_RATE_LIMIT_CONFIG.maxRequests,
    SINGLE_FEEDBACK_RATE_LIMIT_CONFIG.windowMs,
    {
      bucketName: SINGLE_FEEDBACK_RATE_LIMIT_CONFIG.bucketName,
      clientIpResolver: getPublicFeedbackClientIp
    }
  );
  const observeFormContextIdentity = createFeedbackIdentityObservationMiddleware('form-context');
  const observeStatsIdentity = createFeedbackIdentityObservationMiddleware('stats');

  /** POST /api/feedback/single nhận một feedback không cần xác thực. */
  router.post('/single', singleFeedbackRateLimiter, submitSingleFeedbackController);

  /** GET /api/feedback/form-context/:projectId cấp context và ticket một lần cho form SSR. */
  router.get(
    '/form-context/:projectId',
    observeFormContextIdentity,
    feedbackFormContextRateLimiter,
    getFeedbackFormContextController
  );

  /**
   * GET /api/feedback/public/:projectId
   * Lấy danh sách feedback công khai với pagination.
   * Chỉ trả về feedback không bị flag.
   * Rate limit: 30 requests/phút/IP.
   */
  router.get(
    '/public/:projectId',
    publicFeedbackRateLimiter,
    getPublicFeedbackListController
  );

  /**
   * GET /api/feedback/stats/:projectId
   * Lấy thống kê feedback công khai cho một dự án.
   * Trả về avgRating, totalCount, distribution.
   * Rate limit: 60 requests/phút/IP, dùng bucket riêng cho SSR form.
   * Kết quả được cache trong 10 phút.
   */
  router.get(
    '/stats/:projectId',
    observeStatsIdentity,
    feedbackStatsRateLimiter,
    getPublicFeedbackStatsController
  );

  return router;
}
