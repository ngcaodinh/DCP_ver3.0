/** Thời gian watchdog cho mỗi gateway ảnh SBT trước khi chuyển fallback. */
export const SBT_IMAGE_TIMEOUT_MS = 8_000;

/** Giới hạn số gateway ảnh được thử trong một card để tránh chờ quá lâu. */
export const SBT_IMAGE_MAX_GATEWAYS = 2;

/** Kích thước trang phải khớp trần limit 20 của backend C4/C5. */
export const SBT_GALLERY_PAGE_SIZE = 20;

/** Trang tối đa phải khớp BE/src/constants/sbtGallery.ts để deep-link không tạo lỗi 400. */
export const SBT_GALLERY_MAX_PAGE = 500;

/** Số skeleton hiển thị trong lần tải đầu để giữ ổn định bố cục gallery. */
export const SBT_GALLERY_SKELETON_COUNT = 8;

/** Chuẩn hóa trang từ URL hoặc hook về contract pagination công khai của gallery. */
export function normalizeImpactSbtGalleryPage(value: unknown): number {
  const numericValue = typeof value === 'number' || typeof value === 'string'
    ? Number(value)
    : Number.NaN;
  if (!Number.isInteger(numericValue) || numericValue < 1) {
    return 1;
  }
  return Math.min(numericValue, SBT_GALLERY_MAX_PAGE);
}
