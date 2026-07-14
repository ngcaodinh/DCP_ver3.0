/**
 * Tests cho exportCsv — D4.
 * Tập trung vào buildTimelineCsvContent: BOM UTF-8, escape ký tự đặc biệt,
 * bọc walletAddress/chainTxHash dạng chuỗi Excel để không bị đổi số mũ,
 * chống formula injection; và downloadTimelineCsv (no-op khi rỗng, kích hoạt tải).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildTimelineCsvContent, downloadTimelineCsv } from '@/app/components/transparency/exportCsv';
import type { TimelineEvent } from '@/app/components/transparency/types';

/** Hàm tạo sự kiện timeline mẫu. Mục đích: dựng dữ liệu test gọn, chỉ override trường cần. */
function makeEvent(overrides: Partial<TimelineEvent> = {}): TimelineEvent {
  return {
    eventId: 'evt-1',
    correlationId: 'donation:0xabc',
    eventType: 'DONATION',
    timestamp: '2024-06-15T10:30:00.000Z',
    amountVnd: 50000,
    chainStatus: 'CONFIRMED',
    chainTxHash: '0xabc123',
    chainBlockNumber: 100,
    payosStatus: null,
    payosOrderCode: null,
    walletAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0E8eD',
    projectId: 'project-001',
    source: 'blockchain',
    ...overrides
  };
}

describe('buildTimelineCsvContent', () => {
  it('bắt đầu bằng BOM UTF-8 để Excel đọc đúng tiếng Việt', () => {
    const csv = buildTimelineCsvContent([]);
    expect(csv.startsWith('\uFEFF')).toBe(true);
  });

  it('luôn có dòng header dù danh sách rỗng', () => {
    const csv = buildTimelineCsvContent([]);
    const withoutBom = csv.replace('\uFEFF', '');
    expect(withoutBom).toContain('Loại sự kiện');
    expect(withoutBom).toContain('Địa chỉ ví');
    expect(withoutBom.split('\r\n')).toHaveLength(1);
  });

  it('bọc walletAddress và chainTxHash dạng ="..." để Excel giữ nguyên chuỗi', () => {
    const csv = buildTimelineCsvContent([makeEvent()]);
    expect(csv).toContain('"=""0x742d35Cc6634C0532925a3b844Bc9e7595f0E8eD"""');
    expect(csv).toContain('"=""0xabc123"""');
  });

  it('escape dấu phẩy và nháy kép trong nội dung theo RFC 4180', () => {
    const csv = buildTimelineCsvContent([
      makeEvent({ payosStatus: 'chờ, xử lý "gấp"' })
    ]);
    // Dấu phẩy khiến ô phải bọc nháy kép, nháy kép bên trong bị nhân đôi.
    expect(csv).toContain('"chờ, xử lý ""gấp"""');
  });

  it('xuất ô rỗng cho chainTxHash null và chainBlockNumber null', () => {
    const csv = buildTimelineCsvContent([
      makeEvent({ chainTxHash: null, chainBlockNumber: null })
    ]);
    const dataLine = csv.replace('\uFEFF', '').split('\r\n')[1];
    // chainTxHash null → wrapIdentifierForExcel trả rỗng (không có ="...")
    expect(dataLine).not.toContain('="""');
  });

  it('[security] trung hòa formula injection: ô bắt đầu bằng = được prepend nháy đơn', () => {
    // Payload DDE giả lập đến từ nguồn ngoài (PayOS) qua payosStatus.
    const csv = buildTimelineCsvContent([
      makeEvent({ payosStatus: "=cmd|'/c calc'!A1" })
    ]);
    // Ô phải bắt đầu bằng nháy đơn ('') để trình bảng tính coi là văn bản thuần.
    expect(csv).toContain("'=cmd|'/c calc'!A1");
    // Không được xuất hiện ô mở đầu bằng "=" trần (không có nháy đơn phía trước).
    expect(csv).not.toContain(',=cmd');
  });

  it('[security] trung hòa các ký tự trigger +, -, @ ở đầu ô', () => {
    const csvPlus = buildTimelineCsvContent([makeEvent({ payosOrderCode: '+1+2' })]);
    expect(csvPlus).toContain("'+1+2");

    const csvMinus = buildTimelineCsvContent([makeEvent({ payosOrderCode: '-1+2' })]);
    expect(csvMinus).toContain("'-1+2");

    const csvAt = buildTimelineCsvContent([makeEvent({ payosOrderCode: '@SUM(A1)' })]);
    expect(csvAt).toContain("'@SUM(A1)");
  });

  it('[security] không đụng tới ô bắt đầu bằng ký tự thường (không false-positive)', () => {
    const csv = buildTimelineCsvContent([makeEvent({ payosStatus: 'PAYMENT_CONFIRMED' })]);
    expect(csv).toContain('PAYMENT_CONFIRMED');
    expect(csv).not.toContain("'PAYMENT_CONFIRMED");
  });

  it('nhiều sự kiện → mỗi sự kiện là một dòng, phân tách bằng CRLF', () => {
    const csv = buildTimelineCsvContent([
      makeEvent({ eventId: 'e1', payosStatus: 'A' }),
      makeEvent({ eventId: 'e2', payosStatus: 'B' }),
      makeEvent({ eventId: 'e3', payosStatus: 'C' })
    ]);
    const lines = csv.replace('\uFEFF', '').split('\r\n');
    // 1 header + 3 dòng dữ liệu.
    expect(lines).toHaveLength(4);
  });

  it('escape ô chứa ký tự xuống dòng bằng cách bọc nháy kép', () => {
    const csv = buildTimelineCsvContent([makeEvent({ payosStatus: 'dòng1\ndòng2' })]);
    // Ô chứa \n phải được bọc nháy kép để không phá vỡ cấu trúc dòng CSV.
    expect(csv).toContain('"dòng1\ndòng2"');
  });

  it('[security] trung hòa ký tự tab và carriage return ở đầu ô', () => {
    const csvTab = buildTimelineCsvContent([makeEvent({ payosStatus: '\tSUM' })]);
    // Ô bắt đầu bằng tab → prepend nháy đơn, đồng thời chứa tab không cần bọc nháy kép.
    expect(csvTab).toContain("'\tSUM");

    const csvCr = buildTimelineCsvContent([makeEvent({ payosOrderCode: '\rORDER' })]);
    expect(csvCr).toContain("'\rORDER");
  });

  it('số tiền và số khối được xuất dạng số (không bọc công thức Excel)', () => {
    const csv = buildTimelineCsvContent([makeEvent({ amountVnd: 50000, chainBlockNumber: 100 })]);
    const dataLine = csv.replace('\uFEFF', '').split('\r\n')[1];
    expect(dataLine).toContain('50000');
    expect(dataLine).toContain('100');
  });
});

