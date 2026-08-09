import { getLogger } from '../config/logger';

const logger = getLogger();
const MAX_IPFS_PAYLOAD_BYTES = 512 * 1024;
const MAX_IPFS_CID_LENGTH = 256;
const DEFAULT_TIMEOUT_MS_PER_GATEWAY = 5_000;
const DEFAULT_MAX_GATEWAYS = 2;
const DEFAULT_GATEWAY_URLS = [
  'https://ipfs.io/ipfs',
  'https://gateway.pinata.cloud/ipfs',
  'https://cloudflare-ipfs.com/ipfs'
] as const;
let defaultGatewayUrlsCache: string[] | null = null;

export interface IpfsFetchOptions {
  timeoutMsPerGateway?: number;
  maxGateways?: number;
  gatewayUrls?: string[];
}

type IpfsGatewayErrorCode = 'IPFS_TIMEOUT' | 'IPFS_UNAVAILABLE' | 'IPFS_PAYLOAD_TOO_LARGE';

/** Lỗi có mã ổn định để service phân biệt timeout IPFS với lỗi hệ thống khác. */
export class IpfsGatewayError extends Error {
  public readonly code: IpfsGatewayErrorCode;

  public constructor(message: string, code: IpfsGatewayErrorCode) {
    super(message);
    this.name = 'IpfsGatewayError';
    this.code = code;
  }
}

