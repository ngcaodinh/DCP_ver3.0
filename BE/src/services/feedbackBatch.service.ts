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
  analyzeFeedbackWithLocation,
  RISK_SCORE_AUTO_FLAG_THRESHOLD
} from './feedbackSpamDetection.service';
import {
  BatchSizeExceededError,
  FileTooLargeError,
  InvalidCsvError,
  PayloadMustBeArrayError
} from '../utils/feedbackBatchError';
import { findGeofenceByProjectId } from '../models/projectGeofenceModel';

const logger = getLogger();

/**
 * Các ký tự đầu dòng nguy hiểm trong CSV có thể kích hoạt formula injection.
 * Bao gồm: =, +, -, @, \t, \r, \n
 */
const FORMULA_PREFIX_CHARS = ['=', '+', '-', '@', '\t', '\r', '\n'];

/**
 * Kiểm tra xem string có chứa prefix nguy hiểm cho CSV formula injection không.
 * Trim leading whitespace trước khi check vì Excel vẫn nhận diện formula
 * ngay cả khi có spaces ở đầu dòng (VD: "   =HYPERLINK(...)" vẫn nguy hiểm).
 * @param value String cần kiểm tra
 * @returns true nếu có prefix nguy hiểm
 */
function hasFormulaPrefix(value: string): boolean {
  if (!value || value.length === 0) {
    return false;
  }
  const trimmed = value.trimStart();
  if (trimmed.length === 0) {
    return false;
  }
  const firstChar = trimmed.charAt(0);
  return FORMULA_PREFIX_CHARS.includes(firstChar);
}

/**
 * Ngăn chặn CSV formula injection bằng cách escape các prefix nguy hiểm.
 * Thêm space prefix cho các giá trị bắt đầu bằng =, +, -, @ hoặc whitespace.
 * @param value String cần escape
 * @returns String đã được escape an toàn cho CSV
 */
function escapeFormulaInjection(value: string): string {
  if (hasFormulaPrefix(value)) {
    return ` ${value}`;
  }
  return value;
}

/**
 * Escape tất cả các formula prefixes trong một feedback row.
 * Chỉ các field free-text (comment) có nguy cơ formula injection.
 * Các field khác (projectId, beneficiaryName, rating, submittedAt) đã được
 * validate bởi Zod schema với format nghiêm ngặt nên không cần escape.
 * @param row Dòng feedback cần escape
 * @returns Dòng feedback đã được escape
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
    throw new InvalidCsvError('Invalid CSV format');
  }
}

/**
 * Fetch geofence context cho một danh sách projectId song song.
 * Trả về Map để tra cứu O(1) trong loop xử lý feedback.
 * Nếu geofence không tồn tại cho projectId nào → entry không có trong Map (lookup trả về undefined).
 * 
 * @param projectIds Danh sách projectId unique cần fetch geofence
 * @returns Map<projectId, GeofenceContext>
 */
async function fetchGeofenceContexts(
  projectIds: string[]
): Promise<Map<string, { centroid: { lat: number; lng: number }; radiusMeters: number }>> {
  if (projectIds.length === 0) {
    return new Map();
  }

  // Promise.all thay vì sequential — tránh N round-trip latency
  const geofences = await Promise.all(
    projectIds.map((projectId) => findGeofenceByProjectId(projectId))
  );

  const geofenceByProjectId = new Map<
    string,
    { centroid: { lat: number; lng: number }; radiusMeters: number }
  >();
  for (let i = 0; i < projectIds.length; i++) {
    const geofence = geofences[i];
    if (geofence) {
      geofenceByProjectId.set(projectIds[i], {
        centroid: geofence.centroid,
        radiusMeters: geofence.radiusMeters
      });
    }
  }

  return geofenceByProjectId;
}

/**
 * Validate và xử lý từng dòng feedback.
 * @param rows Mảng dòng feedback
 * @param geofenceByProjectId Map geofence context theo projectId (đã pre-fetch) để tránh N+1 query.
 * @returns Kết quả phân tách valid/invalid
 */
function processFeedbackRows(
  rows: unknown[],
  geofenceByProjectId: Map<string, { centroid: { lat: number; lng: number }; radiusMeters: number }>
): {
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
    // Escape formula injection characters trong comment field
    const sanitizedData = sanitizeFeedbackRow(data);
    const beneficiaryNameHash = hashBeneficiaryName(sanitizedData.beneficiaryName);

    // F2.1: location mismatch check — lấy geofence từ cache đã pre-fetch.
    // Nếu projectId chưa có geofence → cache miss → coi như không có geofence (location check bị skip).
    const geofence = geofenceByProjectId.get(sanitizedData.projectId) ?? null;
    const analysis = analyzeFeedbackWithLocation(
      sanitizedData.rating,
      sanitizedData.comment,
      sanitizedData.location,
      geofence
    );

    const riskScore = analysis.riskScore;
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
  let rawContent: string;

  if (Buffer.isBuffer(content)) {
    // Strip BOM and convert to string for consistent hashing
    rawContent = content.toString('utf-8');
  } else {
    // JSON stringify with sorted keys ensures deterministic output
    // regardless of key order in the original object
    // This prevents hash bypass when objects have same values but different key order
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

  // F2.1: pre-fetch geofence context cho tất cả projectId unique trong batch.
  // Tránh N+1 query khi mỗi row cần kiểm tra location mismatch với project geofence.
  // ProjectIds không tồn tại trong cache sẽ được coi là không có geofence (location check bị skip).
  const uniqueProjectIds = Array.from(new Set(
    rows
      .filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null)
      .map((row) => typeof row.projectId === 'string' ? row.projectId : null)
      .filter((id): id is string => id !== null)
  ));
  const geofenceByProjectId = await fetchGeofenceContexts(uniqueProjectIds);

  const { processedRows, validationErrors } = processFeedbackRows(rows, geofenceByProjectId);

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
