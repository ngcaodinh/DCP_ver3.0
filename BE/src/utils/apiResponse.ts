import { Response } from 'express';
import { ApplicationError } from './applicationError';

export type ApiErrorDetail = {
  field: string;
  message: string;
};

/**
 * Hàm trả response thành công chuẩn hóa.
 * Mục đích: đồng bộ format success để frontend dễ xử lý.
 */
export function sendSuccessResponse<T>(
  response: Response,
  statusCode: number,
  message: string,
  data: T,
  correlationId?: string
): void {
  response.status(statusCode).json({
    success: true,
    message,
    data,
    correlationId: correlationId || null
  });
}

/**
 * Hàm trả response lỗi chuẩn hóa.
 * Mục đích: đồng bộ format error cho tất cả API.
 */
export function sendErrorResponse(
  response: Response,
  statusCode: number,
  message: string,
  errorCode: string,
  details?: ApiErrorDetail[],
  correlationId?: string
): void {
  response.status(statusCode).json({
    success: false,
    message,
    errorCode,
    details: details || [],
    correlationId: correlationId || null
  });
}

/**
 * Hàm map lỗi bất kỳ thành response lỗi chuẩn.
 * Mục đích: gom xử lý lỗi chung tại controller.
 */
export function sendErrorFromUnknown(
  response: Response,
  error: unknown,
  fallbackMessage: string,
  correlationId?: string
): void {
  if (error instanceof ApplicationError) {
    sendErrorResponse(response, error.statusCode, error.message, error.errorCode, [], correlationId);
    return;
  }

  sendErrorResponse(response, 500, fallbackMessage, 'INTERNAL_ERROR', [], correlationId);
}

