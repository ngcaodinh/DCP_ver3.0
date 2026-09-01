import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { existsSync } from 'node:fs';
import { getDonationCertificateConfig } from '../config/donationCertificateConfig';
import type { DonationCertificateRecord } from '../models/donationCertificateModel';

const PAGE_MARGIN = 42;
const TEAL_PRIMARY = '#0F766E';
const TEAL_DARK = '#042F2E';
const GOLD_PRIMARY = '#D4A72C';
const GOLD_DARK = '#9A721D';
const INK_MAIN = '#0F172A';
const INK_MUTED = '#64748B';
const PAPER = '#FDFCF7';
const REVOKED = '#B91C1C';
const GOLD_LIGHT = '#FEF08A';
const RECEIPT_MARGIN = 51;
const CERTIFICATE_DISPLAY_CURRENCY = 'VNĐ';
const CERTIFICATE_PAYMENT_METHOD = 'Chuyển khoản ngân hàng';
const OPTIONAL_SERIF_BOLD_FONT_PATH = process.env.CERTIFICATE_SERIF_BOLD_FONT_PATH ?? 'C:\\Windows\\Fonts\\cambriab.ttf';
const OPTIONAL_SERIF_ITALIC_FONT_PATH = process.env.CERTIFICATE_SERIF_ITALIC_FONT_PATH ?? 'C:\\Windows\\Fonts\\cambriai.ttf';
const HAS_OPTIONAL_SERIF_FONTS = existsSync(OPTIONAL_SERIF_BOLD_FONT_PATH) && existsSync(OPTIONAL_SERIF_ITALIC_FONT_PATH);
const OPTIONAL_SCRIPT_FONT_PATH = process.env.CERTIFICATE_SCRIPT_FONT_PATH ?? 'C:\\Windows\\Fonts\\segoesc.ttf';
const HAS_OPTIONAL_SCRIPT_FONT = existsSync(OPTIONAL_SCRIPT_FONT_PATH);
// SVG frame của HTML nằm trong inset 6mm và dùng viewBox 800x1120.
// Các hệ số dưới đây chuyển đúng toạ độ viewBox sang khổ A4 PDF (595x842pt).
const FRAME_INSET_X = 17;
const FRAME_INSET_Y = 17;
const FRAME_SCALE_X = 0.701;
const FRAME_SCALE_Y = 0.721;

type CertificateFontWeight = 'regular' | 'bold' | 'italic';
type CertificateTextAlign = 'left' | 'center' | 'right';

interface CertificateTextOptions {
  width?: number;
  align?: CertificateTextAlign;
  lineGap?: number;
  lineBreak?: boolean;
}

interface CertificateSerifTextOptions extends CertificateTextOptions {
  fallbackWeight?: CertificateFontWeight;
}

interface CertificateTextSegment {
  value: string;
  color: string;
  fontSize: number;
  weight: CertificateFontWeight;
}

const VIETNAMESE_CODE_POINT_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0102, 0x0103], [0x0110, 0x0111], [0x0128, 0x0129], [0x0168, 0x0169],
  [0x01a0, 0x01b1], [0x0300, 0x0329], [0x1ea0, 0x1ef9]
];

/** Trả lỗi typed để controller phân biệt certificate chưa được phát hành. */
export class DonationCertificatePdfError extends Error {
  constructor(code: 'CERTIFICATE_NOT_ISSUED') {
    super(code);
    this.name = 'DonationCertificatePdfError';
  }
}

/** Kết thúc document và gom các chunks PDF thành một Buffer. */
function collectPdfBuffer(document: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    document.on('data', (chunk: Buffer) => chunks.push(chunk));
    document.on('end', () => resolve(Buffer.concat(chunks)));
    document.on('error', reject);
  });
}

/** Kiểm tra code point có thuộc nhóm ký tự tiếng Việt cần font subset riêng hay không. */
function isVietnameseCodePoint(codePoint: number): boolean {
  return VIETNAMESE_CODE_POINT_RANGES.some(([start, end]) => codePoint >= start && codePoint <= end);
}

/** Chọn font subset có glyph tương ứng, vì Fontsource phân tách latin và vietnamese thành các file riêng. */
function resolveCertificateFont(weight: CertificateFontWeight, character: string): string {
  const codePoint = character.codePointAt(0) ?? 0;
  const weightSuffix = weight === 'bold' ? 'Bold' : weight === 'italic' ? 'Italic' : '';
  if (isVietnameseCodePoint(codePoint)) return `BeVietnamVietnamese${weightSuffix}`;
  if (codePoint >= 0x2018 && codePoint <= 0x201f) return `BeVietnamLatin${weightSuffix}`;
  if (codePoint > 0x00ff) return `BeVietnamLatinExt${weightSuffix}`;
  return `BeVietnamLatin${weightSuffix}`;
}

/** Chia chuỗi thành các đoạn liên tục có thể vẽ bằng cùng một font subset. */
function splitCertificateTextByFont(text: string, weight: CertificateFontWeight): Array<{ value: string; font: string }> {
  const runs: Array<{ value: string; font: string }> = [];
  for (const character of Array.from(text.normalize('NFC'))) {
    const font = resolveCertificateFont(weight, character);
    const previous = runs[runs.length - 1];
    if (previous?.font === font) previous.value += character;
    else runs.push({ value: character, font });
  }
  return runs;
}

/** Đo chiều rộng chuỗi sau khi ghép nhiều font subset để căn giữa và tính chiều cao chính xác. */
function measureCertificateText(document: PDFKit.PDFDocument, text: string, fontSize: number, weight: CertificateFontWeight): number {
  return splitCertificateTextByFont(text, weight).reduce((total, run) => {
    document.font(run.font).fontSize(fontSize);
    return total + document.widthOfString(run.value);
  }, 0);
}

/** Tách văn bản theo khoảng trắng để mô phỏng wrapping của PDFKit với nhiều font subset. */
function wrapCertificateText(document: PDFKit.PDFDocument, text: string, width: number, fontSize: number, weight: CertificateFontWeight): string[] {
  const lines: string[] = [];
  let currentLine = '';
  for (const token of text.split(/(\s+)/)) {
    if (!token) continue;
    const candidate = currentLine + token;
    if (currentLine && measureCertificateText(document, candidate, fontSize, weight) > width) {
      lines.push(currentLine.trimEnd());
      currentLine = token.trimStart();
    } else currentLine = candidate;
  }
  if (currentLine) lines.push(currentLine.trimEnd());
  return lines.length > 0 ? lines : [''];
}

/** Tính số dòng sau wrapping để bố trí hàng receipt mà không cắt nội dung tiếng Việt. */
function countCertificateTextLines(document: PDFKit.PDFDocument, text: string, width: number, fontSize: number, weight: CertificateFontWeight): number {
  return text.split('\n').reduce((total, line) => total + wrapCertificateText(document, line, width, fontSize, weight).length, 0);
}

