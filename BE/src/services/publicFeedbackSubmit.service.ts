import crypto from 'crypto';
import { getLogger } from '../config/logger';
import { getPublicFeedbackIpHashSalt } from '../config/publicFeedbackRuntimeConfig';
import { PUBLIC_FEEDBACK_SUBMISSION_POLICY } from '../constants/publicFeedbackPolicy';
import { findFeedbackProjectByProjectId, type ProjectRecord } from '../models/projectModel';
import { BeneficiaryFeedbackModel } from '../models/beneficiaryFeedbackModel';
import { ApplicationError } from '../utils/applicationError';
import {
  countAgainstLimit,
  releaseSubmissionSlot,
  SubmissionThrottleCapacityError,
  claimOnce
} from '../utils/submissionThrottle';
import { issueSubmissionTicket, TICKET_TTL_SECONDS, verifySubmissionTicket } from '../utils/feedbackSubmissionTicket';
import { hashBeneficiaryName } from '../utils/feedbackText';
import { computeRiskScore, shouldFlagFeedback } from './feedbackSpamDetection.service';
import { invalidatePublicFeedbackStatsCache } from './publicFeedback.service';
import type { PublicFeedbackSubmitPayload } from '../validators/publicFeedbackSubmitValidator';

const logger = getLogger();
const TICKET_SLOT_TTL_SECONDS = TICKET_TTL_SECONDS;
const CONTENT_SLOT_TTL_SECONDS = 90;
const ACCEPTING_PROJECT_STATUSES = new Set<ProjectRecord['status']>(['ACTIVE', 'COMPLETED', 'CLOSED']);

export interface FeedbackFormContextResult {
  projectId: string;
  projectName: string;
  isAcceptingFeedback: boolean;
  submissionTicket?: string;
}

export interface PublicFeedbackSubmissionResult {
  feedbackId: string;
  isFlagged: boolean;
}

/** Chuẩn hóa comment để cùng nội dung khác khoảng trắng không thể né cửa sổ chống trùng. */
function normalizeComment(comment: string): string {
  return comment.trim().toLocaleLowerCase('vi-VN').replace(/\s+/gu, ' ');
}

/** Băm IP bằng HMAC-SHA256 với secret riêng để áp hạn mức và điều tra lạm dụng mà không lưu IP thô. */
function hashSubmissionIp(clientIp: string): string {
  return crypto.createHmac('sha256', getPublicFeedbackIpHashSalt()).update(clientIp).digest('hex');
}

/** Tạo khóa ngày theo UTC để hạn mức có cùng mốc thời gian giữa các instance backend. */
function createUtcDateKey(): string {
  return new Date().toISOString().slice(0, 10).replace(/-/gu, '');
}

