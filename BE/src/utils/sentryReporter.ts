/**
 * Cổng duy nhất để gửi sự kiện terminal lên Sentry.
 * Mục đích: ép luật Winston-first của E6 — log luôn được ghi trước khi capture.
 */
import * as Sentry from '@sentry/node';
import { getLogger } from '../config/logger';
import { getRequestContext } from '../config/requestContext';
import { isSentryEnabled } from '../config/sentryConfig';
import type { LogMetadata } from './redactSensitiveData';

type SentryReportContext = {
  /** Nhãn phân loại issue trên Sentry, ví dụ http-5xx, job-dlq hoặc bootstrap. */
  errorSource: string;
  /** Metadata nghiệp vụ sẽ được redact tại beforeSend trước khi rời process. */
  metadata?: LogMetadata;
};

/** Chuẩn hóa mọi giá trị throw thành Error để Sentry luôn nhận được stack trace. */
function normalizeThrownValue(thrownValue: unknown): Error {
  return thrownValue instanceof Error ? thrownValue : new Error(String(thrownValue));
}

/**
 * Ghi log lỗi terminal và bắn lên Sentry theo thứ tự Winston-first.
 * @param message Câu mô tả sự kiện dùng cho log và tiêu đề issue.
 * @param error Lỗi gốc hoặc giá trị throw bất kỳ.
 * @param reportContext Nhãn phân loại và metadata nghiệp vụ.
 */
export function reportTerminalError(
  message: string,
  error: unknown,
  reportContext: SentryReportContext
): void {
  const normalizedError = normalizeThrownValue(error);

  // Bước 1: Winston luôn chạy, kể cả khi Sentry tắt.
  getLogger().error(message, {
    ...reportContext.metadata,
    errorSource: reportContext.errorSource,
    errorMessage: normalizedError.message,
    errorStack: normalizedError.stack
  });

  // Bước 2: observability là best-effort và không được ảnh hưởng nghiệp vụ.
  if (!isSentryEnabled()) return;

  try {
    const requestContext = getRequestContext();

    Sentry.withScope(scope => {
      scope.setTag('requestId', requestContext?.requestId ?? 'no-request-context');
      scope.setTag('errorSource', reportContext.errorSource);

      if (requestContext?.workerName) {
        scope.setTag('workerName', requestContext.workerName);
      }
      if (requestContext?.userId) {
        scope.setUser({ id: requestContext.userId });
      }
      if (reportContext.metadata) {
        scope.setExtras(reportContext.metadata);
      }

      Sentry.captureException(normalizedError);
    });
  } catch (sentryError) {
    // Lỗi khi báo lỗi không được tạo thêm sự cố hoặc làm process crash.
    getLogger().warn('Không thể gửi sự kiện lên Sentry.', {
      errorMessage: sentryError instanceof Error ? sentryError.message : String(sentryError)
    });
  }
}