/** Vẽ văn bản Unicode bằng nhiều subset font nhưng vẫn giữ căn lề và line height thống nhất. */
function drawCertificateText(
  document: PDFKit.PDFDocument,
  text: string,
  x: number,
  y: number,
  fontSize: number,
  weight: CertificateFontWeight,
  options: CertificateTextOptions = {}
): number {
  const width = options.width ?? measureCertificateText(document, text, fontSize, weight);
  const align = options.align ?? 'left';
  const lineHeight = fontSize * 1.2 + (options.lineGap ?? 0);
  const lines = options.lineBreak === false ? text.split('\n') : text.split('\n').flatMap((line) => wrapCertificateText(document, line, width, fontSize, weight));
  lines.forEach((line, lineIndex) => {
    const lineWidth = measureCertificateText(document, line, fontSize, weight);
    const lineX = align === 'center' ? x + (width - lineWidth) / 2 : align === 'right' ? x + width - lineWidth : x;
    let runX = lineX;
    for (const run of splitCertificateTextByFont(line, weight)) {
      document.font(run.font).fontSize(fontSize).text(run.value, runX, y + lineIndex * lineHeight, { lineBreak: false });
      runX += document.widthOfString(run.value);
    }
  });
  return lines.length * lineHeight;
}

/** Vẽ một dòng căn giữa gồm nhiều đoạn màu và font khác nhau như các span trong HTML. */
function drawCenteredCertificateSegments(
  document: PDFKit.PDFDocument,
  segments: CertificateTextSegment[],
  y: number,
  width: number
): void {
  const totalWidth = segments.reduce((total, segment) => total + measureCertificateText(document, segment.value, segment.fontSize, segment.weight), 0);
  let x = (width - totalWidth) / 2;
  for (const segment of segments) {
    const segmentWidth = measureCertificateText(document, segment.value, segment.fontSize, segment.weight);
    document.fillColor(segment.color);
    drawCertificateText(document, segment.value, x, y, segment.fontSize, segment.weight, { width: segmentWidth, lineBreak: false });
    x += segmentWidth;
  }
}

/** Vẽ chữ serif giống Playfair Display; trên môi trường không có font hệ thống sẽ tự dùng Be Vietnam Pro. */
function drawCertificateSerifText(
  document: PDFKit.PDFDocument,
  text: string,
  x: number,
  y: number,
  fontSize: number,
  style: 'bold' | 'italic',
  options: CertificateSerifTextOptions = {}
): number {
  if (!HAS_OPTIONAL_SERIF_FONTS) {
    return drawCertificateText(document, text, x, y, fontSize, options.fallbackWeight ?? style, options);
  }
  const width = options.width ?? measureCertificateText(document, text, fontSize, options.fallbackWeight ?? style);
  const align = options.align ?? 'left';
  const fontName = `CertificateSerif${style === 'bold' ? 'Bold' : 'Italic'}`;
  document.font(fontName).fontSize(fontSize);
  document.text(text.normalize('NFC'), x, y, { width, align, lineBreak: options.lineBreak !== false, lineGap: options.lineGap ?? 0 });
  return fontSize * 1.2 + (options.lineGap ?? 0);
}

/** Vẽ chữ ký viết tay nếu runtime có font script; nếu không thì dùng italic dễ đọc. */
function drawCertificateScriptText(
  document: PDFKit.PDFDocument,
  text: string,
  x: number,
  y: number,
  fontSize: number,
  options: CertificateTextOptions = {}
): void {
  if (!HAS_OPTIONAL_SCRIPT_FONT) {
    drawCertificateSerifText(document, text, x, y, fontSize, 'italic', { ...options, fallbackWeight: 'italic' });
    return;
  }
  document.font('CertificateScript').fontSize(fontSize).text(text.normalize('NFC'), x, y, {
    width: options.width,
    align: options.align,
    lineBreak: options.lineBreak ?? false,
    lineGap: options.lineGap ?? 0
  });
}

/** Rút gọn footer theo đúng bề rộng cột để hai vế không chồng lên nhau khi URL dài. */
function fitCertificateFooter(document: PDFKit.PDFDocument, text: string, width: number, fontSize: number): string {
  if (measureCertificateText(document, text, fontSize, 'regular') <= width) return text;
  let value = text;
  while (value.length > 8 && measureCertificateText(document, `${value.trimEnd()}...`, fontSize, 'regular') > width) {
    value = value.slice(0, -1);
  }
  return `${value.trimEnd()}...`;
}

