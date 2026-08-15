/**
 * Service xử lý batch upload feedback từ CSV hoặc JSON.
 * Logic chính: parse, validate, hash, flag spam, store vào MongoDB.
 */

import crypto from 'crypto';
import { parse } from 'csv-parse/sync';
import { getLogger } from '../config/logger';
import { BeneficiaryFeedbackModel } from '../models/beneficiaryFeedbackModel';
import {
  validateBatchFeedback,
  type BeneficiaryFeedbackRow
} from '../validators/feedbackBatchValidator';
import {
  computeRiskScore,
  shouldFlagFeedback,
  RISK_SCORE_AUTO_FLAG_THRESHOLD
} from './feedbackSpamDetection.service';
import {
  BatchSizeExceededError,
  FileTooLargeError,
  InvalidCsvError,
  PayloadMustBeArrayError
} from '../utils/feedbackBatchError';
import { escapeFormulaInjection, hashBeneficiaryName } from '../utils/feedbackText';

export { escapeFormulaInjection, hashBeneficiaryName } from '../utils/feedbackText';

const logger = getLogger();

/**
 * Xử lý tất cả tiền tố chèn công thức trong một dòng feedback.
 * Chỉ trường văn bản tự do là comment có nguy cơ chèn công thức.
 * Các trường còn lại đã được schema Zod kiểm tra chặt chẽ nên không cần xử lý thêm.
 * @param row Dòng feedback cần xử lý.
 * @returns Dòng feedback đã được xử lý.
 */
function sanitizeFeedbackRow(row: BeneficiaryFeedbackRow): BeneficiaryFeedbackRow {
  return {
    ...row,
    comment: escapeFormulaInjection(row.comment)
  };
}

/**
 * Giới hạn số dòng tối đa trong một batch.
 */
export const MAX_BATCH_SIZE = 1000;

/**
 * Kích thước tối đa file upload (5MB).
 */
export const MAX_UPLOAD_SIZE_BYTES = 5 * 1024 * 1024;

/**
 * Kiểu dữ liệu đầu vào cho batch feedback.
 */
export type BatchInputType = 'csv' | 'json';

/**
 * Kết quả xử lý batch feedback.
 */
export interface BatchFeedbackResult {
  success: number;
  failed: number;
  errors: Array<{ rowNumber: number; reason: string }>;
  flaggedCount: number;
  isDuplicate?: boolean;
  duplicateOfBatchContentHash?: string;
  inputType?: BatchInputType;
}

/**
 * Dòng feedback sau khi đã xử lý (hash, flag).
 */
interface ProcessedFeedbackRow {
  rowNumber: number;
  data: BeneficiaryFeedbackRow;
  beneficiaryNameHash: string;
  riskScore: number;
  isFlagged: boolean;
}

/**
 * Loại bỏ tiền tố BOM UTF-8 khỏi buffer để tránh làm sai tên cột.
 * BOM (U+FEFF) ở đầu CSV có thể bị gắn vào tiêu đề cột đầu tiên,
 * khiến toàn bộ dòng không vượt qua bước kiểm tra.
 */
function stripBom(buffer: Buffer): Buffer {
  // BOM UTF-8 gồm 3 byte: 0xEF 0xBB 0xBF.
  if (buffer.length >= 3 && buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
    return buffer.subarray(3);
  }
  return buffer;
}

/**
 * Phân tích buffer CSV thành mảng object.
 * @param csvBuffer Buffer chứa nội dung CSV
 * @returns Mảng objects từ CSV
 */
export function parseCsvBuffer(csvBuffer: Buffer): unknown[] {
  try {
    const cleanBuffer = stripBom(csvBuffer);
    const records = parse(cleanBuffer.toString('utf-8'), {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relaxColumnCount: true
    });
    return records as unknown[];
  } catch (error) {
    logger.error('CSV parse error', { errorMessage: (error as Error).message });
    throw new InvalidCsvError('Invalid CSV format');
  }
}

