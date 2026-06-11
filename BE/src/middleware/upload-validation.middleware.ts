/**
 * Middleware validation cho file upload: kích thước, MIME type whitelist,
 * magic bytes detection, giới hạn CSV row count.
 * Middleware này đọc một phần nhỏ buffer để detect magic bytes,
 * sau đó gắn thông tin validation vào request để controller xử lý tiếp.
 */

import { Request, Response, NextFunction } from 'express';
import {
  detectFileTypeFromBuffer,
  getFileSizeLimit,
  ALLOWED_MIME_TYPES
} from '../services/upload-validation.service';
import { getLogger } from '../config/logger';

const logger = getLogger();

/**
 * Số bytes đầu tiên cần đọc để detect magic bytes.
 * Đủ cover tất cả signatures.
 */
const READ_BUFFER_SIZE = 16;

/**
 * Giới hạn số dòng tối đa cho CSV batch upload.
 */
export const MAX_CSV_ROWS = 1000;

/**
 * Các MIME type được phép upload.
 * Thống nhất với ALLOWED_MIME_TYPES trong upload-validation.service.ts.
 */
export const UPLOAD_ALLOWED_MIME_TYPES: ReadonlyArray<string> = ALLOWED_MIME_TYPES;

type FileValidationResult = {
  isValid: boolean;
  detectedMimeType: string;
  detectedExtension: string;
  errorCode?: 'FILE_TOO_LARGE' | 'UNSUPPORTED_MEDIA_TYPE';
  errorMessage?: string;
};

/**
 * Validation một file buffer: kiểm tra size và MIME type whitelist + magic bytes.
 *
 * @param fileSize - Kích thước file thực tế (từ file.size)
 * @param signatureBuffer - Buffer trích xuất magic bytes để detect type
 * @param declaredMimeType - MIME type từ request header (có thể bị spoof)
 * @param fileName - Tên file (để log)
 * @returns FileValidationResult chứa kết quả validation
 */
function validateFileBuffer(
  fileSize: number,
  signatureBuffer: Buffer,
  declaredMimeType: string,
  fileName: string
): FileValidationResult {
  // Bước 1: Kiểm tra kích thước tổng thể (dùng fileSize thực tế)
  const detected = detectFileTypeFromBuffer(signatureBuffer);
  const effectiveMimeType = detected.mimeType;
  const sizeLimit = getFileSizeLimit(effectiveMimeType);

  if (fileSize > sizeLimit) {
    logger.warn('File upload rejected: size exceeds limit', {
      fileName,
      declaredMimeType,
      detectedMimeType: effectiveMimeType,
      actualSize: fileSize,
      sizeLimit
    });
    return {
      isValid: false,
      detectedMimeType: effectiveMimeType,
      detectedExtension: detected.extension,
      errorCode: 'FILE_TOO_LARGE',
      errorMessage: `File size (${formatBytes(fileSize)}) exceeds maximum allowed size (${formatBytes(sizeLimit)})`
    };
  }

  // Bước 2: Kiểm tra MIME type whitelist
  if (!UPLOAD_ALLOWED_MIME_TYPES.includes(effectiveMimeType)) {
    logger.warn('File upload rejected: unsupported media type', {
      fileName,
      declaredMimeType,
      detectedMimeType: effectiveMimeType
    });
    return {
      isValid: false,
      detectedMimeType: effectiveMimeType,
      detectedExtension: detected.extension,
      errorCode: 'UNSUPPORTED_MEDIA_TYPE',
      errorMessage: `File type "${effectiveMimeType}" is not allowed. Allowed types: ${UPLOAD_ALLOWED_MIME_TYPES.join(', ')}`
    };
  }

  return {
    isValid: true,
    detectedMimeType: effectiveMimeType,
    detectedExtension: detected.extension
  };
}

/**
 * Định dạng bytes thành human-readable string.
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Lấy giới hạn kích thước cho một loại upload cụ thể.
 * Ưu tiên: env var > type-based limit > default.
 */
