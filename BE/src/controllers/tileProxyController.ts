import type { Request, Response } from 'express';
import { getLogger } from '../config/logger';
import { createInMemoryCache } from '../utils/inMemoryCache';

const logger = getLogger();
const TILE_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;
const TILE_CACHE_MAX_ENTRIES = 1024;
const TILE_FETCH_TIMEOUT_MS = 8_000;
const MAX_TILE_SIZE_BYTES = 512 * 1024;
const CARTO_TILE_SUBDOMAINS = ['a', 'b', 'c', 'd'] as const;
const ADMINISTRATIVE_MAP_WMS_URL = 'https://cache.bando.com.vn/service?';
const ADMINISTRATIVE_MAP_WMS_LAYERS = 'vietnam_2026,vietnam_label_2026';
const ADMINISTRATIVE_MAP_MAX_ZOOM = 16;
const WEB_MERCATOR_WORLD_WIDTH_METERS = 40_075_016.68557849;
const WEB_MERCATOR_ORIGIN_METERS = WEB_MERCATOR_WORLD_WIDTH_METERS / 2;
const TILE_SIZE_PIXELS = 256;
const tileCache = createInMemoryCache<Buffer>({ maxEntries: TILE_CACHE_MAX_ENTRIES });
const pendingTileRequests = new Map<string, Promise<Buffer>>();
const administrativeTileCache = createInMemoryCache<Buffer>({ maxEntries: TILE_CACHE_MAX_ENTRIES });
const pendingAdministrativeTileRequests = new Map<string, Promise<Buffer>>();

type TileCoordinates = {
  z: number;
  x: number;
  y: number;
};

/**
 * Lỗi có kiểm soát khi nhà cung cấp bản đồ không thể trả tile hợp lệ.
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
 * Kiểm tra z/x/y thuộc phạm vi tile raster trước khi tạo outbound request.
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
 * Kiểm tra tile thuộc mức zoom được công bố cho lớp địa giới hành chính năm 2026.
 * @param parameters Path parameters z, x và y từ Express.
 * @returns Tọa độ tile hợp lệ hoặc lỗi mô tả dữ liệu không hợp lệ.
 */
function validateAdministrativeTileCoordinates(parameters: Request['params']): TileCoordinates | TileProxyError {
  const coordinatesOrError = validateTileCoordinates(parameters);
  if (coordinatesOrError instanceof TileProxyError) {
    return coordinatesOrError;
  }

  if (coordinatesOrError.z > ADMINISTRATIVE_MAP_MAX_ZOOM) {
    return new TileProxyError(400, 'Invalid administrative map zoom level');
  }

  return coordinatesOrError;
}

/**
 * Chuyển tọa độ tile XYZ sang bounding box Web Mercator để gọi lớp WMS chính thức.
 * @param coordinates Tọa độ tile XYZ đã được kiểm tra.
 * @returns Bounding box theo thứ tự minX, minY, maxX, maxY.
 */
function getWebMercatorTileBoundingBox(coordinates: TileCoordinates): string {
  const tileWidthMeters = WEB_MERCATOR_WORLD_WIDTH_METERS / 2 ** coordinates.z;
  const minX = -WEB_MERCATOR_ORIGIN_METERS + coordinates.x * tileWidthMeters;
  const maxX = minX + tileWidthMeters;
  const maxY = WEB_MERCATOR_ORIGIN_METERS - coordinates.y * tileWidthMeters;
  const minY = maxY - tileWidthMeters;

  return [minX, minY, maxX, maxY].join(',');
}

/**
 * Tạo URL WMS cố định cho lớp địa giới và nhãn tỉnh/thành sau sáp nhập.
 * @param coordinates Tọa độ tile XYZ đã được kiểm tra.
 * @returns URL WMS không chứa dữ liệu do người dùng kiểm soát.
 */
function buildAdministrativeMapTileUrl(coordinates: TileCoordinates): string {
  const searchParameters = new URLSearchParams({
    SERVICE: 'WMS',
    REQUEST: 'GetMap',
    VERSION: '1.1.1',
    LAYERS: ADMINISTRATIVE_MAP_WMS_LAYERS,
    STYLES: '',
    FORMAT: 'image/png',
    TRANSPARENT: 'TRUE',
    SRS: 'EPSG:3857',
    WIDTH: String(TILE_SIZE_PIXELS),
    HEIGHT: String(TILE_SIZE_PIXELS),
    BBOX: getWebMercatorTileBoundingBox(coordinates)
  });

  return `${ADMINISTRATIVE_MAP_WMS_URL}${searchParameters.toString()}`;
}

/**
 * Tải một tile PNG từ Carto và chỉ cache phản hồi hợp lệ có kích thước giới hạn.
 * @param coordinates Tọa độ tile đã được kiểm tra.
 * @param cacheKey Key cache tương ứng với tọa độ tile.
 * @returns Buffer ảnh PNG từ nhà cung cấp bản đồ.
 */