/** Vẽ khung hoàng gia teal-gold, hoa văn góc và footer cố định theo mẫu certificate. */
function drawCertificateFrame(
  document: PDFKit.PDFDocument,
  certificateId: string,
  pageNumber: number,
  ornate = true,
  leftFooter?: string,
  rightFooter?: string
): void {
  const { width, height } = document.page;
  document.save().rect(0, 0, width, height).fill(PAPER);
  // Nền giấy HTML có hai quầng sáng rất nhẹ ở đầu/cuối trang. PDFKit không
  // có radial-gradient nên mô phỏng bằng các ellipse trong suốt, giữ độ
  // tương phản thấp để không ảnh hưởng khả năng đọc nội dung.
  document.save()
    .opacity(0.16)
    .fillColor('#FEF9C3')
    .ellipse(width / 2, height * 0.12, width * 0.58, height * 0.17)
    .fill()
    .opacity(0.18)
    .fillColor('#F0FDFA')
    .ellipse(width / 2, height * 0.86, width * 0.64, height * 0.2)
    .fill()
    .restore();
  if (ornate) {
    document
      .rect(FRAME_INSET_X + 8 * FRAME_SCALE_X, FRAME_INSET_Y + 8 * FRAME_SCALE_Y, width - 2 * (FRAME_INSET_X + 8 * FRAME_SCALE_X), height - 2 * (FRAME_INSET_Y + 8 * FRAME_SCALE_Y)).lineWidth(1.05).strokeColor(GOLD_PRIMARY).stroke()
      .rect(FRAME_INSET_X + 14 * FRAME_SCALE_X, FRAME_INSET_Y + 14 * FRAME_SCALE_Y, width - 2 * (FRAME_INSET_X + 14 * FRAME_SCALE_X), height - 2 * (FRAME_INSET_Y + 14 * FRAME_SCALE_Y)).lineWidth(2.45).strokeColor(TEAL_PRIMARY).stroke()
      .rect(FRAME_INSET_X + 20 * FRAME_SCALE_X, FRAME_INSET_Y + 20 * FRAME_SCALE_Y, width - 2 * (FRAME_INSET_X + 20 * FRAME_SCALE_X), height - 2 * (FRAME_INSET_Y + 20 * FRAME_SCALE_Y)).lineWidth(0.7).strokeColor(GOLD_PRIMARY).stroke()
      .dash(8 * FRAME_SCALE_X, { space: 4 * FRAME_SCALE_X }).rect(FRAME_INSET_X + 28 * FRAME_SCALE_X, FRAME_INSET_Y + 28 * FRAME_SCALE_Y, width - 2 * (FRAME_INSET_X + 28 * FRAME_SCALE_X), height - 2 * (FRAME_INSET_Y + 28 * FRAME_SCALE_Y)).lineWidth(0.53).strokeColor(GOLD_PRIMARY).opacity(0.5).stroke()
      .undash();
  } else {
    document
      .rect(FRAME_INSET_X + 10 * FRAME_SCALE_X, FRAME_INSET_Y + 10 * FRAME_SCALE_Y, width - 2 * (FRAME_INSET_X + 10 * FRAME_SCALE_X), height - 2 * (FRAME_INSET_Y + 10 * FRAME_SCALE_Y)).lineWidth(1.08).strokeColor('#CBD5E1').stroke()
      .rect(FRAME_INSET_X + 16 * FRAME_SCALE_X, FRAME_INSET_Y + 16 * FRAME_SCALE_Y, width - 2 * (FRAME_INSET_X + 16 * FRAME_SCALE_X), height - 2 * (FRAME_INSET_Y + 16 * FRAME_SCALE_Y)).lineWidth(0.72).strokeColor(TEAL_PRIMARY).opacity(0.35).stroke();
  }
  document.restore();
  if (ornate) {
    drawFrameCorner(document, FRAME_INSET_X + 14 * FRAME_SCALE_X, FRAME_INSET_Y + 14 * FRAME_SCALE_Y, 1, 1);
    drawFrameCorner(document, width - FRAME_INSET_X - 14 * FRAME_SCALE_X, FRAME_INSET_Y + 14 * FRAME_SCALE_Y, -1, 1);
    drawFrameCorner(document, FRAME_INSET_X + 14 * FRAME_SCALE_X, height - FRAME_INSET_Y - 14 * FRAME_SCALE_Y, 1, -1);
    drawFrameCorner(document, width - FRAME_INSET_X - 14 * FRAME_SCALE_X, height - FRAME_INSET_Y - 14 * FRAME_SCALE_Y, -1, -1);
    drawFrameCrest(document, width / 2, FRAME_INSET_Y + 14 * FRAME_SCALE_Y, 1);
    drawFrameCrest(document, width / 2, height - FRAME_INSET_Y - 14 * FRAME_SCALE_Y, -1);
  }
  // Footer nằm trong khung trang nên không được PDFKit tự ngắt sang trang mới theo margin mặc định.
  document.page.margins.bottom = 0;
  document.lineWidth(0.5).strokeColor('#E2E8F0')
    .moveTo(PAGE_MARGIN, height - 51)
    .lineTo(width - PAGE_MARGIN, height - 51)
    .stroke();
  document.fillColor(INK_MUTED);
  const footerFontSize = 5.6;
  drawCertificateText(
    document,
    fitCertificateFooter(document, leftFooter ?? `Mã xác nhận: ${certificateId}`, 245, footerFontSize),
    PAGE_MARGIN,
    height - 47,
    footerFontSize,
    'regular',
    { width: 245, lineBreak: false }
  );
  drawCertificateText(
    document,
    fitCertificateFooter(document, rightFooter ?? `Trang ${pageNumber} / 2 · Quét QR để kiểm tra hiệu lực hiện tại`, 266, footerFontSize),
    287,
    height - 47,
    footerFontSize,
    'regular',
    { width: 266, align: 'right', lineBreak: false }
  );
}

/** Vẽ một họa tiết góc đối xứng bằng vector để PDF không phụ thuộc asset ngoài. */
function drawFrameCorner(document: PDFKit.PDFDocument, x: number, y: number, xScale: number, yScale: number): void {
  document.save()
    .translate(x, y)
    .scale(xScale * FRAME_SCALE_X, yScale * FRAME_SCALE_Y)
    .fillColor(GOLD_PRIMARY).moveTo(0, 0).lineTo(50, 0).bezierCurveTo(35, 10, 25, 25, 25, 45).bezierCurveTo(10, 40, 5, 30, 0, 0).fill()
    .fillColor(TEAL_DARK).moveTo(6, 6).lineTo(40, 6).bezierCurveTo(28, 15, 20, 28, 20, 40).lineTo(6, 40).fill()
    .lineWidth(1.8).strokeColor(GOLD_LIGHT).moveTo(0, 55).bezierCurveTo(35, 35, 35, 18, 55, 0).stroke()
    .lineWidth(1.2).strokeColor(TEAL_PRIMARY).moveTo(0, 65).bezierCurveTo(45, 45, 45, 18, 65, 0).stroke()
    .fillColor(GOLD_LIGHT).circle(18, 18, 4).fill()
    .restore();
}

/** Vẽ huy hiệu trung tâm ở viền trên hoặc dưới để đồng bộ chi tiết khung của mẫu HTML. */
function drawFrameCrest(document: PDFKit.PDFDocument, centerX: number, y: number, direction: 1 | -1): void {
  document.save()
    .fillColor(GOLD_PRIMARY)
    .translate(centerX, y)
    .scale(FRAME_SCALE_X, direction * FRAME_SCALE_Y)
    .moveTo(-40, 0)
    .quadraticCurveTo(0, -8, 40, 0)
    .quadraticCurveTo(20, 10, 0, 14)
    .quadraticCurveTo(-20, 10, -40, 0)
    .fill()
    .fillColor(TEAL_DARK).circle(0, 5, 3).fill()
    .circle(-15, 3, 1.8).fill()
    .circle(15, 3, 1.8).fill()
    .restore();
}

/** Vẽ biểu tượng khiên kèm dấu xác nhận để đồng nhất các badge SVG trong mẫu HTML. */
function drawShieldCheckIcon(document: PDFKit.PDFDocument, x: number, y: number, size: number): void {
  document.save()
    .fillColor(TEAL_PRIMARY)
    .moveTo(x + size / 2, y)
    .lineTo(x + size * 0.1, y + size * 0.18)
    .lineTo(x + size * 0.1, y + size * 0.48)
    .bezierCurveTo(x + size * 0.1, y + size * 0.78, x + size * 0.32, y + size * 0.95, x + size / 2, y + size)
    .bezierCurveTo(x + size * 0.68, y + size * 0.95, x + size * 0.9, y + size * 0.78, x + size * 0.9, y + size * 0.48)
    .lineTo(x + size * 0.9, y + size * 0.18)
    .closePath()
    .fill()
    .lineWidth(Math.max(0.7, size * 0.1))
    .strokeColor('#FFFFFF')
    .moveTo(x + size * 0.27, y + size * 0.5)
    .lineTo(x + size * 0.44, y + size * 0.67)
    .lineTo(x + size * 0.74, y + size * 0.34)
    .stroke()
    .restore();
}

/** Khiên viền mảnh dùng cho trust card, tương đương SVG stroke của HTML. */
function drawOutlineShieldIcon(document: PDFKit.PDFDocument, x: number, y: number, size: number): void {
  document.save()
    .lineWidth(Math.max(0.8, size * 0.11))
    .strokeColor(TEAL_PRIMARY)
    .moveTo(x + size / 2, y)
    .lineTo(x + size * 0.1, y + size * 0.18)
    .lineTo(x + size * 0.1, y + size * 0.48)
    .bezierCurveTo(x + size * 0.1, y + size * 0.78, x + size * 0.32, y + size * 0.95, x + size / 2, y + size)
    .bezierCurveTo(x + size * 0.68, y + size * 0.95, x + size * 0.9, y + size * 0.78, x + size * 0.9, y + size * 0.48)
    .lineTo(x + size * 0.9, y + size * 0.18)
    .closePath()
    .stroke()
    .restore();
}

