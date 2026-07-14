// =============================================================================
// exportCsv — D4: Helper tự viết để xuất dòng tiền timeline ra file CSV.
// KHÔNG dùng thư viện ngoài (0 dependency mới). Bảo đảm Excel đọc đúng:
// - Prepend BOM \uFEFF để Excel nhận UTF-8 (tiếng Việt không lỗi font).
// - Escape dấu phẩy, dấu nháy kép, xuống dòng theo chuẩn RFC 4180.
// - Bọc walletAddress/chainTxHash dạng chuỗi để Excel không đổi sang số mũ.
// =============================================================================

import type { TimelineEvent } from './types';

/** Ký tự BOM giúp Excel nhận diện file là UTF-8. */
const UTF8_BOM = '\uFEFF';

/**
 * Các ký tự mở đầu ô có thể bị Excel/Sheets diễn giải thành công thức (CSV/Formula Injection).
 * Ô bắt đầu bằng một trong các ký tự này có thể thực thi payload dạng =cmd|'/c calc'!A1 qua DDE.
 */
const FORMULA_TRIGGER_PATTERN = /^[=+\-@\t\r]/;

/**
 * Vô hiệu hóa CSV/Formula Injection cho một ô văn bản.
 * Nếu ô bắt đầu bằng ký tự công thức, prepend dấu nháy đơn để ép trình bảng tính
 * coi nội dung là văn bản thuần thay vì công thức thực thi.
 *
 * @param rawValue Giá trị ô gốc (có thể đến từ nguồn ngoài như PayOS)
 * @returns Chuỗi đã trung hòa an toàn để đưa vào CSV
 */
function neutralizeFormulaInjection(rawValue: string): string {
  if (FORMULA_TRIGGER_PATTERN.test(rawValue)) {
    return `'${rawValue}`;
  }
  return rawValue;
}

/** Nhãn cột CSV (tiếng Việt) theo đúng thứ tự xuất. */
const CSV_HEADERS = [
  'Loại sự kiện',
  'Mã tương quan',
  'Thời gian',
  'Số tiền (VND)',
  'Trạng thái chuỗi',
  'Mã giao dịch chuỗi',
  'Số khối',
  'Trạng thái PayOS',
  'Mã đơn PayOS',
  'Địa chỉ ví',
  'Mã dự án',
  'Nguồn'
] as const;

/**
 * Escape một ô dữ liệu theo chuẩn CSV RFC 4180.
 * Bọc trong dấu nháy kép nếu chứa dấu phẩy, nháy kép hoặc xuống dòng;
 * đồng thời nhân đôi mọi dấu nháy kép bên trong.
 *
 * @param rawValue Giá trị ô ở dạng chuỗi
 * @returns Chuỗi đã escape an toàn để ghép vào dòng CSV
 */
function escapeCsvCell(rawValue: string): string {
  // Trung hòa formula injection TRƯỚC khi escape trích dẫn (dữ liệu có thể đến từ PayOS/nguồn ngoài).
  const safeValue = neutralizeFormulaInjection(rawValue);
  const needsQuoting = /[",\r\n]/.test(safeValue);
  const escapedValue = safeValue.replace(/"/g, '""');
  return needsQuoting ? `"${escapedValue}"` : escapedValue;
}

/**
 * Bọc giá trị định danh dài (địa chỉ ví, tx hash) thành chuỗi Excel-an-toàn.
 * Dùng công thức `="..."` để Excel giữ nguyên chuỗi, tránh chuyển sang số mũ
 * hoặc cắt số 0 ở đầu. Bản thân công thức luôn được bọc nháy kép.
 *
 * @param identifierValue Chuỗi định danh gốc (có thể rỗng)
 * @returns Ô CSV dạng ="<value>" đã escape, hoặc rỗng nếu không có giá trị
 */
function wrapIdentifierForExcel(identifierValue: string): string {
  if (!identifierValue) {
    return '';
  }
  // Nhân đôi nháy kép bên trong rồi bọc công thức ="..." trong cặp nháy kép ngoài.
  const escapedInner = identifierValue.replace(/"/g, '""');
  return `"=""${escapedInner}"""`;
}

/**
 * Chuyển một sự kiện timeline thành một dòng CSV (mảng ô đã escape).
 *
 * @param event Sự kiện dòng tiền cần xuất
 * @returns Chuỗi một dòng CSV
 */
function buildCsvRow(event: TimelineEvent): string {
  const cells: string[] = [
    escapeCsvCell(event.eventType),
    escapeCsvCell(event.correlationId),
    escapeCsvCell(event.timestamp),
    escapeCsvCell(String(event.amountVnd)),
    escapeCsvCell(event.chainStatus),
    // Bọc tx hash và ví dạng chuỗi Excel để không bị đổi số mũ / mất ký tự
    wrapIdentifierForExcel(event.chainTxHash ?? ''),
    escapeCsvCell(event.chainBlockNumber === null ? '' : String(event.chainBlockNumber)),
    escapeCsvCell(event.payosStatus ?? ''),
    escapeCsvCell(event.payosOrderCode ?? ''),
    wrapIdentifierForExcel(event.walletAddress),
    escapeCsvCell(event.projectId),
    escapeCsvCell(event.source)
  ];
  return cells.join(',');
}

/**
 * Dựng toàn bộ nội dung CSV (kèm BOM + header) từ danh sách sự kiện.
 * Tách riêng khỏi thao tác tải file để dễ unit test.
 *
 * @param events Danh sách sự kiện timeline
 * @returns Chuỗi CSV hoàn chỉnh, sẵn sàng ghi ra Blob
 */
export function buildTimelineCsvContent(events: TimelineEvent[]): string {
  const headerLine = CSV_HEADERS.map(escapeCsvCell).join(',');
  const rowLines = events.map(buildCsvRow);
  // RFC 4180 dùng CRLF giữa các dòng; prepend BOM cho Excel.
  return `${UTF8_BOM}${[headerLine, ...rowLines].join('\r\n')}`;
}

/**
 * Xuất danh sách sự kiện timeline ra file CSV và kích hoạt tải xuống trên trình duyệt.
 * Chỉ chạy phía client (dùng document/URL). No-op nếu không có sự kiện.
 *
 * @param events Danh sách sự kiện cần xuất
 * @param fileName Tên file tải xuống (mặc định theo mốc thời gian)
 */
export function downloadTimelineCsv(
  events: TimelineEvent[],
  fileName = `transparency-timeline-${Date.now()}.csv`
): void {
  if (typeof document === 'undefined' || events.length === 0) {
    return;
  }

  const csvContent = buildTimelineCsvContent(events);
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const objectUrl = URL.createObjectURL(blob);

  const anchorElement = document.createElement('a');
  anchorElement.href = objectUrl;
  anchorElement.download = fileName;
  document.body.appendChild(anchorElement);
  anchorElement.click();

  // Dọn dẹp DOM và giải phóng object URL để tránh rò rỉ bộ nhớ.
  document.body.removeChild(anchorElement);
  URL.revokeObjectURL(objectUrl);
}
