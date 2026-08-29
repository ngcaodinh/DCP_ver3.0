/**
 * Hàm trích xuất Bearer token từ Authorization header.
 * Mục đích: chuẩn hóa cách đọc Bearer token cho cả user JWT và guest JWT.
 * Dùng chung cho authenticationMiddleware và guestAuthMiddleware.
 */
export function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) {
    return null;
  }

  // RFC 9110 quy định scheme không phân biệt hoa thường; chuẩn hóa khoảng trắng
  // để token không bị xem là thiếu khi request đi qua reverse proxy.
  const [scheme, ...tokenParts] = authHeader.trim().split(/\s+/);
  if (scheme?.toLowerCase() !== 'bearer' || tokenParts.length === 0) {
    return null;
  }

  const token = tokenParts.join(' ').trim();
  return token || null;
}