/** Vẽ ngôi sao vector nhỏ; dùng thay ký tự Unicode để không phụ thuộc glyph font. */
function drawFivePointStar(
  document: PDFKit.PDFDocument,
  centerX: number,
  centerY: number,
  outerRadius: number,
  innerRadius: number,
  color: string
): void {
  document.save().fillColor(color).moveTo(centerX, centerY - outerRadius);
  for (let point = 1; point < 10; point += 1) {
    const angle = -Math.PI / 2 + point * (Math.PI / 5);
    const radius = point % 2 === 0 ? outerRadius : innerRadius;
    document.lineTo(centerX + Math.cos(angle) * radius, centerY + Math.sin(angle) * radius);
  }
  document.closePath().fill().restore();
}

/** Vẽ watermark bảo mật nhẹ để giữ cảm giác chứng thư mà không che dữ liệu nghiệp vụ. */
interface CertificateWatermarkOptions {
  ringDiameter?: number;
  ringOpacity?: number;
  textColor?: string;
  textSize?: number;
  textOpacity?: number;
  subTextColor?: string;
  subTextSize?: number;
  subTextOpacity?: number;
}

function drawSecurityWatermark(
  document: PDFKit.PDFDocument,
  label: string,
  subLabel = '',
  options: CertificateWatermarkOptions = {}
): void {
  const { width, height } = document.page;
  const ringRadius = (options.ringDiameter ?? 390) / 2;
  document.save()
    .opacity(options.ringOpacity ?? 0.035)
    .lineWidth(0.55)
    .strokeColor(TEAL_PRIMARY);
  // HTML dùng repeating-radial-gradient với chu kỳ 12px (~9pt khi in A4).
  // Vẽ đủ cả các vòng phía trong để watermark không bị mất ở vùng nội dung chính.
  for (let radius = 2; radius <= ringRadius; radius += 9) {
    document.circle(width / 2, height * 0.5, radius).stroke();
  }
  document.restore();
  document.save()
    .opacity(options.textOpacity ?? 0.038)
    .fillColor(options.textColor ?? TEAL_PRIMARY)
    .rotate(-32, { origin: [width / 2, height / 2] });
  drawCertificateSerifText(document, label, 80, height / 2 - 12, options.textSize ?? 33, 'bold', { width: width - 160, align: 'center', lineBreak: false, fallbackWeight: 'bold' });
  if (subLabel) {
    document.opacity(options.subTextOpacity ?? 0.045).fillColor(options.subTextColor ?? GOLD_DARK);
    drawCertificateText(document, subLabel, 95, height / 2 + 34, options.subTextSize ?? 9, 'bold', { width: width - 190, align: 'center', lineBreak: false });
  }
  document.restore();
}

/** Vẽ dấu điện tử DCP từ vector PDF để không phụ thuộc asset hoặc ảnh remote. */
function drawDigitalSeal(document: PDFKit.PDFDocument, centerX: number, centerY: number): void {
  const ringText = 'DCP RECORD · DATA INTEGRITY';
  document.save()
    .lineWidth(1.4).strokeColor(GOLD_PRIMARY).circle(centerX, centerY, 34).stroke()
    .lineWidth(1).strokeColor(TEAL_PRIMARY).circle(centerX, centerY, 28).stroke()
    .fillColor('#F0FDFA').circle(centerX, centerY, 19).fill()
    .fillColor(GOLD_PRIMARY)
    .moveTo(centerX, centerY - 12)
    .lineTo(centerX + 3.2, centerY - 4)
    .lineTo(centerX + 12, centerY - 3)
    .lineTo(centerX + 5.2, centerY + 3)
    .lineTo(centerX + 7, centerY + 11)
    .lineTo(centerX, centerY + 6.5)
    .lineTo(centerX - 7, centerY + 11)
    .lineTo(centerX - 5.2, centerY + 3)
    .lineTo(centerX - 12, centerY - 3)
    .lineTo(centerX - 3.2, centerY - 4)
    .closePath()
    .fill();
  // SVG mẫu đặt chữ chạy quanh vòng trong; xoay từng ký tự giữ được hiệu ứng
  // này trong PDFKit mà không cần ảnh raster hay font riêng cho text-path.
  const characters = Array.from(ringText);
  characters.forEach((character, index) => {
    const angle = -Math.PI / 2 + (index / characters.length) * Math.PI * 2;
    const x = centerX + Math.cos(angle) * 31;
    const y = centerY + Math.sin(angle) * 31;
    document.save()
      .fillColor(TEAL_PRIMARY)
      .font('BeVietnamLatinBold')
      .fontSize(3.4)
      .translate(x, y)
      .rotate((angle * 180) / Math.PI + 90)
      .text(character, -1.6, -1.7, { width: 3.2, align: 'center', lineBreak: false })
      .restore();
  });
  document.save()
    .lineWidth(0.7)
    .strokeColor(GOLD_PRIMARY)
    .circle(centerX, centerY, 19)
    .stroke()
    .restore();
}

/** Vẽ watermark thu hồi rõ ràng trên toàn trang nhưng vẫn giữ dữ liệu snapshot để đối soát. */
function drawRevokedWatermark(document: PDFKit.PDFDocument, reasonCode?: string): void {
  const { width, height } = document.page;
  document.save().opacity(0.15).fillColor(REVOKED).rotate(-35, { origin: [width / 2, height / 2] });
  drawCertificateText(document, 'ĐÃ THU HỒI', 90, height / 2 - 18, 40, 'bold', { width: width - 180, align: 'center', lineBreak: false });
  document.restore();
  if (reasonCode) {
    document.fillColor(REVOKED);
    drawCertificateText(document, `Lý do thu hồi: ${reasonCode}`, PAGE_MARGIN, height - 49, 8, 'regular', { lineBreak: false });
  }
}

/** Format ngày cấp theo múi giờ Việt Nam để không dùng ngày giờ từ request. */
function formatVietnameseDate(issuedAt: Date | undefined): string {
  return new Intl.DateTimeFormat('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: 'long', day: 'numeric'
  }).format(issuedAt ?? new Date());
}

/** Định dạng giá trị quy đổi tiền mặt dùng trên chứng thư; token DCT chỉ là dữ liệu đối soát. */
function formatCertificateVndAmount(snapshot: { vndEquivalent?: string; amountRaw: string }): string {
  const rawAmount = snapshot.vndEquivalent?.trim() || snapshot.amountRaw;
  try {
    return BigInt(rawAmount).toLocaleString('vi-VN');
  } catch {
    return rawAmount;
  }
}

