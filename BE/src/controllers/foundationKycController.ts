import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import { getLogger } from '../config/logger';
import { getFoundationKycIpHashSalt } from '../config/foundationKycRuntimeConfig';
import { FOUNDATION_KYC_SUBMISSION_POLICY } from '../constants/foundationKycPolicy';
import { foundationKycCaptchaFailuresTotal, foundationKycSubmissionsTotal } from '../config/metricsRegistry';
import { verifyRecaptchaToken } from '../services/recaptcha.service';
import { submitFoundationKyc } from '../services/foundationKyc.service';
import { countAgainstLimit, SubmissionThrottleCapacityError } from '../utils/submissionThrottle';
import { getPublicFeedbackClientIp } from '../utils/publicFeedbackClientIdentity';
import { sendErrorFromUnknown, sendErrorResponse, sendSuccessResponse } from '../utils/apiResponse';
import { foundationKycSubmitSchema } from '../validators/foundationKycValidator';

const RECAPTCHA_ACTION = 'foundation_kyc_submit';
const logger = getLogger();

/** Băm IP bằng HMAC để quota ngày không lưu địa chỉ IP thô trong Redis. */
function hashFoundationKycClientIp(clientIp: string): string {
  return crypto.createHmac('sha256', getFoundationKycIpHashSalt()).update(clientIp).digest('hex');
}

/** Tạo khóa quota UTC ổn định để giới hạn năm submission mỗi IP mỗi ngày. */
function buildFoundationKycDailyQuotaKey(clientIpHash: string): string {
  const dateKey = new Date().toISOString().slice(0, 10);
  return `dcp:foundation-kyc:ip:${clientIpHash}:${dateKey}`;
}

/** Xử lý POST KYC FOUNDATION public, không yêu cầu auth và không phản chiếu raw server error. */
export async function submitFoundationKycController(request: Request, response: Response): Promise<void> {
  const parsedPayload = foundationKycSubmitSchema.safeParse(request.body);
  if (!parsedPayload.success) {
    foundationKycSubmissionsTotal.inc({ result: 'validation_error' });
    sendErrorResponse(
      response,
      400,
      'Thông tin hồ sơ FOUNDATION chưa hợp lệ.',
      'VALIDATION_ERROR',
      parsedPayload.error.issues.map(issue => ({ field: issue.path.join('.') || 'unknown', message: issue.message }))
    );
    return;
  }

  if (parsedPayload.data.additionalEmail) {
    logger.warn('Foundation KYC honeypot triggered.');
    foundationKycSubmissionsTotal.inc({ result: 'honeypot' });
    sendSuccessResponse(response, 201, 'Hồ sơ đã được ghi nhận.', {
      submissionId: null,
      version: 0,
      status: 'PENDING_REVIEW'
    });
    return;
  }

  const clientIp = getPublicFeedbackClientIp(request);
  const recaptchaVerdict = await verifyRecaptchaToken(parsedPayload.data.recaptchaToken, RECAPTCHA_ACTION, clientIp);
  if (!recaptchaVerdict.isVerified) {
    foundationKycCaptchaFailuresTotal.inc({ reason: recaptchaVerdict.reason });
    foundationKycSubmissionsTotal.inc({ result: 'captcha_failed' });
    sendErrorResponse(response, 403, 'Không thể xác minh reCAPTCHA.', 'CAPTCHA_FAILED');
    return;
  }

  try {
    const clientIpHash = hashFoundationKycClientIp(clientIp);
    const quotaAllowed = await countAgainstLimit(
      buildFoundationKycDailyQuotaKey(clientIpHash),
      FOUNDATION_KYC_SUBMISSION_POLICY.daily.maxRequests,
      FOUNDATION_KYC_SUBMISSION_POLICY.daily.ttlSeconds
    );
    if (!quotaAllowed) {
      foundationKycSubmissionsTotal.inc({ result: 'rate_limited' });
      sendErrorResponse(response, 429, 'Bạn đã vượt quá số lần nộp hồ sơ trong ngày.', 'RATE_LIMIT_EXCEEDED');
      return;
    }

    const submissionResult = await submitFoundationKyc(parsedPayload.data, { clientIpHash });
    foundationKycSubmissionsTotal.inc({ result: 'success' });
    sendSuccessResponse(response, 201, 'Nộp hồ sơ Quỹ từ thiện thành công.', submissionResult);
  } catch (error) {
    if (error instanceof SubmissionThrottleCapacityError) {
      foundationKycSubmissionsTotal.inc({ result: 'rate_limited' });
      sendErrorResponse(response, 429, 'Hệ thống đang giới hạn tạm thời. Vui lòng thử lại sau.', 'RATE_LIMIT_EXCEEDED');
      return;
    }
    foundationKycSubmissionsTotal.inc({ result: 'error' });
    sendErrorFromUnknown(response, error, 'Không thể nộp hồ sơ FOUNDATION. Vui lòng thử lại.');
  }
}

