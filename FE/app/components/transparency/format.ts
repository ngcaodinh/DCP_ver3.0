// =============================================================================
// format.ts — D4: Helper định dạng dùng chung cho trang Transparency Dashboard.
// Tách riêng để tránh lặp formatVnd ở nhiều component (DRY).
// =============================================================================

/** Bộ định dạng số VND theo locale vi-VN, khởi tạo một lần để tái sử dụng. */
const vndFormatter = new Intl.NumberFormat('vi-VN');

/**
 * Định dạng số tiền VND theo kiểu vi-VN (vd 1000000 → "1.000.000").
 *
 * @param amountValue Số tiền cần định dạng
 * @returns Chuỗi số đã định dạng theo locale vi-VN
 */
export function formatVnd(amountValue: number): string {
  return vndFormatter.format(amountValue);
}
