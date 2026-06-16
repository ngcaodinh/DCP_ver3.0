/**
 * Hàm extract error message — chuẩn hóa error logging từ ethers / Bull / Mongo / custom classes.
 * Mục đích: tái sử dụng ở nhiều service, tránh duplicate code và đảm bảo format log nhất quán.
 */
export function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const obj = error as Record<string, unknown>;
    const msg = obj.message ?? obj.errorMessage ?? obj.reason;
    if (typeof msg === 'string') return msg;
  }
  return String(error);
}