/** Tạo feedbackId public không phụ thuộc vào hash nội dung hoặc IP. */
function createPublicFeedbackId(): string {
  return `FB-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

/** Chuyển lỗi đầy bộ nhớ fallback thành lỗi 429 có thể trả an toàn cho client. */
function createThrottleCapacityError(): ApplicationError {
  return new ApplicationError(
    'Hệ thống đang bận. Vui lòng thử lại sau ít phút.',
    429,
    'RATE_LIMIT_EXCEEDED'
  );
}

/** Trả dữ liệu form tối thiểu và ticket mới cho project còn nhận phản hồi. */
export async function getPublicFeedbackFormContext(projectId: string): Promise<FeedbackFormContextResult> {
  const project = await findFeedbackProjectByProjectId(projectId);
  if (!project) {
    throw new ApplicationError('Dự án không tồn tại.', 404, 'PROJECT_NOT_FOUND');
  }

  const isAcceptingFeedback = ACCEPTING_PROJECT_STATUSES.has(project.status);
  return {
    projectId: project.projectId,
    projectName: project.name,
    isAcceptingFeedback,
    ...(isAcceptingFeedback ? { submissionTicket: issueSubmissionTicket(project.projectId) } : {})
  };
}

/** Kiểm tra hạn mức ngày theo hash IP; giới hạn phút đã được route middleware đảm nhiệm. */
async function enforceIpQuotas(clientIp: string): Promise<string> {
  const submissionIpHash = hashSubmissionIp(clientIp);
  const quotaKey = `dcp:feedback:ip:${submissionIpHash}:${createUtcDateKey()}`;
  let isAllowed: boolean;
  try {
    isAllowed = await countAgainstLimit(
      quotaKey,
      PUBLIC_FEEDBACK_SUBMISSION_POLICY.daily.maxRequests,
      PUBLIC_FEEDBACK_SUBMISSION_POLICY.daily.ttlSeconds
    );
  } catch (error) {
    if (error instanceof SubmissionThrottleCapacityError) throw createThrottleCapacityError();
    throw error;
  }
  if (!isAllowed) {
    throw createThrottleCapacityError();
  }
  return submissionIpHash;
}

/** Ghi feedback public sau khi đã kiểm tra ticket, trạng thái project, chống trùng và điểm spam. */
export async function submitSingleFeedback(
  payload: PublicFeedbackSubmitPayload,
  clientIp: string
): Promise<PublicFeedbackSubmissionResult> {
  const ticketPayload = verifySubmissionTicket(payload.submissionTicket, payload.projectId);
  const submissionIpHash = await enforceIpQuotas(clientIp);
  const claimedSlotKeys: string[] = [];
  const ticketSlotKey = `dcp:feedback:ticket:${ticketPayload.nonce}`;

  try {
    const ticketClaimed = await claimOnce(ticketSlotKey, TICKET_SLOT_TTL_SECONDS);
    if (!ticketClaimed) {
      throw new ApplicationError('Phiên gửi feedback đã hết hạn hoặc đã được dùng.', 400, 'TICKET_ALREADY_USED');
    }
    claimedSlotKeys.push(ticketSlotKey);

    const project = await findFeedbackProjectByProjectId(payload.projectId);
    if (!project) {
      throw new ApplicationError('Dự án không tồn tại.', 404, 'PROJECT_NOT_FOUND');
    }
    if (!ACCEPTING_PROJECT_STATUSES.has(project.status)) {
      throw new ApplicationError('Dự án hiện chưa mở nhận phản hồi.', 409, 'PROJECT_NOT_ACCEPTING_FEEDBACK');
    }

    if (payload.comment.length >= 20) {
      const contentHash = crypto.createHash('sha256')
        .update(`${payload.rating}|${normalizeComment(payload.comment)}`)
        .digest('hex');
      const contentSlotKey = `dcp:feedback:content:${payload.projectId}:${contentHash}`;
      const contentClaimed = await claimOnce(contentSlotKey, CONTENT_SLOT_TTL_SECONDS);
      if (!contentClaimed) {
        throw new ApplicationError(
          'Nội dung này vừa được gửi. Nếu muốn bổ sung, vui lòng viết thêm chi tiết.',
          429,
          'DUPLICATE_SUBMISSION'
        );
      }
      claimedSlotKeys.push(contentSlotKey);
    }

    const beneficiaryNameHash = payload.anonymousName
      ? hashBeneficiaryName(payload.anonymousName)
      : hashBeneficiaryName(crypto.randomUUID());
    const riskScore = computeRiskScore(payload.rating, payload.comment);
    const isFlagged = shouldFlagFeedback(riskScore);
    const feedbackId = createPublicFeedbackId();

    await BeneficiaryFeedbackModel.create({
      feedbackId,
      projectId: payload.projectId,
      beneficiaryNameHash,
      rating: payload.rating,
      comment: payload.comment,
      submittedAt: new Date(),
      riskScore,
      isFlagged,
      uploadedByOrganizationId: project.organizationId,
      batchContentHash: `pub-${crypto.randomUUID()}`,
      source: 'public',
      submissionIpHash
    });

    await invalidatePublicFeedbackStatsCache(payload.projectId);
    logger.info('Public feedback submitted.', { projectId: payload.projectId, feedbackId, isFlagged });

    return { feedbackId, isFlagged };
  } catch (error) {
    const normalizedError = error instanceof SubmissionThrottleCapacityError
      ? createThrottleCapacityError()
      : error;
    const shouldKeepTicketClaimed = normalizedError instanceof ApplicationError && normalizedError.errorCode === 'DUPLICATE_SUBMISSION';
    const releasableSlotKeys = shouldKeepTicketClaimed
      ? claimedSlotKeys.filter((key) => key !== ticketSlotKey)
      : claimedSlotKeys;
    await Promise.all(releasableSlotKeys.map((key) => releaseSubmissionSlot(key)));
    throw normalizedError;
  }
}