function resolveFileSizeLimit(uploadType: 'image' | 'csv' | 'json'): number {
  const envLimit = process.env[`MAX_UPLOAD_SIZE_${uploadType.toUpperCase()}_BYTES`];
  if (envLimit) {
    const parsed = parseInt(envLimit, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return getFileSizeLimit(
    uploadType === 'image' ? 'image/jpeg' :
    uploadType === 'csv' ? 'text/csv' : 'application/json'
  );
}

// ============================================================================
// Core Middleware
// ============================================================================

/**
 * Middleware validate file upload cho Multer memory storage.
 * Đọc magic bytes từ buffer để xác định MIME type thực sự,
 * kiểm tra kích thước và whitelist.
 *
 * Đặt `request.validatedFile` với kết quả validation nếu pass,
 * hoặc gửi response lỗi ngay lập tức nếu fail.
 *
 * @param uploadType - Loại upload: 'image' | 'csv' | 'json'
 */
export function createUploadValidationMiddleware(uploadType: 'image' | 'csv' | 'json') {
  return (request: Request, response: Response, next: NextFunction): void => {
    const file = request.file;

    if (!file) {
      // Không có file → pass qua, để controller/controller xử lý
      next();
      return;
    }

    const { fieldname, originalname, mimetype, size, buffer } = file;
    const resolvedLimit = resolveFileSizeLimit(uploadType);

    // Truncate buffer để chỉ đọc phần signature (performance)
    const signatureBuffer = buffer.slice(0, Math.min(READ_BUFFER_SIZE, buffer.length));
    const result = validateFileBuffer(size, signatureBuffer, mimetype, originalname);

    // Attach validation result vào request để controller/service downstream có thể sử dụng
    request.validatedFile = {
      originalName: originalname,
      fieldName: fieldname,
      declaredMimeType: mimetype,
      detectedMimeType: result.detectedMimeType,
      detectedExtension: result.detectedExtension,
      size,
      sizeLimit: resolvedLimit,
      isValid: result.isValid,
      errorCode: result.errorCode,
      errorMessage: result.errorMessage
    };

    if (!result.isValid) {
      logger.warn('Upload validation failed', {
        originalName: originalname,
        fieldName: fieldname,
        errorCode: result.errorCode,
        errorMessage: result.errorMessage
      });

      if (result.errorCode === 'FILE_TOO_LARGE') {
        response.status(413).json({
          success: false,
          message: 'File size exceeds the allowed limit.',
          errorCode: 'PAYLOAD_TOO_LARGE',
          details: [{ field: fieldname, message: result.errorMessage }]
        });
        return;
      }

      response.status(415).json({
        success: false,
        message: 'File type is not supported.',
        errorCode: 'UNSUPPORTED_MEDIA_TYPE',
        details: [{ field: fieldname, message: result.errorMessage }]
      });
      return;
    }

    logger.info('File upload validated', {
      originalName: originalname,
      fieldName: fieldname,
      detectedMimeType: result.detectedMimeType,
      detectedExtension: result.detectedExtension,
      size: formatBytes(size)
    });

    next();
  };
}

/**
 * Middleware validate batch upload (nhiều files cùng lúc).
 * Áp dụng cùng logic validation cho từng file.
 */
export function createBatchUploadValidationMiddleware(uploadType: 'image' | 'csv' | 'json') {
  return (request: Request, response: Response, next: NextFunction): void => {
    const files = request.files;

    if (!files || !Array.isArray(files) || files.length === 0) {
      next();
      return;
    }

    const validationResults: Array<{
      index: number;
      originalName: string;
      fieldName: string;
      isValid: boolean;
      detectedMimeType: string;
      errorCode?: string;
      errorMessage?: string;
    }> = [];

    const resolvedLimit = resolveFileSizeLimit(uploadType);

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const signatureBuffer = file.buffer.slice(0, Math.min(READ_BUFFER_SIZE, file.buffer.length));
      const result = validateFileBuffer(file.size, signatureBuffer, file.mimetype, file.originalname);

      validationResults.push({
        index: i,
        originalName: file.originalname,
        fieldName: file.fieldname,
        isValid: result.isValid,
        detectedMimeType: result.detectedMimeType,
        errorCode: result.errorCode,
        errorMessage: result.errorMessage
      });
    }

    // Attach batch results vào request
    request.validatedFiles = validationResults;

    const failedFiles = validationResults.filter(r => !r.isValid);
    if (failedFiles.length > 0) {
      const firstFailure = failedFiles[0];
      const details = failedFiles.map(f => ({
        file: f.originalName,
        field: f.fieldName,
        message: f.errorMessage
      }));

      logger.warn('Batch upload validation failed', {
        totalFiles: files.length,
        failedCount: failedFiles.length,
        failedFiles: details.map(d => d.file)
      });

      if (firstFailure.errorCode === 'FILE_TOO_LARGE') {
        response.status(413).json({
          success: false,
          message: 'One or more files exceed the size limit.',
          errorCode: 'PAYLOAD_TOO_LARGE',
          details
        });
        return;
      }

      response.status(415).json({
        success: false,
        message: 'One or more files have unsupported types.',
        errorCode: 'UNSUPPORTED_MEDIA_TYPE',
        details
      });
      return;
    }

    logger.info('Batch upload validated', {
      totalFiles: files.length,
      types: validationResults.map(r => r.detectedMimeType)
    });

    next();
  };
}

/**
 * Middleware validate CSV row count sau khi file đã được parse.
 * Gắn kết quả vào request để controller xử lý.
 *
 * @param rowCount - Số dòng đã parse được từ CSV
 */
export function createCsvRowCountValidationMiddleware(rowCount: number) {
  return (_request: Request, response: Response, next: NextFunction): void => {
    if (rowCount > MAX_CSV_ROWS) {
      logger.warn('CSV row count exceeds limit', {
        rowCount,
        maxRows: MAX_CSV_ROWS
      });
      response.status(413).json({
        success: false,
        message: `Số dòng vượt quá giới hạn ${MAX_CSV_ROWS}.`,
        errorCode: 'PAYLOAD_TOO_LARGE',
        details: [{
          field: 'csv',
          message: `Số dòng vượt quá giới hạn ${MAX_CSV_ROWS}. Hiện tại: ${rowCount} dòng.`
        }]
      });
      return;
    }
    next();
  };
}

// ============================================================================
// Extended types for Request
// ============================================================================

declare global {
  namespace Express {
    interface Request {
      validatedFile?: {
        originalName: string;
        fieldName: string;
        declaredMimeType: string;
        detectedMimeType: string;
        detectedExtension: string;
        size: number;
        sizeLimit: number;
        isValid: boolean;
        errorCode?: string;
        errorMessage?: string;
      };
      validatedFiles?: Array<{
        index: number;
        originalName: string;
        fieldName: string;
        isValid: boolean;
        detectedMimeType: string;
        errorCode?: string;
        errorMessage?: string;
      }>;
    }
  }
}

// ============================================================================
// ClamAV Placeholder
// ============================================================================

/**
 * Placeholder cho ClamAV malware scan integration.
 * Hiện tại chỉ log warning, cần implement thực khi tích hợp ClamAV.
 *
 * @param fileBuffer - Buffer chứa dữ liệu file cần scan
 * @param fileName - Tên file để log
 * @returns Promise<boolean> - true nếu file an toàn, false nếu phát hiện malware
 */
export async function scanFileForMalware(fileBuffer: Buffer, fileName: string): Promise<boolean> {
  logger.warn('Malware scan skipped: ClamAV not yet integrated', {
    fileName,
    fileSize: fileBuffer.length
  });
  // TODO: Tích hợp ClamAV khi infrastructure sẵn sàng.
  // Ví dụ: const result = await clamav.scan(fileBuffer);
  // return result.isClean;
  return true;
}
