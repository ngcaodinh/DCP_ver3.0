/**
 * Danh sách mã ngân hàng Việt Nam được PayOS hỗ trợ.
 * Nguồn: https://github.com/payosvietnam/payos-checkout-api/blob/main/docs/payos-api.md
 * Format: key = tên ngân hàng viết HOA không dấu (normalized), value = mã PayOS bank code.
 * Lưu ý: PayOS bank codes là immutable identifier do PayOS cung cấp.
 * Nếu PayOS cập nhật danh sách, cập nhật file này.
 */
export const PAYOS_BANK_CODE_MAP: Record<string, string> = {
  VIETCOMBANK: '970436',
  BIDV: '970418',
  VIETINBANK: '970415',
  AGRIBANK: '970405',
  ACB: '970416',
  MB: '970422',
  KIENLONGBANK: '970452',
  'SHINHAN BANK': '970424',
  SHINHANBANK: '970424',
  TECHCOMBANK: '970407',
  MBBANK: '970422',
  VPBANK: '970432',
  SACOMBANK: '970403',
  TPBANK: '970423',
  OCB: '970448',
  HDBANK: '970437',
  VIB: '970441',
  SHB: '970443',
  MSB: '970426',
  SEABANK: '970440',
  LPBANK: '970449'
};

/**
 * Hàm lấy PayOS bank code từ tên ngân hàng.
 * Chuẩn hóa tên: bỏ dấu tiếng Việt, viết HOA.
 * @param bankName Tên ngân hàng (có thể có dấu, không phân biệt HOA/thường)
 * @returns Mã PayOS bank code hoặc fallback là chuỗi rỗng nếu không tìm thấy
 */
export function getPayosBankCode(bankName: string): string {
  if (!bankName) return '';
  const normalized = bankName.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
  return PAYOS_BANK_CODE_MAP[normalized] ?? '';
}