/**
 * Validate và xử lý từng dòng feedback.
 * @param rows Mảng dòng feedback
 * @returns Kết quả phân tách valid/invalid
 */
function processFeedbackRows(rows: unknown[]): {
  processedRows: ProcessedFeedbackRow[];
  validationErrors: Array<{ rowNumber: number; reason: string }>;
} {
  const validationResult = validateBatchFeedback(rows);
  const processedRows: ProcessedFeedbackRow[] = [];
  const validationErrors: Array<{ rowNumber: number; reason: string }> = [];

  for (const invalidRow of validationResult.invalidRows) {
    const reason = invalidRow.errors
      ?.map((e) => `${e.field}: ${e.message}`)
      .join('; ') || 'Invalid data';
    validationErrors.push({ rowNumber: invalidRow.rowNumber, reason });
  }

  for (const validRow of validationResult.validRows) {
    const { data, rowNumber } = validRow;
    // Xử lý các ký tự có thể chèn công thức trong trường comment.
    const sanitizedData = sanitizeFeedbackRow(data);
    const beneficiaryNameHash = hashBeneficiaryName(sanitizedData.beneficiaryName);
    const riskScore = computeRiskScore(sanitizedData.rating, sanitizedData.comment);
    const isFlagged = shouldFlagFeedback(riskScore);

    processedRows.push({
      rowNumber,
      data: sanitizedData,
      beneficiaryNameHash,
      riskScore,
      isFlagged
    });
  }

  return { processedRows, validationErrors };
}

/**
 * Lưu batch feedback vào MongoDB sử dụng insertMany để tối ưu hiệu năng.
 * @param feedbacks Mảng feedback đã xử lý
 * @param uploadedByOrganizationId ID của NGO upload
 * @returns Số lượng đã lưu thành công
 */