/** Vẽ thanh đối soát ngang gồm QR, URL, trạng thái và mã certificate như mẫu HTML. */
function drawVerificationBlock(document: PDFKit.PDFDocument, qrBuffer: Buffer, verificationUrl: string, certificateId: string, blockY = 748): void {
  const { width } = document.page;
  const blockHeight = 36;
  const qrSize = 31;
  const displayUrl = verificationUrl.length > 48 ? `${verificationUrl.slice(0, 45)}...` : verificationUrl;
  const blockX = PAGE_MARGIN + 9;
  const blockWidth = width - blockX * 2;
  document.roundedRect(blockX, blockY, blockWidth, blockHeight, 6).fillAndStroke('#F8FAFC', '#E2E8F0');
  document.image(qrBuffer, blockX + 11, blockY + 3, { width: qrSize });
  document.fillColor(TEAL_PRIMARY);
  drawCertificateText(document, 'QUÉT MÃ QR ĐỂ TRA CỨU ĐÓNG GÓP', blockX + 46, blockY + 7, 6.5, 'bold', { width: 225, lineBreak: false });
  document.fillColor(INK_MUTED).font('Courier').fontSize(5.7)
    .text(displayUrl, blockX + 46, blockY + 18, { width: 225, lineBreak: false });
  const statusX = width - RECEIPT_MARGIN - 122;
  document.roundedRect(statusX, blockY + 5, 112, 15, 8).fillAndStroke('#ECFDF5', '#A7F3D0');
  document.fillColor('#047857');
  drawCertificateText(document, 'ĐÃ GHI NHẬN THÀNH CÔNG', statusX + 8, blockY + 9, 5.5, 'bold', { width: 96, align: 'center', lineBreak: false });
  document.fillColor(GOLD_DARK);
  drawCertificateText(document, `Mã xác nhận: ${certificateId}`, statusX, blockY + 23, 6, 'bold', { width: 112, align: 'center', lineBreak: false });
}

/** Vẽ cấp vinh danh và gạch chân vàng cho tên người đóng góp theo bố cục giấy khen. */
function drawDonorHonorTier(document: PDFKit.PDFDocument, width: number, y = 292): void {
  const badgeWidth = 255;
  const badgeX = (width - badgeWidth) / 2;
  const badgeHeight = 15;
  document.roundedRect(badgeX, y, badgeWidth, badgeHeight, 7.5).fill('#FFFBEB');
  document.save()
    .opacity(0.55)
    .fillColor('#FEF08A')
    .roundedRect(badgeX + badgeWidth * 0.43, y, badgeWidth * 0.57, badgeHeight, 7.5)
    .fill()
    .restore();
  document.roundedRect(badgeX, y, badgeWidth, badgeHeight, 7.5).lineWidth(0.9).strokeColor('#FDE68A').stroke();
  document.fillColor(GOLD_PRIMARY);
  drawFivePointStar(document, badgeX + 15, y + badgeHeight / 2, 4, 1.7, GOLD_DARK);
  drawCertificateText(document, 'ĐÓNG GÓP CỘNG ĐỒNG · COMMUNITY SUPPORTER', badgeX + 25, y + 4, 7.5, 'bold', { width: badgeWidth - 33, align: 'center', lineBreak: false });
}

/** Vẽ đường hoa văn vàng lượn nhẹ dưới tên người đóng góp như SVG trong mẫu HTML. */
function drawDonorFlourish(document: PDFKit.PDFDocument, width: number, y: number): void {
  const centerX = width / 2;
  document.save()
    .lineWidth(0.9)
    .strokeColor(GOLD_PRIMARY)
    .moveTo(centerX - 60, y)
    .bezierCurveTo(centerX - 40, y - 4, centerX - 20, y + 4, centerX, y)
    .bezierCurveTo(centerX + 20, y - 4, centerX + 40, y + 4, centerX + 60, y)
    .stroke()
    .fillColor(GOLD_PRIMARY)
    .circle(centerX, y, 2)
    .circle(centerX - 21, y, 1.1)
    .circle(centerX + 21, y, 1.1)
    .fill()
    .restore();
}

/** Vẽ khu vực xác nhận hệ thống, đơn vị tiếp nhận và dấu số mà không dùng tên đại diện giả. */
function drawCertificateSignatures(document: PDFKit.PDFDocument, organizationName: string, width: number, y = 668): void {
  const centerColumnWidth = 90;
  const gridGap = 9;
  const columnWidth = (width - 2 * PAGE_MARGIN - centerColumnWidth - 2 * gridGap) / 2;
  const leftColumnX = PAGE_MARGIN;
  const rightColumnX = PAGE_MARGIN + columnWidth + gridGap + centerColumnWidth + gridGap;
  document.fillColor(INK_MUTED);
  drawCertificateText(document, 'XÁC NHẬN HỆ THỐNG DCP', leftColumnX, y, 7.5, 'bold', { width: columnWidth, align: 'center' });
  drawCertificateText(document, 'ĐƠN VỊ TIẾP NHẬN', rightColumnX, y, 7.5, 'bold', { width: columnWidth, align: 'center' });
  drawCertificateText(document, 'Nền tảng minh bạch đóng góp', leftColumnX, y + 14, 7, 'regular', { width: columnWidth, align: 'center' });
  drawCertificateText(document, organizationName, rightColumnX, y + 14, 7, 'regular', { width: columnWidth, align: 'center' });
  document.fillColor(TEAL_PRIMARY);
  const signatureTextY = y + 20;
  drawCertificateScriptText(document, 'DCP', leftColumnX, signatureTextY, 19.5, { width: columnWidth, align: 'center', lineBreak: false });
  document.fillColor(GOLD_DARK);
  // Segoe Script không có đủ glyph tiếng Việt; dùng serif italic có subset
  // Unicode đầy đủ cho chữ ký bên phải để tuyệt đối không sinh ô vuông.
  drawCertificateSerifText(document, 'Xác nhận', rightColumnX, signatureTextY, 19.5, 'italic', { width: columnWidth, align: 'center', lineBreak: false, fallbackWeight: 'italic' });
  document.lineWidth(0.6).strokeColor('#CBD5E1')
    .moveTo(leftColumnX + 15, y + 46).lineTo(leftColumnX + columnWidth - 15, y + 46)
    .moveTo(rightColumnX + 15, y + 46).lineTo(rightColumnX + columnWidth - 15, y + 46)
    .stroke();
  document.fillColor(INK_MUTED);
  drawCertificateText(document, 'Đại diện nền tảng', leftColumnX, y + 49, 6.5, 'regular', { width: columnWidth, align: 'center', lineBreak: false });
  drawCertificateText(document, 'Đại diện đơn vị', rightColumnX, y + 49, 6.5, 'regular', { width: columnWidth, align: 'center', lineBreak: false });
  drawDigitalSeal(document, width / 2, y + 31);
}

