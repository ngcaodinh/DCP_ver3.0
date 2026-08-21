import type { Request, Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetLocationSearchState, searchLocations } from '../../controllers/locationSearchController';

/** Tạo request tìm địa điểm tối thiểu cho controller. */
function createRequest(query: Record<string, unknown>): Request {
  return { query } as unknown as Request;
}

/** Tạo response mock để kiểm tra envelope API mà không cần khởi động Express. */
function createResponse(): {
  response: Response;
  statusMock: ReturnType<typeof vi.fn>;
  jsonMock: ReturnType<typeof vi.fn>;
} {
  const jsonMock = vi.fn();
  const responseObject = {
    status: vi.fn(),
    json: jsonMock
  };
  const statusMock = responseObject.status.mockImplementation(() => responseObject);

  return {
    response: responseObject as unknown as Response,
    statusMock,
    jsonMock
  };
}

describe('locationSearchController', () => {
  beforeEach(() => {
    __resetLocationSearchState();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('trả 400 và không gọi provider khi từ khóa không hợp lệ', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { response, statusMock, jsonMock } = createResponse();

    await searchLocations(createRequest({ q: 'ab' }), response);

    expect(statusMock).toHaveBeenCalledWith(400);
    expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'VALIDATION_ERROR' }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'thiếu từ khóa', query: {} },
    { name: 'từ khóa không phải chuỗi', query: { q: ['Hà Nội'] } },
    { name: 'chỉ có khoảng trắng', query: { q: '   ' } },
    { name: 'vượt giới hạn 120 ký tự', query: { q: 'a'.repeat(121) } }
  ])('trả 400 khi $name', async ({ query }) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { response, statusMock, jsonMock } = createResponse();

    await searchLocations(createRequest(query), response);

    expect(statusMock).toHaveBeenCalledWith(400);
    expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'VALIDATION_ERROR' }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('trả dữ liệu đã lọc và giới hạn kết quả từ provider', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify([
      { place_id: 123, display_name: 'Chợ Bến Thành', lat: '10.7725', lon: '106.6980' },
      { place_id: 'invalid', display_name: 'Không hợp lệ', lat: '10', lon: '106' }
    ]), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const { response, statusMock, jsonMock } = createResponse();

    await searchLocations(createRequest({ q: 'Chợ Bến Thành', limit: '99' }), response);

    expect(statusMock).toHaveBeenCalledWith(200);
    expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      data: [{ id: 123, displayName: 'Chợ Bến Thành', point: { lat: 10.7725, lng: 106.698 } }]
    }));
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('limit=5'),
      expect.objectContaining({ headers: expect.objectContaining({ 'User-Agent': 'DCP-Geofence-Search/1.0' }) })
    );
  });

  it('dùng cache cho từ khóa giống nhau để không gọi provider lần hai', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('[]', {
      status: 200,
      headers: { 'content-type': 'application/json' }
    }));
    vi.stubGlobal('fetch', fetchMock);

    await searchLocations(createRequest({ q: 'Hà Nội' }), createResponse().response);
    await searchLocations(createRequest({ q: 'Hà Nội' }), createResponse().response);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('dùng cache không phân biệt hoa thường cho cùng một địa điểm', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('[]', {
      status: 200,
      headers: { 'content-type': 'application/json' }
    }));
    vi.stubGlobal('fetch', fetchMock);

    await searchLocations(createRequest({ q: 'Hà Nội' }), createResponse().response);
    await searchLocations(createRequest({ q: 'HÀ NỘI' }), createResponse().response);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(['0', '-1', '1.5', 'không-hợp-lệ'])('dùng limit mặc định khi limit=%s không hợp lệ', async limit => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('[]', {
      status: 200,
      headers: { 'content-type': 'application/json' }
    }));
    vi.stubGlobal('fetch', fetchMock);

    await searchLocations(createRequest({ q: 'Hà Nội', limit }), createResponse().response);

    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('limit=5'), expect.any(Object));
  });

  it('trả 429 khi một từ khóa mới đến trước khoảng thời gian bảo vệ provider', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('[]', {
      status: 200,
      headers: { 'content-type': 'application/json' }
    }));
    vi.stubGlobal('fetch', fetchMock);
    const secondResponse = createResponse();

    await searchLocations(createRequest({ q: 'Hà Nội' }), createResponse().response);
    await searchLocations(createRequest({ q: 'Đà Nẵng' }), secondResponse.response);

    expect(secondResponse.statusMock).toHaveBeenCalledWith(429);
    expect(secondResponse.jsonMock).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: 'LOCATION_SEARCH_THROTTLED'
    }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('trả 502 an toàn khi provider không phản hồi thành công', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 403 })));
    const { response, statusMock, jsonMock } = createResponse();

    await searchLocations(createRequest({ q: 'Đà Nẵng' }), response);

    expect(statusMock).toHaveBeenCalledWith(502);
    expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'LOCATION_SEARCH_UNAVAILABLE' }));
  });

  it('trả 502 an toàn khi gọi provider bị lỗi mạng', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network unavailable')));
    const { response, statusMock, jsonMock } = createResponse();

    await searchLocations(createRequest({ q: 'Đà Nẵng' }), response);

    expect(statusMock).toHaveBeenCalledWith(502);
    expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'LOCATION_SEARCH_UNAVAILABLE' }));
  });
});
