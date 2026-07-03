/**
 * Custom error classes cho Feedback Batch processing.
 * Mục đích: thay thế string matching trong controller bằng type-safe error classes.
 */

import { ApplicationError } from './applicationError';

/**
 * Lỗi khi batch size vượt quá giới hạn 1000 rows.
 */
export class BatchSizeExceededError extends ApplicationError {
  constructor(message: string = 'Batch size exceeds 1000 limit.') {
    super(message, 400, 'BATCH_SIZE_EXCEEDED');
    this.name = 'BatchSizeExceededError';
  }
}

/**
 * Lỗi khi file size vượt quá giới hạn 5MB.
 */
export class FileTooLargeError extends ApplicationError {
  constructor(message: string = 'File size exceeds 5MB limit.') {
    super(message, 400, 'FILE_TOO_LARGE');
    this.name = 'FileTooLargeError';
  }
}

/**
 * Lỗi khi CSV format không hợp lệ.
 */
export class InvalidCsvError extends ApplicationError {
  constructor(message: string = 'Invalid CSV format.') {
    super(message, 400, 'INVALID_CSV_FORMAT');
    this.name = 'InvalidCsvError';
  }
}

/**
 * Lỗi khi payload không phải là JSON array.
 */
export class PayloadMustBeArrayError extends ApplicationError {
  constructor(message: string = 'Payload must be a JSON array.') {
    super(message, 400, 'PAYLOAD_MUST_BE_ARRAY');
    this.name = 'PayloadMustBeArrayError';
  }
}

/**
 * Kiểm tra xem error có phải là FeedbackBatch error không.
 * @param error Error cần kiểm tra
 * @returns true nếu là FeedbackBatch error
 */
export function isFeedbackBatchError(error: unknown): boolean {
  // Check by class instanceof cho F1 errors
  if (error instanceof BatchSizeExceededError
    || error instanceof FileTooLargeError
    || error instanceof InvalidCsvError
    || error instanceof PayloadMustBeArrayError) {
    return true;
  }

  // Check by errorCode string cho F2 errors (tránh circular import)
  // FeedbackNotFoundError: errorCode = 'FEEDBACK_NOT_FOUND'
  // FlagValidationError: errorCode = 'VALIDATION_ERROR'
  if (error instanceof ApplicationError) {
    const errorCode = (error as ApplicationError).errorCode;
    return errorCode === 'FEEDBACK_NOT_FOUND' || errorCode === 'VALIDATION_ERROR';
  }

  return false;
}
