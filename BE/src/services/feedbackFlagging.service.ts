/**
 * Service quản lý việc flag/unflag feedback bởi admin.
 * Cung cấp các API để liệt kê, flag, và unflag feedback spam.
 */

import { BeneficiaryFeedbackModel, BeneficiaryFeedback, FlagHistoryEntry } from '../models/beneficiaryFeedbackModel';
import { ApplicationError } from '../utils/applicationError';

/**
 * Lỗi khi feedback không tồn tại.
 */
export class FeedbackNotFoundError extends ApplicationError {
  constructor(feedbackId: string) {
    super(
      `Feedback với ID '${feedbackId}' không tồn tại.`,
      404,
      'FEEDBACK_NOT_FOUND'
    );
    this.name = 'FeedbackNotFoundError';
  }
}

/**
 * Lỗi validation cho flag action.
 */
export class FlagValidationError extends ApplicationError {
  constructor(message: string) {
    super(message, 400, 'VALIDATION_ERROR');
    this.name = 'FlagValidationError';
  }
}

/**
 * Query options cho việc lấy danh sách flagged feedback.
 */
export interface GetFlaggedFeedbackOptions {
  /** Số trang (1-based) */
  page?: number;
  /** Số lượng item mỗi trang */
  limit?: number;
  /** Lọc theo projectId */
  projectId?: string;
  /** Lọc theo riskScore tối thiểu */
  minRiskScore?: number;
}

/**
 * Kết quả phân trang cho danh sách flagged feedback.
 */
export interface PaginatedFlaggedFeedback {
  /** Danh sách feedback */
  items: BeneficiaryFeedback[];
  /** Tổng số bản ghi */
  total: number;
  /** Trang hiện tại */
  page: number;
  /** Số lượng mỗi trang */
  limit: number;
  /** Tổng số trang */
  totalPages: number;
}

/**
 * Lấy danh sách feedback đã được flag với phân trang.
 * 
 * @param options Các tùy chọn query (page, limit, projectId, minRiskScore)
 * @returns PaginatedFlaggedFeedback với danh sách và thông tin phân trang
 */
export async function getFlaggedFeedback(
  options: GetFlaggedFeedbackOptions = {}
): Promise<PaginatedFlaggedFeedback> {
  const {
    page = 1,
    limit = 20,
    projectId,
    minRiskScore
  } = options;

  // Validate pagination params
  const validPage = Math.max(1, page);
  const validLimit = Math.min(50, Math.max(1, limit));
  const skip = (validPage - 1) * validLimit;

  // Xây dựng query filter
  const filter: Record<string, unknown> = { isFlagged: true };

  if (projectId) {
    filter.projectId = projectId;
  }

  if (minRiskScore !== undefined) {
    filter.riskScore = { $gte: minRiskScore };
  }

  // Execute query với pagination
  const [items, total] = await Promise.all([
    BeneficiaryFeedbackModel
      .find(filter)
      .sort({ flaggedAt: -1, createdAt: -1 })
      .skip(skip)
      .limit(validLimit)
      .lean<BeneficiaryFeedback[]>()
      .exec(),
    BeneficiaryFeedbackModel.countDocuments(filter).exec()
  ]);

  return {
    items,
    total,
    page: validPage,
    limit: validLimit,
    totalPages: Math.ceil(total / validLimit)
  };
}

/**
 * Lấy feedback theo feedbackId.
 * 
 * @param feedbackId ID của feedback cần tìm
 * @returns BeneficiaryFeedback document
 * @throws FeedbackNotFoundError nếu không tìm thấy
 */
async function findFeedbackById(feedbackId: string): Promise<BeneficiaryFeedback> {
  const feedback = await BeneficiaryFeedbackModel
    .findOne({ feedbackId })
    .lean<BeneficiaryFeedback>()
    .exec();

  if (!feedback) {
    throw new FeedbackNotFoundError(feedbackId);
  }

  return feedback;
}

/**
 * Validate reason string.
 * 
 * @param reason Lý do cần validate
 * @throws FlagValidationError nếu không hợp lệ
 */
