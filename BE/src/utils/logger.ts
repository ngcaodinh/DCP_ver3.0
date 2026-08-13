/**
 * Winston core cho structured logging và daily rotation.
 * Mục đích: tạo envelope JSON ổn định cho stdout/file để Filebeat có thể đọc.
 * Feature code phải dùng facade config/logger.ts; module này chỉ sanitize lại error sink.
 */
import os from 'node:os';
import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import { getRequestContext } from '../config/requestContext';
import { redactSensitiveData, REDACTED_REASON_MARKER } from './redactSensitiveData';
import { sanitizeProviderError } from './sanitizeProviderError';
import { sanitizeErrorStack } from './sanitizeErrorStack';

const SERVICE_NAME = 'dcp-backend';
const nodeEnvironment = process.env.NODE_ENV || 'development';
const isProduction = nodeEnvironment === 'production';
const isTestEnvironment = nodeEnvironment === 'test' || Boolean(process.env.VITEST);
const logDirectory = process.env.LOG_DIR || 'logs';
const isConsoleDriver = process.env.LOG_DRIVER === 'console';

// Test không được khởi tạo file transport để tránh tạo audit/log artifact trên disk.
const isFileTransportEnabled = !isTestEnvironment
  && !isConsoleDriver
  && process.env.LOG_FILE_ENABLED !== 'false';

/**
 * Gắn requestId và userId từ AsyncLocalStorage vào log record.
 * Mục đích: mọi call site hiện có tự nhận context mà không đổi signature logger.
 */
const attachRequestContext = winston.format((info) => {
  const context = getRequestContext();
  info.requestId = context?.requestId ?? null;
  info.userId = context?.userId ?? null;
  if (context?.workerRunId) {
    info.workerName = context.workerName;
    info.workerRunId = context.workerRunId;
    if (context.jobId !== undefined) info.jobId = context.jobId;
  }
  return info;
});

/**
 * Dựng envelope chung theo schema Logstash.
 * Mục đích: giữ các field điều tra ở top-level và bảo toàn metadata Winston nội bộ.
 */
const buildEnvelope = winston.format((info) => {
  info['@timestamp'] = info.timestamp;
  info['@version'] = '1';
  info.service = SERVICE_NAME;
  info.env = nodeEnvironment;
  info.hostname = os.hostname();
  info.pid = process.pid;
  return info;
});

/** Chuẩn hóa Error/rejection payload thành text an toàn trước khi ghi ra sink. */
function sanitizeErrorValue(value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: sanitizeProviderError(value.message) ?? '[ERROR_REDACTED]',
      stack: sanitizeErrorStack(value.stack) ?? '[STACK_REDACTED]'
    };
  }

  if (typeof value === 'string' || (value && typeof value === 'object')) {
    return sanitizeProviderError(value) ?? '[ERROR_REDACTED]';
  }

  return value;
}

/** Che toàn bộ tham số command-line trong exception metadata vì chúng có thể chứa secret. */
function sanitizeLifecycleProcess(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;

  const processMetadata = redactSensitiveData(value as Record<string, unknown>) ?? {};
  if ('argv' in processMetadata) processMetadata.argv = '[ARGUMENTS_REDACTED]';
  return processMetadata;
}

/** Sanitize toàn bộ record lỗi ở boundary Winston để exception/rejection không bypass facade. */
const sanitizeErrorRecord = winston.format((info) => {
  const isErrorRecord = Boolean(info.exception || info.rejection)
    || typeof info.stack === 'string'
    || typeof info.errorStack === 'string';
  if (!isErrorRecord) return info;

  const redactedInfo = redactSensitiveData(info as unknown as Record<string, unknown>);
  if (redactedInfo?._redaction) {
    // Khi record vượt cap top-level, xóa toàn bộ field phụ để marker không đi kèm payload thô.
    const preservedFields = new Set(['level', 'message', 'stack', 'errorStack', 'exception', 'rejection']);
    for (const fieldName of Object.keys(info)) {
      if (!preservedFields.has(fieldName)) delete info[fieldName];
    }
    info._redaction = redactedInfo._redaction;
  } else if (redactedInfo) {
    for (const [fieldName, fieldValue] of Object.entries(redactedInfo)) {
      info[fieldName] = fieldValue;
    }
  }

  if (typeof info.message === 'string') {
    info.message = sanitizeProviderError(info.message) ?? '[ERROR_REDACTED]';
  }
  if (typeof info.stack === 'string') {
    info.stack = sanitizeErrorStack(info.stack) ?? '[STACK_REDACTED]';
  }
  if (typeof info.errorStack === 'string') {
    info.errorStack = sanitizeErrorStack(info.errorStack) ?? '[STACK_REDACTED]';
  }
  if ('error' in info) info.error = sanitizeErrorValue(info.error);
  if ('reason' in info) {
    info.reason = info.reason === undefined || info.reason === null || info.reason === ''
      ? info.reason
      : REDACTED_REASON_MARKER;
  }
  if ('exception' in info && typeof info.exception !== 'boolean') {
    info.exception = sanitizeErrorValue(info.exception);
  }
  if ('rejection' in info && typeof info.rejection !== 'boolean') {
    info.rejection = sanitizeErrorValue(info.rejection);
  }
  if ('process' in info) {
    info.process = sanitizeLifecycleProcess(info.process);
  }
  return info;
});