async function saveBatchFeedback(
  feedbacks: ProcessedFeedbackRow[],
  uploadedByOrganizationId: string,
  batchContentHash: string
): Promise<number> {
  if (feedbacks.length === 0) {
    return 0;
  }

  const documents = feedbacks.map((row) => {
    const feedbackId = `FB-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    return {
      feedbackId,
      projectId: row.data.projectId,
      beneficiaryNameHash: row.beneficiaryNameHash,
      rating: row.data.rating,
      comment: row.data.comment,
      submittedAt: new Date(row.data.submittedAt),
      location: row.data.location,
      riskScore: row.riskScore,
      isFlagged: row.isFlagged,
      uploadedByOrganizationId,
      batchContentHash,
      source: 'batch' as const
    };
  });

  await BeneficiaryFeedbackModel.insertMany(documents, { ordered: false });
  return documents.length;
}

/**
 * Compute SHA-256 hash of batch content for idempotency deduplication.
 * @param content Buffer (CSV) or unknown[] (JSON) to hash
 * @returns Hex string of SHA-256 hash
 */
function computeBatchContentHash(content: Buffer | unknown[]): string {
  let rawContent: string;

  if (Buffer.isBuffer(content)) {
    // Loại BOM và chuyển về chuỗi để việc băm luôn nhất quán.
    rawContent = content.toString('utf-8');
  } else {
    // Sắp xếp key trước khi stringify để cùng dữ liệu luôn cho cùng một hash,
    // kể cả khi thứ tự thuộc tính trong object ban đầu khác nhau.
    rawContent = JSON.stringify(sortObjectKeys(content));
  }

  return crypto.createHash('sha256').update(rawContent).digest('hex');
}

/**
 * Recursively sort object keys for deterministic JSON serialization.
 * @param obj Object to sort
 * @returns New object with sorted keys
 */
function sortObjectKeys(obj: unknown): unknown {
  if (Array.isArray(obj)) {
    return obj.map(sortObjectKeys);
  }

  if (obj !== null && typeof obj === 'object') {
    const sortedEntries = Object.entries(obj)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, sortObjectKeys(v)]);

    return Object.fromEntries(sortedEntries);
  }

  return obj;
}

/**
 * Xử lý batch feedback từ CSV buffer.
 * @param csvBuffer Buffer chứa nội dung CSV
 * @param uploadedByOrganizationId ID của NGO upload
 * @returns Kết quả xử lý batch
 */
export async function processCsvBatchFeedback(
  csvBuffer: Buffer,
  uploadedByOrganizationId: string
): Promise<BatchFeedbackResult> {
  const csvSize = csvBuffer.length;
  if (csvSize > MAX_UPLOAD_SIZE_BYTES) {
    throw new FileTooLargeError('File size exceeds 5MB limit');
  }

  const rows = parseCsvBuffer(csvBuffer);
  if (rows.length > MAX_BATCH_SIZE) {
    throw new BatchSizeExceededError('Batch size exceeds 1000 limit');
  }

  const batchContentHash = computeBatchContentHash(csvBuffer);
  return processBatch(rows, uploadedByOrganizationId, batchContentHash, 'csv');
}

/**
 * Xử lý batch feedback từ JSON array.
 * @param jsonPayload Mảng feedback JSON
 * @param uploadedByOrganizationId ID của NGO upload
 * @returns Kết quả xử lý batch
 */
export async function processJsonBatchFeedback(
  jsonPayload: unknown,
  uploadedByOrganizationId: string
): Promise<BatchFeedbackResult> {
  if (!Array.isArray(jsonPayload)) {
    throw new PayloadMustBeArrayError('Payload must be a JSON array');
  }

  if (jsonPayload.length > MAX_BATCH_SIZE) {
    throw new BatchSizeExceededError('Batch size exceeds 1000 limit');
  }

  const batchContentHash = computeBatchContentHash(jsonPayload);
  return processBatch(jsonPayload, uploadedByOrganizationId, batchContentHash, 'json');
}

/**
 * Xử lý batch feedback chung.
 * @param rows Mảng dòng feedback
 * @param uploadedByOrganizationId ID của NGO upload
 * @param batchContentHash Hash nội dung batch cho idempotency
 * @param inputType Loại dữ liệu đầu vào (CSV hoặc JSON)
 * @returns Kết quả xử lý batch
 */
async function processBatch(
  rows: unknown[],
  uploadedByOrganizationId: string,
  batchContentHash: string,
  inputType: BatchInputType = 'json'
): Promise<BatchFeedbackResult> {
  // Kiểm tra duplicate: nếu batch với cùng hash đã được upload bởi cùng org
  const existingBatch = await BeneficiaryFeedbackModel.findOne({
    uploadedByOrganizationId,
    batchContentHash
  }).select('feedbackId').lean();

  if (existingBatch) {
    logger.warn('Duplicate batch upload detected', {
      organizationId: uploadedByOrganizationId,
      batchContentHash
    });
    return {
      success: 0,
      failed: 0,
      errors: [],
      flaggedCount: 0,
      isDuplicate: true,
      duplicateOfBatchContentHash: batchContentHash,
      inputType
    };
  }

  const { processedRows, validationErrors } = processFeedbackRows(rows);

  let savedCount = 0;
  let flaggedCount = 0;

  if (processedRows.length > 0) {
    savedCount = await saveBatchFeedback(processedRows, uploadedByOrganizationId, batchContentHash);
    flaggedCount = processedRows.filter((r) => r.isFlagged).length;

    logger.info('Batch feedback processed', {
      totalItems: rows.length,
      successCount: savedCount,
      failedCount: validationErrors.length,
      flaggedCount,
      riskScore: RISK_SCORE_AUTO_FLAG_THRESHOLD
    });
  }

  return {
    success: savedCount,
    failed: validationErrors.length,
    errors: validationErrors,
    flaggedCount,
    inputType
  };
}