function validateReason(reason: string | undefined): void {
  if (!reason || typeof reason !== 'string') {
    throw new FlagValidationError('Lý do flag là bắt buộc.');
  }

  const trimmedReason = reason.trim();

  if (trimmedReason.length < 5) {
    throw new FlagValidationError('Lý do flag phải có ít nhất 5 ký tự.');
  }

  if (trimmedReason.length > 500) {
    throw new FlagValidationError('Lý do flag không được vượt quá 500 ký tự.');
  }
}

/**
 * Admin flag một feedback thủ công.
 * 
 * @param feedbackId ID của feedback cần flag
 * @param adminUserId User ID của admin thực hiện
 * @param reason Lý do flag (5-500 ký tự)
 * @returns Feedback đã được update
 * @throws FeedbackNotFoundError nếu feedback không tồn tại
 * @throws FlagValidationError nếu reason không hợp lệ
 */
export async function flagFeedbackManually(
  feedbackId: string,
  adminUserId: string,
  reason: string
): Promise<BeneficiaryFeedback> {
  // Validate inputs
  validateReason(reason);

  // Tìm feedback hiện tại
  const currentFeedback = await findFeedbackById(feedbackId);

  // Lưu trạng thái trước khi thay đổi
  const previousFlaggedState = currentFeedback.isFlagged;

  // Tạo flag history entry
  const flagHistoryEntry: FlagHistoryEntry = {
    action: 'flagged',
    reason: reason.trim(),
    performedBy: adminUserId,
    performedAt: new Date(),
    previousFlaggedState
  };

  // Update feedback
  const updatedFeedback = await BeneficiaryFeedbackModel
    .findOneAndUpdate(
      { feedbackId },
      {
        $set: {
          isFlagged: true,
          flagReason: reason.trim(),
          flaggedAt: new Date(),
          flaggedBy: adminUserId
        },
        // Cap flagHistory ở 100 entries cuối để tránh document phình to vượt MongoDB 16MB limit.
        // Khi admin flag/unflag liên tục, các entries cũ sẽ bị loại bỏ FIFO.
        $push: {
          flagHistory: {
            $each: [flagHistoryEntry],
            $slice: -100
          }
        }
      },
      { new: true }
    )
    .lean<BeneficiaryFeedback>()
    .exec();

  if (!updatedFeedback) {
    throw new FeedbackNotFoundError(feedbackId);
  }

  return updatedFeedback;
}

/**
 * Admin unflag một feedback.
 * 
 * @param feedbackId ID của feedback cần unflag
 * @param adminUserId User ID của admin thực hiện
 * @returns Feedback đã được update
 * @throws FeedbackNotFoundError nếu feedback không tồn tại
 */
export async function unflagFeedback(
  feedbackId: string,
  adminUserId: string
): Promise<BeneficiaryFeedback> {
  // Tìm feedback hiện tại
  const currentFeedback = await findFeedbackById(feedbackId);

  // Lưu trạng thái trước khi thay đổi
  const previousFlaggedState = currentFeedback.isFlagged;

  // Tạo flag history entry
  const flagHistoryEntry: FlagHistoryEntry = {
    action: 'unflagged',
    reason: 'Manual unflag by admin',
    performedBy: adminUserId,
    performedAt: new Date(),
    previousFlaggedState
  };

  // Update feedback - chỉ unflag nếu đang được flag
  const updatedFeedback = await BeneficiaryFeedbackModel
    .findOneAndUpdate(
      { feedbackId },
      {
        $set: {
          isFlagged: false,
          // Giữ nguyên flagReason để audit trail
          // flaggedAt và flaggedBy giữ nguyên để biết ai đã flag lần đầu
        },
        // Cap flagHistory ở 100 entries cuối để tránh document phình to vượt MongoDB 16MB limit.
        $push: {
          flagHistory: {
            $each: [flagHistoryEntry],
            $slice: -100
          }
        }
      },
      { new: true }
    )
    .lean<BeneficiaryFeedback>()
    .exec();

  if (!updatedFeedback) {
    throw new FeedbackNotFoundError(feedbackId);
  }

  return updatedFeedback;
}
