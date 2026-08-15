const DEFAULT_LOCAL_BACKEND_INTERNAL_URL = 'http://localhost:4000';
const INVALID_BACKEND_INTERNAL_URL_MESSAGE =
  'BACKEND_INTERNAL_URL must be an absolute HTTP(S) URL without credentials, path, query, or hash.';

/** Kiểm tra URL backend nội bộ chỉ chứa origin HTTP(S) an toàn cho request server-to-server. */
function parseBackendInternalUrl(configuredUrl: string): string {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(configuredUrl);
  } catch {
    throw new Error(INVALID_BACKEND_INTERNAL_URL_MESSAGE);
  }

  if (
    !['http:', 'https:'].includes(parsedUrl.protocol) ||
    parsedUrl.username ||
    parsedUrl.password ||
    parsedUrl.pathname !== '/' ||
    parsedUrl.search ||
    parsedUrl.hash
  ) {
    throw new Error(INVALID_BACKEND_INTERNAL_URL_MESSAGE);
  }

  return parsedUrl.origin;
}

/** Lấy URL backend nội bộ dành riêng cho các Server Component gọi API trong cùng Docker network. */
function getBackendInternalUrl(): string {
  const configuredUrl = process.env.BACKEND_INTERNAL_URL?.trim();
  if (configuredUrl) return parseBackendInternalUrl(configuredUrl);

  if (process.env.NODE_ENV === 'production') {
    throw new Error('Thiếu cấu hình BACKEND_INTERNAL_URL trong môi trường production.');
  }

  return DEFAULT_LOCAL_BACKEND_INTERNAL_URL;
}

/** Xây dựng URL backend nội bộ, không dùng cho request từ trình duyệt hoặc form public. */
export function buildServerApiUrl(pathname: string): string {
  const baseUrl = getBackendInternalUrl();
  const normalizedPathname = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return new URL(normalizedPathname, `${baseUrl}/`).toString();
}

/** Kiểm tra cấu hình backend nội bộ ngay khi Next.js Node runtime khởi động. */
export function validateServerApiConfig(): void {
  getBackendInternalUrl();
}
