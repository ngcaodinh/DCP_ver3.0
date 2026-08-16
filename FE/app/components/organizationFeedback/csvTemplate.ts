import { FEEDBACK_CSV_HEADERS } from './parseCsvPreview';

const UTF8_BOM = '\uFEFF';

/** Escape một ô CSV mẫu theo RFC 4180 để file tải xuống mở ổn định trong Excel. */
function escapeTemplateCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Sinh nội dung CSV mẫu với timestamp ISO đầy đủ để NGO có thể upload lại ngay. */
export function buildFeedbackCsvTemplateContent(): string {
  const header = FEEDBACK_CSV_HEADERS.map(escapeTemplateCell).join(',');
  const example = [
    'DA-2026-001',
    'Nguyen Van A',
    '5',
    'Gia đình đã được hỗ trợ sửa mái nhà.',
    '2026-08-01T00:00:00Z',
    'Quảng Bình'
  ].map(escapeTemplateCell).join(',');
  return `${UTF8_BOM}${header}\r\n${example}`;
}

/** Tải file CSV mẫu xuống phía client mà không cần thêm dependency. */
export function downloadFeedbackCsvTemplate(fileName = 'feedback-template.csv'): void {
  if (typeof document === 'undefined') {
    return;
  }

  const blob = new Blob([buildFeedbackCsvTemplateContent()], { type: 'text/csv;charset=utf-8;' });
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(objectUrl);
}
