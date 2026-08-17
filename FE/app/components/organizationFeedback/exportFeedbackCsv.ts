import type { OrganizationFeedbackItem } from './types';

const UTF8_BOM = '\uFEFF';
const FORMULA_TRIGGER_PATTERN = /^[=+\-@\t\r]/;
const CSV_HEADERS = [
  'Mã phản hồi',
  'Mã dự án',
  'Tên dự án',
  'Điểm đánh giá',
  'Nội dung',
  'Thời điểm gửi',
  'Địa điểm',
  'Nguồn',
  'Trạng thái'
] as const;

/** Vô hiệu hóa formula injection cho dữ liệu feedback trước khi ghi vào CSV. */
function neutralizeFormulaInjection(value: string): string {
  return FORMULA_TRIGGER_PATTERN.test(value) ? `'${value}` : value;
}

/** Escape một ô CSV theo RFC 4180 và giữ nguyên nội dung comment nhiều dòng. */
function escapeCsvCell(value: string): string {
  const safeValue = neutralizeFormulaInjection(value);
  const escapedValue = safeValue.replace(/"/g, '""');
  return /[",\r\n]/.test(safeValue) ? `"${escapedValue}"` : escapedValue;
}

/** Dựng một dòng CSV chỉ từ các field public trong DTO organization feedback. */
function buildFeedbackCsvRow(item: OrganizationFeedbackItem): string {
  const cells = [
    item.feedbackId,
    item.projectId,
    item.projectName ?? '',
    String(item.rating),
    item.comment,
    toIsoString(item.submittedAt),
    item.location ?? '',
    item.source === 'batch' ? 'Batch' : 'Public',
    item.isFlagged ? 'Đang chờ duyệt' : 'Đang hiển thị'
  ];
  return cells.map(escapeCsvCell).join(',');
}

/** Chuẩn hóa timestamp hiển thị trong CSV về ISO 8601, không dùng timezone giao diện. */
function toIsoString(value: string): string {
  const parsedDate = new Date(value);
  return Number.isNaN(parsedDate.getTime()) ? value : parsedDate.toISOString();
}

/** Dựng nội dung CSV báo cáo feedback, tách khỏi thao tác tải file để dễ unit test. */
export function buildFeedbackCsvContent(items: OrganizationFeedbackItem[]): string {
  const header = CSV_HEADERS.map(escapeCsvCell).join(',');
  return `${UTF8_BOM}${[header, ...items.map(buildFeedbackCsvRow)].join('\r\n')}`;
}

/** Tải báo cáo feedback ở phía client; no-op khi danh sách rỗng để tránh file CSV vô nghĩa. */
export function downloadFeedbackCsv(
  items: OrganizationFeedbackItem[],
  fileName = `organization-feedback-${Date.now()}.csv`
): void {
  if (typeof document === 'undefined' || items.length === 0) {
    return;
  }

  const blob = new Blob([buildFeedbackCsvContent(items)], { type: 'text/csv;charset=utf-8;' });
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(objectUrl);
}
