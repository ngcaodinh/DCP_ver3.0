const DEPRECATED_POLYGON_AMOY_RPC_HOST = 'rpc-amoy.polygon.technology';
const POLYGON_AMOY_RPC_URL = 'https://polygon-amoy.drpc.org';

/** Chuẩn hóa endpoint RPC Amoy đã bị Polygon ngừng vận hành sang endpoint thay thế chính thức để các tiến trình backend không bị lỗi DNS. */
export function normalizeBlockchainRpcUrl(rpcUrlValue: string | undefined): string {
  const normalizedRpcUrl = rpcUrlValue?.trim() ?? '';
  if (!normalizedRpcUrl) {
    return '';
  }

  try {
    return new URL(normalizedRpcUrl).hostname === DEPRECATED_POLYGON_AMOY_RPC_HOST
      ? POLYGON_AMOY_RPC_URL
      : normalizedRpcUrl;
  } catch {
    return normalizedRpcUrl;
  }
}

/** Lấy RPC blockchain runtime đã được chuẩn hóa để bảo toàn cấu hình hợp lệ và tự chuyển endpoint Amoy cũ. */
export function getBlockchainRpcUrl(): string {
  return normalizeBlockchainRpcUrl(process.env.BLOCKCHAIN_RPC_URL);
}
