import type { CsvPreviewResult, CsvPreviewRow } from './types';

export const FEEDBACK_CSV_HEADERS = [
  'projectId',
  'beneficiaryName',
  'rating',
  'comment',
  'submittedAt',
  'location'
] as const;

const REQUIRED_HEADERS = FEEDBACK_CSV_HEADERS.slice(0, 5);

interface ParsedCsvRecord {
  cells: string[];
}

/** Phân tích CSV theo RFC 4180, hỗ trợ dấu phẩy, nháy kép lồng và xuống dòng trong ô. */
function parseCsvRecords(csvText: string): { records: ParsedCsvRecord[]; error: string | null } {
  const text = csvText.startsWith('\uFEFF') ? csvText.slice(1) : csvText;
  const records: ParsedCsvRecord[] = [];
  const cells: string[] = [];
  let currentCell = '';
  let insideQuotes = false;

  const pushCell = (): void => {
    cells.push(currentCell.trim());
    currentCell = '';
  };
  const pushRecord = (): void => {
    pushCell();
    if (cells.some(cell => cell.length > 0)) {
      records.push({ cells: cells.splice(0, cells.length) });
    } else {
      cells.length = 0;
    }
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (insideQuotes) {
      if (character === '"' && text[index + 1] === '"') {
        currentCell += '"';
        index += 1;
      } else if (character === '"') {
        insideQuotes = false;
      } else {
        currentCell += character;
      }
      continue;
    }

    if (character === '"' && currentCell.trim().length === 0) {
      insideQuotes = true;
    } else if (character === ',') {
      pushCell();
    } else if (character === '\n') {
      pushRecord();
    } else if (character === '\r') {
      if (text[index + 1] === '\n') {
        index += 1;
      }
      pushRecord();
    } else {
      currentCell += character;
    }
  }

  if (insideQuotes) {
    return { records: [], error: 'CSV có dấu nháy kép chưa được đóng.' };
  }
  if (currentCell.length > 0 || cells.length > 0) {
    pushRecord();
  }
  return { records, error: null };
}

/** Kiểm tra một dòng CSV theo cùng các ràng buộc dữ liệu cốt lõi của backend. */
function validateCsvRow(cells: string[], headers: string[], rowNumber: number): CsvPreviewRow {
  const values: Record<string, string> = {};
  const fieldErrors: Record<string, string[]> = {};
  const rowErrors: string[] = [];
  const rowWarnings: string[] = [];

  headers.forEach((header, index) => {
    values[header] = cells[index] ?? '';
  });

  const requiredHeaderCount = headers.filter(header => REQUIRED_HEADERS.includes(header as typeof REQUIRED_HEADERS[number])).length;
  if (cells.length < requiredHeaderCount) {
    rowErrors.push(`Dòng thiếu ${requiredHeaderCount - cells.length} cột bắt buộc.`);
  }
  if (cells.length > headers.length) {
    rowWarnings.push(`Dòng thừa ${cells.length - headers.length} cột; các cột này sẽ được bỏ qua khi tải lên.`);
  }

  const addFieldError = (field: string, message: string): void => {
    fieldErrors[field] = [...(fieldErrors[field] ?? []), message];
  };

  REQUIRED_HEADERS.forEach(field => {
    if (!values[field]?.trim()) {
      addFieldError(field, `${field} là bắt buộc.`);
    }
  });

  const rating = values.rating?.trim() ?? '';
  if (rating && !/^-?\d+$/.test(rating)) {
    addFieldError('rating', 'rating phải là số nguyên.');
  } else if (rating && (Number(rating) < 1 || Number(rating) > 5)) {
    addFieldError('rating', 'Rating phải từ 1 đến 5.');
  }

  const comment = values.comment?.trim() ?? '';
  if (comment.length > 5000) {
    addFieldError('comment', 'comment vượt quá giới hạn 5000 ký tự.');
  }

  const submittedAt = values.submittedAt?.trim() ?? '';
  const isIsoDateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(submittedAt)
    && !Number.isNaN(Date.parse(submittedAt));
  if (submittedAt && !isIsoDateTime) {
    addFieldError('submittedAt', 'Dùng ISO 8601 đầy đủ, ví dụ 2026-08-01T00:00:00Z.');
  }

  return { rowNumber, values, fieldErrors, rowErrors, rowWarnings };
}

/** Parse và validate toàn bộ CSV để hiển thị preview trước khi gửi lên server. */
export function parseCsvPreview(csvText: string): CsvPreviewResult {
  const parsed = parseCsvRecords(csvText);
  if (parsed.error) {
    return { headers: [], rows: [], totalRows: 0, fileErrors: [parsed.error] };
  }

  const headerRecord = parsed.records[0];
  if (!headerRecord) {
    return { headers: [], rows: [], totalRows: 0, fileErrors: ['File CSV không có dòng tiêu đề.'] };
  }

  const headers = headerRecord.cells;
  const fileErrors = REQUIRED_HEADERS
    .filter(header => !headers.includes(header))
    .map(header => `Thiếu cột bắt buộc: ${header}.`);
  const duplicateHeaders = [...new Set(headers.filter((header, index) => headers.indexOf(header) !== index))];
  if (duplicateHeaders.length > 0) {
    fileErrors.push(`Cột bị lặp: ${duplicateHeaders.join(', ')}.`);
  }
  if (headers.some(header => !header)) {
    fileErrors.push('Tên cột không được để trống.');
  }
  const dataRecords = parsed.records.slice(1);
  const rows = dataRecords.map((record, index) => validateCsvRow(record.cells, headers, index + 1));
  if (rows.length === 0) {
    fileErrors.push('File CSV không có dòng dữ liệu.');
  }

  return { headers, rows, totalRows: rows.length, fileErrors };
}

/** Xác định nhanh preview có lỗi để modal khóa nút upload và tránh request chắc chắn thất bại. */
export function hasCsvPreviewErrors(preview: CsvPreviewResult): boolean {
  return preview.fileErrors.length > 0 || preview.rows.some(row => (
    row.rowErrors.length > 0 || Object.values(row.fieldErrors).some(errors => errors.length > 0)
  ));
}