/** Vẽ header chứng nhận gồm badge nền tảng, dòng xác nhận và tiêu đề giống bố cục HTML. */
function drawCertificateHeader(document: PDFKit.PDFDocument, width: number): void {
  const brandWidth = 190;
  const brandX = (width - brandWidth) / 2;
  document.roundedRect(brandX, 53, brandWidth, 16, 8).fillAndStroke('#F0FDFA', '#99F6E4');
  drawShieldCheckIcon(document, brandX + 8, 56, 10);
  document.fillColor(TEAL_DARK);
  drawCertificateText(document, 'NỀN TẢNG MINH BẠCH ĐÓNG GÓP DCP', brandX + 23, 57, 7.5, 'bold', { width: brandWidth - 30, align: 'center', lineBreak: false });
  const decreeWidth = 335;
  const decreeX = (width - decreeWidth) / 2;
  document.roundedRect(decreeX, 73, decreeWidth, 15, 4).fillAndStroke('#F1F5F9', '#E2E8F0');
  document.fillColor('#475569');
  drawCertificateText(document, 'Xác nhận khoản đóng góp đã được hệ thống ghi nhận thành công tại thời điểm phát hành tài liệu.', decreeX + 8, 77, 6.5, 'italic', { width: decreeWidth - 16, align: 'center', lineBreak: false });
  document.fillColor(TEAL_DARK);
  drawCertificateSerifText(document, 'GIẤY XÁC NHẬN ĐÓNG GÓP', PAGE_MARGIN, 85, 24.5, 'bold', { width: width - PAGE_MARGIN * 2, align: 'center', lineBreak: false, fallbackWeight: 'bold' });
  document.moveTo(255, 111).lineTo(340, 111).lineWidth(2).strokeColor(GOLD_PRIMARY).stroke();
  document.fillColor(GOLD_DARK);
  drawCertificateSerifText(document, 'Donation Acknowledgement', PAGE_MARGIN, 116, 9.5, 'italic', { width: width - PAGE_MARGIN * 2, align: 'center', lineBreak: false });
}

/** Render trang chứng nhận theo mẫu thiết kế, chỉ dùng dữ liệu snapshot đã phát hành. */
function drawCertificatePage(document: PDFKit.PDFDocument, certificate: DonationCertificateRecord, qrBuffer: Buffer, verificationUrl: string): void {
  const snapshot = certificate.snapshot!;
  const { width } = document.page;
  const donationReference = snapshot.transactionHash.length > 24
    ? `${snapshot.transactionHash.slice(0, 10)}...${snapshot.transactionHash.slice(-8)}`
    : snapshot.transactionHash;
  drawCertificateFrame(
    document,
    certificate.certificateId,
    1,
    true,
    `Tra cứu thông tin đóng góp tại: ${verificationUrl}`,
    'Trang 1 / 2 · Bản ghi kỹ thuật on-chain, nếu có, chỉ hỗ trợ kiểm tra tính toàn vẹn dữ liệu'
  );
  drawSecurityWatermark(document, 'DCP · DONATION RECORD', 'TRANSPARENT GIVING · DATA INTEGRITY', {
    // Vùng guilloche của HTML chiếm gần toàn bộ chiều rộng phần nội dung khi xem bản in.
    ringDiameter: 500,
    ringOpacity: 0.08
  });
  drawCertificateHeader(document, width);
  document.fillColor('#334155');
  drawCertificateText(document, 'Trân trọng cảm ơn và xác nhận khoản đóng góp của:', PAGE_MARGIN, 276, 10, 'regular', { width: width - PAGE_MARGIN * 2, align: 'center' });
  drawDonorHonorTier(document, width, 290);
  document.fillColor(TEAL_DARK);
  drawCertificateSerifText(document, snapshot.donorName.toLocaleUpperCase('vi-VN'), PAGE_MARGIN + 22, 310, 30.5, 'bold', { width: width - PAGE_MARGIN * 2 - 44, align: 'center', lineBreak: false, fallbackWeight: 'bold' });
  drawDonorFlourish(document, width, 345);
  document.fillColor(INK_MUTED);
  document.roundedRect(208, 358, 180, 8.5, 4.25).fillAndStroke('#F1F5F9', '#CBD5E1');
  document.fillColor(INK_MUTED);
  drawCertificateText(document, 'Mã tham chiếu đóng góp:', 216, 361, 5.9, 'regular', { width: 82, lineBreak: false });
  document.font('Courier').fontSize(5.9).fillColor(INK_MUTED).text(donationReference, 299, 361, { width: 81, lineBreak: false });
  // Khung HTML dùng gradient ngang teal–gold–teal. Vẽ ba lớp nền mờ để
  // PDF có cùng cảm giác chuyển sắc nhưng vẫn giữ viền sắc nét.
  document.roundedRect(111, 375, 373, 60, 7).fill('#F0FDFA');
  document.save()
    .opacity(0.42)
    .fillColor('#FEF9C3')
    .roundedRect(205, 375, 185, 60, 7)
    .fill()
    .restore();
  document.roundedRect(111, 375, 373, 60, 7).lineWidth(0.9).strokeColor('#D4A72C').stroke();
  document.fillColor('#334155');
  drawCertificateText(document, 'Giá trị đóng góp đã ghi nhận:', 132, 385, 9, 'regular', { width: width - 264, align: 'center', lineBreak: false });
  document.fillColor(TEAL_DARK);
  const formattedDonationVnd = formatCertificateVndAmount(snapshot);
  drawCenteredCertificateSegments(document, [
    { value: `${formattedDonationVnd} `, color: TEAL_DARK, fontSize: 20, weight: 'bold' },
    { value: CERTIFICATE_DISPLAY_CURRENCY, color: GOLD_DARK, fontSize: 11, weight: 'bold' }
  ], 396, width);
  document.fillColor(INK_MUTED);
  drawCertificateText(document, `Phương thức: ${CERTIFICATE_PAYMENT_METHOD} · Trạng thái thanh toán: Thành công`, 132, 421, 6.2, 'regular', { width: width - 264, align: 'center', lineBreak: false });
  drawCenteredCertificateSegments(document, [
    { value: 'Đóng góp cho: ', color: '#334155', fontSize: 10, weight: 'regular' },
    { value: snapshot.projectName, color: TEAL_PRIMARY, fontSize: 10, weight: 'bold' }
  ], 446, width);
  drawCenteredCertificateSegments(document, [
    { value: 'Đơn vị tiếp nhận: ', color: '#334155', fontSize: 10, weight: 'regular' },
    { value: `${snapshot.organizationName}.`, color: INK_MAIN, fontSize: 10, weight: 'bold' }
  ], 460, width);
  const legalBadgeWidth = 316;
  const legalBadgeX = (width - legalBadgeWidth) / 2;
  document.roundedRect(legalBadgeX, 474, legalBadgeWidth, 18, 9).fillAndStroke('#ECFDF5', '#A7F3D0');
  drawShieldCheckIcon(document, legalBadgeX + 9, 478, 8);
  document.fillColor(TEAL_PRIMARY);
  drawCertificateText(document, 'Thông tin được lưu để hỗ trợ tra cứu trạng thái, theo dõi tiến độ và đối soát công khai', legalBadgeX + 19, 479, 6.2, 'bold', { width: legalBadgeWidth - 28, align: 'center', lineBreak: false });
  document.fillColor(INK_MUTED);
  drawCertificateSerifText(document, '“Mỗi đóng góp là một niềm tin. DCP cam kết hỗ trợ người đóng góp theo dõi thông tin đã công bố một cách rõ ràng và thuận tiện.”', PAGE_MARGIN + 73, 495, 8.2, 'italic', { width: width - PAGE_MARGIN * 2 - 146, align: 'center', lineGap: 3, fallbackWeight: 'italic' });
  drawCertificateSerifText(document, `Hà Nội, ${formatVietnameseDate(certificate.issuedAt)}`, PAGE_MARGIN, 521, 8.5, 'italic', { width: width - PAGE_MARGIN * 2, align: 'center', lineBreak: false, fallbackWeight: 'italic' });
  // Chừa khoảng cách an toàn với thanh QR để không che dòng đại diện bên dưới chữ ký.
  drawCertificateSignatures(document, snapshot.organizationName, width, 668);
  drawVerificationBlock(document, qrBuffer, verificationUrl, certificate.certificateId, 744);
  if (certificate.issuanceStatus === 'REVOKED') drawRevokedWatermark(document, certificate.revocationReasonCode);
}