async function fetchAndCacheCartoTile(
  coordinates: TileCoordinates,
  cacheKey: string
): Promise<Buffer> {
  const subdomain = CARTO_TILE_SUBDOMAINS[Math.floor(Math.random() * CARTO_TILE_SUBDOMAINS.length)];
  const tileUrl = `https://${subdomain}.basemaps.cartocdn.com/rastertiles/voyager/${coordinates.z}/${coordinates.x}/${coordinates.y}.png`;
  const response = await fetch(tileUrl, {
    headers: {
      'User-Agent': 'DCP-Map-Tile-Proxy/1.0'
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
 * Lấy tile từ cache hoặc gộp các request đồng thời để chỉ tạo một outbound request tới Carto.
 * @param coordinates Tọa độ tile đã được kiểm tra.
 * @returns Buffer PNG đã cache hoặc vừa tải từ OpenStreetMap.
 */
async function getTileBuffer(coordinates: TileCoordinates): Promise<Buffer> {
  // Tách cache của lớp có nhãn khỏi tile `voyager_nolabels` đã được lưu trước đó.
  const cacheKey = `voyager:${coordinates.z}/${coordinates.x}/${coordinates.y}`;
  const cachedTile = tileCache.get(cacheKey);
  if (cachedTile) {
    return cachedTile;
  }

  const pendingTileRequest = pendingTileRequests.get(cacheKey);
  if (pendingTileRequest) {
    return pendingTileRequest;
  }

  const tileRequest = fetchAndCacheCartoTile(coordinates, cacheKey);
  pendingTileRequests.set(cacheKey, tileRequest);

  try {
    return await tileRequest;
  } finally {
    pendingTileRequests.delete(cacheKey);
  }
}

/**
 * Tải tile địa giới hành chính chính thức, cache riêng và gộp request đồng thời.
 * @param coordinates Tọa độ tile XYZ đã được kiểm tra.
 * @returns Buffer PNG của lớp địa giới và nhãn hành chính.
 */
async function getAdministrativeTileBuffer(coordinates: TileCoordinates): Promise<Buffer> {
  const cacheKey = `administrative-2026:${coordinates.z}/${coordinates.x}/${coordinates.y}`;
  const cachedTile = administrativeTileCache.get(cacheKey);
  if (cachedTile) {
    return cachedTile;
  }

  const pendingTileRequest = pendingAdministrativeTileRequests.get(cacheKey);
  if (pendingTileRequest) {
    return pendingTileRequest;
  }

  const tileRequest = (async (): Promise<Buffer> => {
    const response = await fetch(buildAdministrativeMapTileUrl(coordinates), {
      headers: { 'User-Agent': 'DCP-Map-Tile-Proxy/1.0' },
      signal: AbortSignal.timeout(TILE_FETCH_TIMEOUT_MS)
    });

    if (!response.ok) {
      throw new TileProxyError(response.status, 'Administrative map tile not found');
    }

    const contentType = response.headers.get('content-type')?.toLowerCase();
    if (!contentType?.startsWith('image/png')) {
      throw new TileProxyError(502, 'Administrative map provider returned unsupported content');
    }

    const contentLength = response.headers.get('content-length');
    if (contentLength !== null && Number(contentLength) > MAX_TILE_SIZE_BYTES) {
      throw new TileProxyError(502, 'Administrative map provider returned an oversized response');
    }

    const tileBuffer = Buffer.from(await response.arrayBuffer());
    if (tileBuffer.byteLength > MAX_TILE_SIZE_BYTES) {
      throw new TileProxyError(502, 'Administrative map provider returned an oversized response');
    }

    administrativeTileCache.set(cacheKey, tileBuffer, TILE_CACHE_TTL_SECONDS);
    return tileBuffer;
  })();
  pendingAdministrativeTileRequests.set(cacheKey, tileRequest);

  try {
    return await tileRequest;
  } finally {
    pendingAdministrativeTileRequests.delete(cacheKey);
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
 * Proxy tile Carto để browser không gọi provider trực tiếp.
 * Proxy che địa chỉ IP của người dùng khỏi Carto, nhưng Carto vẫn nhận z/x/y; không phải cơ chế
 * bảo mật vị trí tuyệt đối. Route: GET /api/tiles/:z/:x/:y.png
 * @param request Express request chứa tọa độ tile.
 * @param response Express response trả PNG hoặc lỗi an toàn.
 */
export async function proxyMapTile(request: Request, response: Response): Promise<void> {
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
 * Proxy lớp địa giới và tên tỉnh/thành sau sáp nhập để frontend vẽ trên bản đồ geofence.
 * @param request Express request chứa tọa độ tile.
 * @param response Express response trả PNG hoặc lỗi an toàn.
 */
export async function proxyAdministrativeMapTile(request: Request, response: Response): Promise<void> {
  const coordinatesOrError = validateAdministrativeTileCoordinates(request.params);
  if (coordinatesOrError instanceof TileProxyError) {
    response.status(coordinatesOrError.statusCode).json({ error: coordinatesOrError.message });
    return;
  }

  try {
    const tileBuffer = await getAdministrativeTileBuffer(coordinatesOrError);
    sendTileResponse(response, tileBuffer);
  } catch (error) {
    const statusCode = error instanceof TileProxyError ? error.statusCode : 502;
    const message = error instanceof TileProxyError ? error.message : 'Failed to fetch administrative map tile';

    logger.error('Administrative map tile proxy error.', { status: statusCode, errorMessage: message });
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
  administrativeTileCache.clearAll();
  pendingAdministrativeTileRequests.clear();
}
