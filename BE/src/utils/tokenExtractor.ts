/**
 * Hàm trích xuất Bearer token từ Authorization header.
 * Mục đích: chuẩn hóa cách đọc Bearer token cho cả user JWT và guest JWT.
 * Dùng chung cho authenticationMiddleware và guestAuthMiddleware.
 */
export function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  return authHeader.slice(7).trim();
}