/** Vẽ một hàng biên lai theo đúng màu xen kẽ và tỷ lệ cột của bảng HTML. */
function drawReceiptRow(document: PDFKit.PDFDocument, label: string, value: string, y: number, rowIndex: number): number {
  const labelWidth = 163;
  const valueWidth = 330;
  const valueFont = value.startsWith('0x') ? 6.4 : 6.5;
  const labelFont = 6.6;
  const labelLineCount = countCertificateTextLines(document, label, labelWidth - 16, labelFont, 'regular');
  const labelHeight = labelLineCount * (labelFont * 1.2 + 0.5);
  const valueLineCount = value.startsWith('0x')
    ? Math.max(1, Math.ceil(document.font('Courier').fontSize(valueFont).widthOfString(value) / (valueWidth - 16)))
    : countCertificateTextLines(document, value, valueWidth - 16, valueFont, 'regular');
  const valueHeight = valueLineCount * (valueFont * 1.2 + 0.6);
  const rowHeight = Math.max(16.6, labelHeight + 4.5, valueHeight + 4.5);
  document.rect(RECEIPT_MARGIN, y, labelWidth, rowHeight).fillAndStroke('#F1F5F9', '#E2E8F0');
  document.rect(RECEIPT_MARGIN + labelWidth, y, valueWidth, rowHeight)
    .fillAndStroke(rowIndex % 2 === 0 ? '#F8FAFC' : '#FFFFFF', '#E2E8F0');
  document.fillColor('#334155');
  drawCertificateText(document, label, RECEIPT_MARGIN + 8, y + 3.5, labelFont, 'bold', { width: labelWidth - 16, lineGap: 0.5 });
  const sansValue = label.startsWith('Mã giấy') || label.startsWith('Nền tảng') || label.startsWith('Chương trình') || label.startsWith('Đơn vị');
  const highlightValue = label.includes('Giá trị');
  const isAsciiValue = Array.from(value).every((character) => (character.codePointAt(0) ?? 0) <= 0x7f);
  if (value.startsWith('0x')) {
    document.fillColor(TEAL_PRIMARY).font('Courier-Bold').fontSize(valueFont).text(value, RECEIPT_MARGIN + labelWidth + 8, y + 3.5, { width: valueWidth - 16, lineGap: 0.5 });
  } else if (sansValue) {
    document.fillColor(label.startsWith('Mã giấy') ? TEAL_PRIMARY : INK_MAIN);
    drawCertificateText(document, value, RECEIPT_MARGIN + labelWidth + 8, y + 3.5, valueFont, label.startsWith('Đơn vị') || label.startsWith('Chương trình') ? 'bold' : 'regular', { width: valueWidth - 16, lineGap: 0.5 });
  } else if (isAsciiValue) {
    document.fillColor(label.includes('Liên kết') ? TEAL_PRIMARY : INK_MAIN).font(highlightValue ? 'Courier-Bold' : 'Courier').fontSize(highlightValue ? 7.5 : valueFont).text(value, RECEIPT_MARGIN + labelWidth + 8, y + 3.5, { width: valueWidth - 16, lineGap: 0.5, underline: label.includes('Liên kết') });
  } else {
    document.fillColor(highlightValue ? TEAL_PRIMARY : INK_MAIN);
    drawCertificateText(document, value, RECEIPT_MARGIN + labelWidth + 8, y + 3.5, highlightValue ? 7.5 : valueFont, highlightValue ? 'bold' : 'regular', { width: valueWidth - 16, lineGap: 0.5 });
  }
  return y + rowHeight;
}

