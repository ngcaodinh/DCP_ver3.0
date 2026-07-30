import type { Request, Response } from 'express';
import { getLogger } from '../config/logger';
import { createInMemoryCache } from '../utils/inMemoryCache';

const logger = getLogger();
const TILE_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;
const TILE_CACHE_MAX_ENTRIES = 128;
const TILE_FETCH_TIMEOUT_MS = 8_000;
const MAX_TILE_SIZE_BYTES = 512 * 1024;
const OSM_TILE_SUBDOMAINS = ['a', 'b', 'c'] as const;
const tileCache = createInMemoryCache<Buffer>({ maxEntries: TILE_CACHE_MAX_ENTRIES });
const pendingTileRequests = new Map<string, Promise<Buffer>>();

type TileCoordinates = {
  z: number;
  x: number;
  y: number;
};

/**
 * Lỗi có kiểm soát khi OpenStreetMap không thể trả tile hợp lệ.
 * @param statusCode HTTP status code an toàn để trả về client.
 * @param message Thông điệp lỗi không chứa dữ liệu vị trí.
 */
class TileProxyError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string
  ) {
    super(message);
    this.name = 'TileProxyError';
  }
}

/**
 * Chuyển chuỗi path parameter thành chỉ số tile nguyên, không âm.
 * @param value Giá trị path parameter cần kiểm tra.
 * @returns Chỉ số tile hợp lệ hoặc null khi dữ liệu không hợp lệ.
 */
function parseTileCoordinate(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) {
    return null;
  }

  const coordinate = Number(value);
  return Number.isSafeInteger(coordinate) ? coordinate : null;
}

/**
 * Kiểm tra z/x/y thuộc phạm vi tile OSM trước khi tạo outbound request.
 * @param parameters Path parameters z, x và y từ Express.
 * @returns Tọa độ tile đã chuẩn hóa hoặc lỗi mô tả dữ liệu không hợp lệ.
 */
function validateTileCoordinates(parameters: Request['params']): TileCoordinates | TileProxyError {
  const z = parseTileCoordinate(parameters.z);
  const x = parseTileCoordinate(parameters.x);
  const y = parseTileCoordinate(parameters.y);

  if (z === null || x === null || y === null) {
    return new TileProxyError(400, 'Invalid tile coordinates');
  }

  if (z > 19) {
    return new TileProxyError(400, 'Invalid zoom level');
  }

  const maxTileIndex = 2 ** z - 1;
  if (x > maxTileIndex || y > maxTileIndex) {
    return new TileProxyError(400, 'Tile coordinates out of bounds');
  }

  return { z, x, y };
}

/**
 * Tải một tile PNG từ OpenStreetMap và chỉ cache phản hồi hợp lệ có kích thước giới hạn.
 * @param coordinates Tọa độ tile đã được kiểm tra.
 * @param cacheKey Key cache tương ứng với tọa độ tile.
 * @returns Buffer ảnh PNG từ nhà cung cấp bản đồ.
 */
async function fetchAndCacheOsmTile(
  coordinates: TileCoordinates,
  cacheKey: string
): Promise<Buffer> {
  const subdomain = OSM_TILE_SUBDOMAINS[Math.floor(Math.random() * OSM_TILE_SUBDOMAINS.length)];
  const tileUrl = `https://${subdomain}.tile.openstreetmap.org/${coordinates.z}/${coordinates.x}/${coordinates.y}.png`;
  const response = await fetch(tileUrl, {
    headers: {
      'User-Agent': 'DCP-Oracle-System/1.0 (contact: admin@dcp.example.com)'
    },
    signal: AbortSignal.timeout(TILE_FETCH_TIMEOUT_MS)
  });

  if (!response.ok) {
    throw new TileProxyError(response.status, 'Tile not found');
  }

  const contentType = response.headers.get('content-type')?.toLowerCase();
  if (!contentType?.startsWith('image/png')) {
    throw new TileProxyError(502, 'Tile provider returned unsupported content');
  }

  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && Number(contentLength) > MAX_TILE_SIZE_BYTES) {
    throw new TileProxyError(502, 'Tile provider returned an oversized response');
  }

  const tileBuffer = Buffer.from(await response.arrayBuffer());
  if (tileBuffer.byteLength > MAX_TILE_SIZE_BYTES) {
    throw new TileProxyError(502, 'Tile provider returned an oversized response');
  }

  tileCache.set(cacheKey, tileBuffer, TILE_CACHE_TTL_SECONDS);
  return tileBuffer;
}

/**
 * Lấy tile từ cache hoặc gộp các request đồng thời để chỉ tạo một outbound request tới OSM.
 * @param coordinates Tọa độ tile đã được kiểm tra.
 * @returns Buffer PNG đã cache hoặc vừa tải từ OpenStreetMap.
 */
async function getTileBuffer(coordinates: TileCoordinates): Promise<Buffer> {
  const cacheKey = `${coordinates.z}/${coordinates.x}/${coordinates.y}`;
  const cachedTile = tileCache.get(cacheKey);
  if (cachedTile) {
    return cachedTile;
  }

  const pendingTileRequest = pendingTileRequests.get(cacheKey);
  if (pendingTileRequest) {
    return pendingTileRequest;
  }

  const tileRequest = fetchAndCacheOsmTile(coordinates, cacheKey);
  pendingTileRequests.set(cacheKey, tileRequest);

  try {
    return await tileRequest;
  } finally {
    pendingTileRequests.delete(cacheKey);
  }
}

/**
 * Trả tile PNG với cache header phù hợp cho browser và CDN.
 * @param response Express response cần gửi ảnh.
 * @param tileBuffer Buffer PNG đã được cache hoặc tải từ OSM.
 */
function sendTileResponse(response: Response, tileBuffer: Buffer): void {
  response.set({
    'Content-Type': 'image/png',
    'Cache-Control': 'public, max-age=604800, immutable',
    'X-Tile-Proxy': 'DCP-Backend'
  });
  response.send(tileBuffer);
}

/**
 * Proxy tile OpenStreetMap để browser không gọi provider trực tiếp.
 * Proxy che địa chỉ IP của người dùng khỏi OSM, nhưng OSM vẫn nhận z/x/y; không phải cơ chế
 * bảo mật vị trí tuyệt đối. Route: GET /api/tiles/:z/:x/:y.png
 * @param request Express request chứa tọa độ tile.
 * @param response Express response trả PNG hoặc lỗi an toàn.
 */
export async function proxyOsmTile(request: Request, response: Response): Promise<void> {
  const coordinatesOrError = validateTileCoordinates(request.params);
  if (coordinatesOrError instanceof TileProxyError) {
    response.status(coordinatesOrError.statusCode).json({ error: coordinatesOrError.message });
    return;
  }

  try {
    const tileBuffer = await getTileBuffer(coordinatesOrError);
    sendTileResponse(response, tileBuffer);
  } catch (error) {
    const statusCode = error instanceof TileProxyError ? error.statusCode : 502;
    const message = error instanceof TileProxyError ? error.message : 'Failed to fetch tile';

    logger.error('Tile proxy error.', {
      status: statusCode,
      errorMessage: message
    });
    response.status(statusCode).json({ error: message });
  }
}

/**
 * Reset cache và request đang chờ của tile proxy, chỉ dùng cho test.
 * @returns Không trả về giá trị.
 */
export function __resetTileProxyCache(): void {
  tileCache.clearAll();
  pendingTileRequests.clear();
}
