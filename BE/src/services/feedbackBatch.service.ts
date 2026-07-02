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
  type BeneficiaryFeedbackRow,
  type FeedbackValidationResult
} from '../validators/feedbackBatchValidator';
import {
  computeRiskScore,
  shouldFlagFeedback,
  RISK_SCORE_AUTO_FLAG_THRESHOLD
} from './feedbackSpamDetection.service';

const logger = getLogger();

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
 * Hash tên beneficiary bằng SHA-256 để bảo vệ PII.
 * @param beneficiaryName Tên beneficiary thô
 * @returns Hash SHA-256 dạng hex
 */
export function hashBeneficiaryName(beneficiaryName: string): string {
  return crypto.createHash('sha256').update(beneficiaryName).digest('hex');
}

/**
 * Strip UTF-8 BOM prefix from buffer to prevent column name corruption.
 * BOM (U+FEFF) at the start of a CSV can cause the first column header
 * to include the invisible BOM character, breaking validation for all rows.
 */
function stripBom(buffer: Buffer): Buffer {
  // UTF-8 BOM is 3 bytes: 0xEF 0xBB 0xBF
  if (buffer.length >= 3 && buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
    return buffer.subarray(3);
  }
  return buffer;
}

/**
 * Parse CSV buffer thành mảng objects.
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
    throw new Error('Invalid CSV format');
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
    const beneficiaryNameHash = hashBeneficiaryName(data.beneficiaryName);
    const riskScore = computeRiskScore(data.rating, data.comment);
    const isFlagged = shouldFlagFeedback(riskScore);

    processedRows.push({
      rowNumber,
      data,
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
      batchContentHash
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
  const rawContent = Buffer.isBuffer(content)
    ? content.toString('utf-8')
    : JSON.stringify(content);
  return crypto.createHash('sha256').update(rawContent).digest('hex');
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
    throw new Error('File size exceeds 5MB limit');
  }

  const rows = parseCsvBuffer(csvBuffer);
  if (rows.length > MAX_BATCH_SIZE) {
    throw new Error('Batch size exceeds 1000 limit');
  }

  const batchContentHash = computeBatchContentHash(csvBuffer);
  return processBatch(rows, uploadedByOrganizationId, batchContentHash);
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
    throw new Error('Payload must be a JSON array');
  }

  if (jsonPayload.length > MAX_BATCH_SIZE) {
    throw new Error('Batch size exceeds 1000 limit');
  }

  const batchContentHash = computeBatchContentHash(jsonPayload);
  return processBatch(jsonPayload, uploadedByOrganizationId, batchContentHash);
}

/**
 * Xử lý batch feedback chung.
 * @param rows Mảng dòng feedback
 * @param uploadedByOrganizationId ID của NGO upload
 * @param batchContentHash Hash nội dung batch cho idempotency
 * @returns Kết quả xử lý batch
 */
async function processBatch(
  rows: unknown[],
  uploadedByOrganizationId: string,
  batchContentHash: string
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
      duplicateOfBatchContentHash: batchContentHash
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
    flaggedCount
  };
}
