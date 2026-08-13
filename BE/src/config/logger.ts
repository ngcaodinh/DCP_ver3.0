/**
 * Facade logger dùng chung toàn ứng dụng.
 * Mục đích: giữ nguyên API getLogger cho toàn bộ importer hiện có.
 * Runtime export duy nhất của module này phải là getLogger để tương thích các test mock.
 */
import { redactSensitiveData, type LogMetadata } from '../utils/redactSensitiveData';
import { winstonLogger } from '../utils/logger';
import { sanitizeProviderLogMessage } from '../utils/sanitizeProviderError';

type LogLevel = 'info' | 'warn' | 'error';

const useConsoleDriver = process.env.LOG_DRIVER === 'console';

const consoleFallback: Record<LogLevel, (message: string, metadata?: unknown) => void> = {
  info: (message, metadata) => (metadata ? console.log(message, metadata) : console.log(message)),
  warn: (message, metadata) => (metadata ? console.warn(message, metadata) : console.warn(message)),
  error: (message, metadata) => (metadata ? console.error(message, metadata) : console.error(message))
};

/**
 * Ghi log theo driver được cấu hình.
 * Mục đích: redact đúng một lần và giữ kill-switch console cho rollback nhanh.
 */
function writeLog(level: LogLevel, message: string, metadata?: LogMetadata): void {
  const safeMessage = sanitizeProviderLogMessage(message);
  if (!metadata) {
    if (useConsoleDriver) {
      consoleFallback[level](safeMessage);
      return;
    }
    winstonLogger.log(level, safeMessage);
    return;
  }

  const safeMetadata = redactSensitiveData(metadata);

  if (useConsoleDriver) {
    consoleFallback[level](safeMessage, safeMetadata);
    return;
  }

  // Metadata nghiệp vụ nằm trong meta để không đè correlation requestId ở top-level.
  winstonLogger.log(level, safeMessage, { meta: safeMetadata });
}

const logger = {
  /** Ghi log thông tin phục vụ theo dõi sự kiện thường nhật. */
  info(message: string, metadata?: LogMetadata): void {
    writeLog('info', message, metadata);
  },
  /** Ghi log cảnh báo phục vụ phát hiện tình huống bất thường. */
  warn(message: string, metadata?: LogMetadata): void {
    writeLog('warn', message, metadata);
  },
  /** Ghi log lỗi phục vụ điều tra và xử lý sự cố. */
  error(message: string, metadata?: LogMetadata): void {
    writeLog('error', message, metadata);
  }
};

/**
 * Lấy singleton logger dùng chung.
 * Mục đích: đảm bảo mọi module giữ cùng một object logger từ lúc import.
 */
export function getLogger(): typeof logger {
  return logger;
}