/** Kiểm tra CID đã tách khỏi URI để chỉ còn một path segment an toàn. */
function validateNormalizedCid(cid: string): string {
  const normalizedCid = cid.trim();
  if (
    !normalizedCid
    || normalizedCid.length > MAX_IPFS_CID_LENGTH
    || /[\s\\/?#]/.test(normalizedCid)
  ) {
    throw new IpfsGatewayError('CID IPFS không hợp lệ.', 'IPFS_UNAVAILABLE');
  }
  return normalizedCid;
}

/** Chuẩn hóa CID từ URI ipfs, CID thuần hoặc URL gateway thành một giá trị an toàn để ghép URL. */
export function normalizeIpfsCid(cidOrUri: string): string {
  const value = cidOrUri.trim();
  if (!value) {
    throw new IpfsGatewayError('CID IPFS không được để trống.', 'IPFS_UNAVAILABLE');
  }

  if (value.startsWith('ipfs://')) {
    const cid = value.slice('ipfs://'.length).split(/[/?#]/, 1)[0];
    if (cid) {
      try {
        return validateNormalizedCid(decodeURIComponent(cid));
      } catch (error) {
        if (error instanceof IpfsGatewayError) throw error;
        throw new IpfsGatewayError('URI IPFS không hợp lệ.', 'IPFS_UNAVAILABLE');
      }
    }
  }

  if (value.startsWith('http://') || value.startsWith('https://')) {
    const parsedUrl = new URL(value);
    const ipfsPathIndex = parsedUrl.pathname.indexOf('/ipfs/');
    if (ipfsPathIndex >= 0) {
      const cid = parsedUrl.pathname.slice(ipfsPathIndex + '/ipfs/'.length).split('/', 1)[0];
      if (cid) {
        try {
          return validateNormalizedCid(decodeURIComponent(cid));
        } catch (error) {
          if (error instanceof IpfsGatewayError) throw error;
          throw new IpfsGatewayError('URI IPFS không hợp lệ.', 'IPFS_UNAVAILABLE');
        }
      }
    }
  }

  if (!value.includes('/') && !value.includes('?') && !value.includes('#')) {
    return validateNormalizedCid(value);
  }

  throw new IpfsGatewayError('URI IPFS không hợp lệ.', 'IPFS_UNAVAILABLE');
}

/** Lấy danh sách gateway theo cấu hình mới, tương thích biến IPFS_GATEWAY_URL cũ. */
function resolveGatewayUrls(options?: IpfsFetchOptions): string[] {
  if (!options?.gatewayUrls && defaultGatewayUrlsCache) {
    return defaultGatewayUrlsCache;
  }

  const configuredUrls = options?.gatewayUrls
    ?? process.env.IPFS_GATEWAY_URLS?.split(',')
    ?? (process.env.IPFS_GATEWAY_URL ? [process.env.IPFS_GATEWAY_URL] : undefined)
    ?? [...DEFAULT_GATEWAY_URLS];

  const normalizedUrls = configuredUrls
    .map(url => {
      try {
        const parsedUrl = new URL(url.trim());
        const isLocalDevelopmentHttp = process.env.NODE_ENV !== 'production'
          && parsedUrl.protocol === 'http:'
          && ['localhost', '127.0.0.1', '[::1]'].includes(parsedUrl.hostname);
        if (
          (parsedUrl.protocol !== 'https:' && !isLocalDevelopmentHttp)
          || parsedUrl.username
          || parsedUrl.password
          || parsedUrl.search
          || parsedUrl.hash
        ) {
          return null;
        }
        return parsedUrl.toString().replace(/\/$/, '');
      } catch {
        return null;
      }
    })
    .filter((url): url is string => Boolean(url));
  const resolvedUrls = normalizedUrls.length > 0 ? normalizedUrls : [...DEFAULT_GATEWAY_URLS];
  if (!options?.gatewayUrls) {
    defaultGatewayUrlsCache = resolvedUrls;
  }
  return resolvedUrls;
}

/** Tạo AbortSignal timeout cho từng gateway mà không chia sẻ timeout giữa các request fallback. */
function createTimeoutSignal(timeoutMs: number): AbortSignal {
  if (typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(timeoutMs);
  }

  const controller = new AbortController();
  setTimeout(() => controller.abort(), timeoutMs);
  return controller.signal;
}

/** Lấy mã lỗi ổn định từ lỗi fetch/AbortSignal để log và degrade đúng ở API layer. */
function classifyIpfsError(error: unknown): IpfsGatewayErrorCode {
  if (error instanceof IpfsGatewayError) return error.code;
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return 'IPFS_TIMEOUT';
  }
  return 'IPFS_UNAVAILABLE';
}

/** Kiểm tra Content-Length trước khi đọc body để chặn gateway trả payload quá lớn. */
function assertContentLengthWithinLimit(response: Response): void {
  const contentLength = response.headers.get('content-length');
  const parsedContentLength = contentLength === null ? null : Number(contentLength);
  if (parsedContentLength !== null && (!Number.isFinite(parsedContentLength) || parsedContentLength < 0)) {
    throw new IpfsGatewayError('Metadata IPFS có Content-Length không hợp lệ.', 'IPFS_UNAVAILABLE');
  }
  if (parsedContentLength !== null && parsedContentLength > MAX_IPFS_PAYLOAD_BYTES) {
    throw new IpfsGatewayError('Metadata IPFS vượt quá giới hạn kích thước.', 'IPFS_PAYLOAD_TOO_LARGE');
  }
}

/** Đọc response body theo stream và dừng ngay khi payload vượt giới hạn bộ nhớ cho phép. */
async function readResponseBodyWithinLimit(response: Response): Promise<Buffer> {
  assertContentLengthWithinLimit(response);
  if (!response.body) {
    const body = await response.arrayBuffer();
    if (body.byteLength > MAX_IPFS_PAYLOAD_BYTES) {
      throw new IpfsGatewayError('Payload IPFS vượt quá giới hạn kích thước.', 'IPFS_PAYLOAD_TOO_LARGE');
    }
    return Buffer.from(body);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let streamDone = false;
  try {
    while (!streamDone) {
      const { done, value } = await reader.read();
      if (done) {
        streamDone = true;
        continue;
      }
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_IPFS_PAYLOAD_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new IpfsGatewayError('Payload IPFS vượt quá giới hạn kích thước.', 'IPFS_PAYLOAD_TOO_LARGE');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = Buffer.allocUnsafe(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/** Thực hiện fetch tuần tự qua số gateway giới hạn và trả kết quả từ gateway đầu tiên thành công. */
async function fetchWithGatewayFallback<T>(
  cidOrUri: string,
  options: IpfsFetchOptions | undefined,
  parseResponse: (response: Response) => Promise<T>
): Promise<T> {
  const cid = normalizeIpfsCid(cidOrUri);
  const timeoutMs = Math.max(1, Math.floor(options?.timeoutMsPerGateway ?? DEFAULT_TIMEOUT_MS_PER_GATEWAY));
  const gateways = resolveGatewayUrls(options);
  const maxGateways = Math.min(
    gateways.length,
    Math.max(1, Math.floor(options?.maxGateways ?? DEFAULT_MAX_GATEWAYS))
  );
  let lastError: unknown = new IpfsGatewayError('Không có IPFS gateway khả dụng.', 'IPFS_UNAVAILABLE');

  for (const gateway of gateways.slice(0, maxGateways)) {
    const gatewayUrl = `${gateway}/${encodeURIComponent(cid)}`;
    try {
      const response = await fetch(gatewayUrl, {
        signal: createTimeoutSignal(timeoutMs),
        headers: { accept: 'application/json, application/octet-stream' },
        redirect: 'error'
      });
      assertContentLengthWithinLimit(response);
      if (!response.ok) {
        throw new IpfsGatewayError(`IPFS gateway trả HTTP ${response.status}.`, 'IPFS_UNAVAILABLE');
      }
      return await parseResponse(response);
    } catch (error) {
      lastError = new IpfsGatewayError(
        error instanceof Error ? error.message : 'Không thể đọc IPFS metadata.',
        classifyIpfsError(error)
      );
      let gatewayHost = gateway;
      try {
        gatewayHost = new URL(gateway).host;
      } catch {
        // Giữ lại giá trị cấu hình để log chẩn đoán khi gateway URL không hợp lệ.
      }
      logger.warn('IPFS gateway request thất bại.', { gatewayHost, cid, errorCode: (lastError as IpfsGatewayError).code });
    }
  }

  throw lastError;
}

/** Đọc JSON metadata từ IPFS với timeout và fallback gateway tuần tự. */
export async function fetchJsonFromIpfs<T = unknown>(
  cidOrUri: string,
  options?: IpfsFetchOptions
): Promise<T> {
  return fetchWithGatewayFallback(cidOrUri, options, async response => {
    const body = await readResponseBodyWithinLimit(response);
    return JSON.parse(new TextDecoder().decode(body)) as T;
  });
}

/** Đọc binary buffer từ IPFS với cùng size guard và fallback như JSON metadata. */
export async function fetchBufferFromIpfs(
  cidOrUri: string,
  options?: IpfsFetchOptions
): Promise<Buffer> {
  return fetchWithGatewayFallback(cidOrUri, options, readResponseBodyWithinLimit);
}

/** Tạo URL gateway công khai để frontend render ảnh/metadata trực tiếp từ CID. */
export function buildIpfsGatewayUrl(cidOrUri: string): string {
  const cid = normalizeIpfsCid(cidOrUri);
  const gateway = resolveGatewayUrls({ maxGateways: 1 })[0];
  return `${gateway}/${encodeURIComponent(cid)}`;
}