/** Tạo JSON format dùng chung cho transport exception/rejection và test in-memory. */
export function createSafeErrorJsonFormat(): ReturnType<typeof winston.format.combine> {
  return winston.format.combine(sanitizeErrorRecord(), winston.format.json());
}

const baseFormat = winston.format.combine(
  winston.format.timestamp(),
  attachRequestContext(),
  buildEnvelope(),
  sanitizeErrorRecord()
);

/**
 * Format console development dễ đọc.
 * Mục đích: giữ stdout thân thiện ở local nhưng file transport vẫn JSON thuần.
 */
const developmentConsoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.printf((info) => {
    const requestIdSuffix = info.requestId ? ` [${String(info.requestId).slice(0, 8)}]` : '';
    const metaSuffix = info.meta ? ` ${JSON.stringify(info.meta)}` : '';
    return `${info.timestamp}${requestIdSuffix} ${info.level}: ${info.message}${metaSuffix}`;
  })
);

/** Them sanitizer cho Console vi transport nay co the handle exception/rejection khi file log bi tat. */
const consoleFormat = isProduction
  ? winston.format.combine(sanitizeErrorRecord(), winston.format.json())
  : winston.format.combine(sanitizeErrorRecord(), developmentConsoleFormat);

const activeTransports: winston.transport[] = [
  new winston.transports.Console({
    silent: isTestEnvironment,
    format: consoleFormat,
    handleExceptions: !isFileTransportEnabled && !isTestEnvironment,
    handleRejections: !isFileTransportEnabled && !isTestEnvironment
  })
];

/** Cấu hình transport combined dùng chung cho production và test kiểm tra cấu hình. */
export const combinedFileTransportOptions = {
  dirname: logDirectory,
  filename: 'dcp-%DATE%.log',
  datePattern: 'YYYY-MM-DD',
  zippedArchive: true,
  maxSize: '20m',
  maxFiles: '14d',
  utc: true,
  auditFile: `${logDirectory}/.dcp-combined-audit.json`
} as const;

/** Cấu hình rotate error log dùng chung cho transport error và kiểm thử cấu hình. */
export const errorFileTransportOptions = {
  dirname: logDirectory,
  filename: 'dcp-error-%DATE%.log',
  datePattern: 'YYYY-MM-DD',
  zippedArchive: true,
  maxSize: '20m',
  maxFiles: '30d',
  utc: true,
  auditFile: `${logDirectory}/.dcp-error-audit.json`
} as const;

/** Cấu hình rotate riêng cho uncaught exception để giới hạn dung lượng và retention. */
export const exceptionFileTransportOptions = {
  dirname: logDirectory,
  filename: 'dcp-exception-%DATE%.log',
  datePattern: 'YYYY-MM-DD',
  zippedArchive: true,
  maxSize: '20m',
  maxFiles: '30d',
  utc: true,
  auditFile: `${logDirectory}/.dcp-exception-audit.json`
} as const;

/** Cấu hình rotate riêng cho unhandled rejection để giới hạn dung lượng và retention. */
export const rejectionFileTransportOptions = {
  dirname: logDirectory,
  filename: 'dcp-rejection-%DATE%.log',
  datePattern: 'YYYY-MM-DD',
  zippedArchive: true,
  maxSize: '20m',
  maxFiles: '30d',
  utc: true,
  auditFile: `${logDirectory}/.dcp-rejection-audit.json`
} as const;

if (isFileTransportEnabled) {
  activeTransports.push(
    new DailyRotateFile({
      ...combinedFileTransportOptions,
      level: 'info',
      format: winston.format.json()
    }),
    new DailyRotateFile({
      ...errorFileTransportOptions,
      level: 'error',
      format: winston.format.json()
    }),
    new DailyRotateFile({
      ...exceptionFileTransportOptions,
      format: createSafeErrorJsonFormat(),
      handleExceptions: true
    }),
    new DailyRotateFile({
      ...rejectionFileTransportOptions,
      format: createSafeErrorJsonFormat(),
      handleRejections: true
    })
  );
}

/**
 * Logger Winston singleton.
 * Mục đích: khởi tạo đồng bộ để các module giữ reference ổn định ngay lúc import.
 */
export const winstonLogger = winston.createLogger({
  level: process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug'),
  format: baseFormat,
  transports: activeTransports,
  exitOnError: false
});