/** Render trang biên lai đối soát có đủ snapshot receipt và khung bảo mật theo mẫu HTML. */
function drawReceiptPage(document: PDFKit.PDFDocument, certificate: DonationCertificateRecord, verificationUrl: string): void {
  const snapshot = certificate.snapshot!;
  drawCertificateFrame(
    document,
    certificate.certificateId,
    2,
    false,
    `Mã xác nhận: ${certificate.certificateId}`,
    `Trang 2 / 2 · Tra cứu trực tuyến tại ${verificationUrl}`
  );
  drawSecurityWatermark(document, 'DCP · TRANSPARENT GIVING', 'DONATION STATUS & DATA INTEGRITY', {
    ringDiameter: 430,
    ringOpacity: 0.055,
    textColor: '#64748B',
    textSize: 28.5,
    subTextColor: TEAL_PRIMARY
  });
  document.fillColor(TEAL_PRIMARY);
  drawCertificateSerifText(document, 'BẢNG KÊ ĐÓNG GÓP & THÔNG TIN ĐỐI SOÁT', RECEIPT_MARGIN, 49, 15, 'bold', { lineBreak: false, fallbackWeight: 'bold' });
  document.fillColor(INK_MUTED);
  drawCertificateText(document, 'Thông tin được trích xuất từ snapshot tại thời điểm phát hành giấy xác nhận', RECEIPT_MARGIN, 71, 8.5, 'regular', { lineBreak: false });
  document.lineWidth(1.2).strokeColor(TEAL_PRIMARY)
    .moveTo(RECEIPT_MARGIN, 84)
    .lineTo(RECEIPT_MARGIN + 493, 84)
    .stroke();
  document.roundedRect(465, 63, 80, 16, 8).fillAndStroke('#ECFDF5', '#A7F3D0');
  document.fillColor(certificate.issuanceStatus === 'REVOKED' ? REVOKED : '#059669');
  if (certificate.issuanceStatus !== 'REVOKED') drawShieldCheckIcon(document, 472, 67, 7);
  drawCertificateText(document, certificate.issuanceStatus === 'REVOKED' ? 'ĐÃ THU HỒI' : 'ĐÃ GHI NHẬN', 482, 67, 7.1, 'bold', { width: 57, align: 'center', lineBreak: false });
  const rows: Array<[string, string]> = [
    ['Mã giấy xác nhận', certificate.certificateId],
    ['Mã tham chiếu đóng góp', snapshot.transactionHash],
    ['Nền tảng ghi nhận', 'DCP'],
    ['Chương trình nhận đóng góp', snapshot.projectName],
    ['Đơn vị tiếp nhận', snapshot.organizationName],
    ['Người đóng góp', snapshot.donorName],
    ['Giá trị đóng góp đã ghi nhận', `${formatCertificateVndAmount(snapshot)} ${CERTIFICATE_DISPLAY_CURRENCY}`],
    ['Phương thức thanh toán', CERTIFICATE_PAYMENT_METHOD],
    ['Mã giao dịch thanh toán', snapshot.transactionHash],
    ['Thời điểm ghi nhận (UTC+7)', new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', dateStyle: 'medium', timeStyle: 'medium', hour12: false }).format(snapshot.donatedAt)],
    ['Thời điểm phát hành (UTC+7)', new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', dateStyle: 'medium', timeStyle: 'medium', hour12: false }).format(certificate.issuedAt)],
    ['Mạng blockchain', `${snapshot.networkName} · Chain ID: ${snapshot.chainId}`],
    ['Mã giao dịch on-chain', snapshot.transactionHash],
    ['Khối xác nhận on-chain', `#${snapshot.blockNumber} · ${snapshot.blockHash}`],
    ['Liên kết tra cứu', verificationUrl],
    ['Ghi chú về bản ghi blockchain', 'Nếu sử dụng testnet, bản ghi chỉ hỗ trợ kiểm tra tính toàn vẹn dữ liệu; việc xác nhận thanh toán dựa trên trạng thái giao dịch và dữ liệu đối soát của hệ thống.']
  ];
  const tableStartY = 92;
  let y = tableStartY;
  rows.forEach(([label, value], rowIndex) => {
    y = drawReceiptRow(document, label, value, y, rowIndex);
  });
  document.roundedRect(RECEIPT_MARGIN, tableStartY, 493, y - tableStartY, 8).lineWidth(0.8).strokeColor('#E2E8F0').stroke();
  const trustTop = y + 8;
  document.roundedRect(RECEIPT_MARGIN, trustTop, 493, 43, 5).fillAndStroke('#F0FDFA', '#99F6E4');
  document.lineWidth(3).strokeColor(TEAL_PRIMARY)
    .moveTo(RECEIPT_MARGIN + 1.5, trustTop + 6)
    .lineTo(RECEIPT_MARGIN + 1.5, trustTop + 37)
    .stroke();
  document.save().opacity(0.85);
  drawOutlineShieldIcon(document, RECEIPT_MARGIN + 13, trustTop + 8, 13);
  document.restore();
  document.fillColor(TEAL_DARK);
  drawCertificateText(document, 'Cam kết minh bạch thông tin', RECEIPT_MARGIN + 34, trustTop + 9, 7.5, 'bold', { lineBreak: false });
  document.fillColor('#334155');
  drawCertificateText(document, 'DCP hỗ trợ tra cứu trạng thái đóng góp, thông tin chương trình và dữ liệu được công bố theo từng thời điểm. Dữ liệu on-chain, nếu có, được dùng để tăng khả năng kiểm tra tính toàn vẹn của bản ghi và không thay thế chứng từ thanh toán hoặc báo cáo sử dụng nguồn lực.', RECEIPT_MARGIN + 34, trustTop + 22, 6.4, 'regular', { width: 447, lineGap: 0.5 });
  if (certificate.issuanceStatus === 'REVOKED') drawRevokedWatermark(document, certificate.revocationReasonCode);
}

/** Render PDF A4 hai trang theo mẫu certificate đã duyệt, gồm QR và receipt snapshot bất biến. */
export async function renderDonationCertificatePdf(certificate: DonationCertificateRecord): Promise<Buffer> {
  if (!certificate.snapshot || !['ISSUED', 'REVOKED'].includes(certificate.issuanceStatus)) {
    throw new DonationCertificatePdfError('CERTIFICATE_NOT_ISSUED');
  }
  const verificationUrl = new URL(
    `/donations/verify/${encodeURIComponent(certificate.certificateId)}`,
    getDonationCertificateConfig().frontendUrl
  ).toString();
  const qrBuffer = await QRCode.toBuffer(verificationUrl, { errorCorrectionLevel: 'Q', margin: 1, width: 320, color: { dark: TEAL_DARK, light: '#FFFFFF' } });
  const document = new PDFDocument({ size: 'A4', margins: { top: PAGE_MARGIN, left: PAGE_MARGIN, right: PAGE_MARGIN, bottom: PAGE_MARGIN }, autoFirstPage: true });
  // Fontsource tách font theo unicode-range; đăng ký từng subset để ghép glyph đầy đủ khi vẽ PDF.
  const regularFontPath = (subset: 'latin' | 'latin-ext' | 'vietnamese'): string => require.resolve(`@fontsource/be-vietnam-pro/files/be-vietnam-pro-${subset}-400-normal.woff`);
  const boldFontPath = (subset: 'latin' | 'latin-ext' | 'vietnamese'): string => require.resolve(`@fontsource/be-vietnam-pro/files/be-vietnam-pro-${subset}-700-normal.woff`);
  const italicFontPath = (subset: 'latin' | 'latin-ext' | 'vietnamese'): string => require.resolve(`@fontsource/be-vietnam-pro/files/be-vietnam-pro-${subset}-400-italic.woff`);
  document
    .registerFont('BeVietnamLatin', regularFontPath('latin'))
    .registerFont('BeVietnamLatinExt', regularFontPath('latin-ext'))
    .registerFont('BeVietnamVietnamese', regularFontPath('vietnamese'))
    .registerFont('BeVietnamLatinBold', boldFontPath('latin'))
    .registerFont('BeVietnamLatinExtBold', boldFontPath('latin-ext'))
    .registerFont('BeVietnamVietnameseBold', boldFontPath('vietnamese'))
    .registerFont('BeVietnamLatinItalic', italicFontPath('latin'))
    .registerFont('BeVietnamLatinExtItalic', italicFontPath('latin-ext'))
    .registerFont('BeVietnamVietnameseItalic', italicFontPath('vietnamese'))
    .font('BeVietnamLatin');
  if (HAS_OPTIONAL_SERIF_FONTS) {
    document
      .registerFont('CertificateSerifBold', OPTIONAL_SERIF_BOLD_FONT_PATH)
      .registerFont('CertificateSerifItalic', OPTIONAL_SERIF_ITALIC_FONT_PATH);
  }
  if (HAS_OPTIONAL_SCRIPT_FONT) document.registerFont('CertificateScript', OPTIONAL_SCRIPT_FONT_PATH);
  const completion = collectPdfBuffer(document);
  drawCertificatePage(document, certificate, qrBuffer, verificationUrl);
  document.addPage();
  drawReceiptPage(document, certificate, verificationUrl);
  document.end();
  return completion;
}