describe('downloadTimelineCsv', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('no-op khi danh sách sự kiện rỗng (không tạo object URL)', () => {
    const createObjectUrl = vi.fn();
    URL.createObjectURL = createObjectUrl;

    downloadTimelineCsv([]);

    expect(createObjectUrl).not.toHaveBeenCalled();
  });

  it('có sự kiện → tạo Blob, gắn anchor với đúng tên file rồi dọn dẹp', () => {
    const createObjectUrl = vi.fn(() => 'blob:mock-url');
    const revokeObjectUrl = vi.fn();
    URL.createObjectURL = createObjectUrl;
    URL.revokeObjectURL = revokeObjectUrl;

    const clickSpy = vi.fn();
    const originalCreateElement = document.createElement.bind(document);
    // Ghi đè createElement chỉ cho thẻ 'a' để bắt sự kiện click, giữ nguyên các thẻ khác.
    const createElementSpy = vi
      .spyOn(document, 'createElement')
      .mockImplementation((tagName: string) => {
        const element = originalCreateElement(tagName) as HTMLElement;
        if (tagName === 'a') {
          element.click = clickSpy;
        }
        return element;
      });

    downloadTimelineCsv([makeEvent()], 'bao-cao.csv');

    expect(createObjectUrl).toHaveBeenCalledTimes(1);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    // Object URL phải được revoke để tránh rò rỉ bộ nhớ.
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:mock-url');

    createElementSpy.mockRestore();
  });
});
