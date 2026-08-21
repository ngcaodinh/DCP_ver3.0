import type { Request, Response } from 'express';
import { createInMemoryCache } from '../utils/inMemoryCache';
import { sendErrorResponse, sendSuccessResponse } from '../utils/apiResponse';

const LOCATION_SEARCH_URL = 'https://nominatim.openstreetmap.org/search';
const LOCATION_SEARCH_MIN_QUERY_LENGTH = 3;
const LOCATION_SEARCH_MAX_QUERY_LENGTH = 120;
const LOCATION_SEARCH_DEFAULT_LIMIT = 5;
const LOCATION_SEARCH_MAX_LIMIT = 5;
const LOCATION_SEARCH_CACHE_TTL_SECONDS = 24 * 60 * 60;
const LOCATION_SEARCH_CACHE_MAX_ENTRIES = 500;
const LOCATION_SEARCH_MIN_INTERVAL_MS = 1_000;
const LOCATION_SEARCH_TIMEOUT_MS = 8_000;

export interface LocationSearchResult {
  id: number;
  displayName: string;
  point: {
    lat: number;
    lng: number;
  };
}

class LocationSearchError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly errorCode: string,
    message: string
  ) {
    super(message);
    this.name = 'LocationSearchError';
  }
}

const locationSearchCache = createInMemoryCache<LocationSearchResult[]>({
  maxEntries: LOCATION_SEARCH_CACHE_MAX_ENTRIES
});
let lastLocationSearchRequestAt = 0;

/** Chuẩn hóa số lượng kết quả, chỉ chấp nhận giá trị nhỏ để giới hạn tải outbound. */
function parseResultLimit(value: unknown): number {
  const parsedValue = Number(value);
  if (!Number.isInteger(parsedValue) || parsedValue < 1) {
    return LOCATION_SEARCH_DEFAULT_LIMIT;
  }

  return Math.min(parsedValue, LOCATION_SEARCH_MAX_LIMIT);
}

/** Lọc dữ liệu geocoding không tin cậy thành dữ liệu tối thiểu mà frontend cần hiển thị. */
function parseLocationSearchResults(payload: unknown): LocationSearchResult[] {
  if (!Array.isArray(payload)) {
    return [];
  }

  return payload.flatMap((item): LocationSearchResult[] => {
    if (!item || typeof item !== 'object') {
      return [];
    }

    const rawItem = item as Record<string, unknown>;
    const id = Number(rawItem.place_id);
    const lat = Number(rawItem.lat);
    const lng = Number(rawItem.lon);
    const displayName = typeof rawItem.display_name === 'string' ? rawItem.display_name.trim() : '';

    if (!Number.isSafeInteger(id) || !Number.isFinite(lat) || !Number.isFinite(lng) || !displayName) {
      return [];
    }

    return [{ id, displayName, point: { lat, lng } }];
  });
}

/** Gọi nhà cung cấp geocoding với nhịp tối đa một request/giây để tuân thủ chính sách công khai. */
async function fetchLocationSearchResults(query: string, limit: number): Promise<LocationSearchResult[]> {
  const cacheKey = `${query.toLocaleLowerCase('vi-VN')}:${limit}`;
  const cachedResults = locationSearchCache.get(cacheKey);
  if (cachedResults) {
    return cachedResults;
  }

  const now = Date.now();
  if (now - lastLocationSearchRequestAt < LOCATION_SEARCH_MIN_INTERVAL_MS) {
    throw new LocationSearchError(429, 'LOCATION_SEARCH_THROTTLED', 'Vui lòng chờ một giây trước khi tìm lại.');
  }
  lastLocationSearchRequestAt = now;

  const searchUrl = new URL(LOCATION_SEARCH_URL);
  searchUrl.searchParams.set('format', 'jsonv2');
  searchUrl.searchParams.set('limit', String(limit));
  searchUrl.searchParams.set('q', query);

  const providerResponse = await fetch(searchUrl.toString(), {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'DCP-Geofence-Search/1.0'
    },
    signal: AbortSignal.timeout(LOCATION_SEARCH_TIMEOUT_MS)
  });

  if (!providerResponse.ok) {
    throw new LocationSearchError(502, 'LOCATION_SEARCH_UNAVAILABLE', 'Không thể tìm địa điểm lúc này. Vui lòng thử lại.');
  }

  const results = parseLocationSearchResults(await providerResponse.json());
  locationSearchCache.set(cacheKey, results, LOCATION_SEARCH_CACHE_TTL_SECONDS);
  return results;
}

/**
 * Tìm địa điểm qua proxy backend để kiểm soát giới hạn, cache và dữ liệu trả về.
 * @param request Request có query q và limit.
 * @param response Response chuẩn hóa danh sách vị trí.
 */
export async function searchLocations(request: Request, response: Response): Promise<void> {
  const query = typeof request.query.q === 'string' ? request.query.q.trim() : '';
  if (query.length < LOCATION_SEARCH_MIN_QUERY_LENGTH || query.length > LOCATION_SEARCH_MAX_QUERY_LENGTH) {
    sendErrorResponse(
      response,
      400,
      `Từ khóa tìm kiếm phải có từ ${LOCATION_SEARCH_MIN_QUERY_LENGTH} đến ${LOCATION_SEARCH_MAX_QUERY_LENGTH} ký tự.`,
      'VALIDATION_ERROR'
    );
    return;
  }

  try {
    const results = await fetchLocationSearchResults(query, parseResultLimit(request.query.limit));
    sendSuccessResponse(response, 200, 'Tìm địa điểm thành công.', results);
  } catch (error) {
    if (error instanceof LocationSearchError) {
      sendErrorResponse(response, error.statusCode, error.message, error.errorCode);
      return;
    }

    sendErrorResponse(response, 502, 'Không thể tìm địa điểm lúc này. Vui lòng thử lại.', 'LOCATION_SEARCH_UNAVAILABLE');
  }
}

/** Reset trạng thái cache và throttle, chỉ dùng để cô lập test. */
export function __resetLocationSearchState(): void {
  locationSearchCache.clearAll();
  lastLocationSearchRequestAt = 0;
}
