/**
 * Unit tests cho tile proxy controller.
 * Xác nhận controller chặn input không hợp lệ, cache tile server-side và không cache nội dung sai định dạng.
 */
import type { Request, Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/logger', () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }))
}));

import {
  __resetTileProxyCache,
  proxyAdministrativeMapTile,
  proxyMapTile
} from '../../controllers/tileProxyController';

/**
 * Tạo request Express tối giản chỉ chứa tile path parameters.
 * @param params Tọa độ tile dùng trong test.
 * @returns Request phù hợp với tile controller.
 */
function createRequest(params: Record<string, string>): Request {
  return { params } as unknown as Request;
}

/**
 * Tạo response Express tối giản để kiểm tra status, body, header và binary payload.
 * @returns Response mock cùng các spies cần thiết.
 */
function createResponse(): {
  response: Response;
  statusMock: ReturnType<typeof vi.fn>;
  jsonMock: ReturnType<typeof vi.fn>;
  setMock: ReturnType<typeof vi.fn>;
  sendMock: ReturnType<typeof vi.fn>;
} {
  const jsonMock = vi.fn();
  const setMock = vi.fn();
  const sendMock = vi.fn();
  const responseObject = {
    status: vi.fn(),
    json: jsonMock,
    set: setMock,
    send: sendMock
  };
  const statusMock = responseObject.status.mockImplementation(() => responseObject);

  return {
    response: responseObject as unknown as Response,
    statusMock,
    jsonMock,
    setMock,
    sendMock
  };
}

/**
 * Tạo HTTP response PNG giả lập từ nhà cung cấp tile.
 * @param body Nội dung tile PNG giả lập.
 * @returns Response có content type và content length phù hợp.
 */
function createPngResponse(body = 'tile-png'): globalThis.Response {
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'image/png',
      'content-length': String(Buffer.byteLength(body))
    }
  });
}

describe('tileProxyController', () => {
  beforeEach(() => {
    __resetTileProxyCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('trả 400 và không gọi provider khi tile parameter không phải số nguyên', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { response, statusMock, jsonMock } = createResponse();

    await proxyMapTile(createRequest({ z: '4abc', x: '1', y: '2' }), response);

    expect(statusMock).toHaveBeenCalledWith(400);
    expect(jsonMock).toHaveBeenCalledWith({ error: 'Invalid tile coordinates' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('cache server-side tile hợp lệ để request cùng tọa độ không gọi Carto lần hai', async () => {
    const fetchMock = vi.fn().mockResolvedValue(createPngResponse());
    vi.stubGlobal('fetch', fetchMock);
    const firstResponse = createResponse();
    const secondResponse = createResponse();
    const request = createRequest({ z: '4', x: '1', y: '2' });

    await proxyMapTile(request, firstResponse.response);
    await proxyMapTile(request, secondResponse.response);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/^https:\/\/[abcd]\.basemaps\.cartocdn\.com\/rastertiles\/voyager\/4\/1\/2\.png$/),
      expect.any(Object)
    );
    expect(firstResponse.setMock).toHaveBeenCalledWith(expect.objectContaining({
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=604800, immutable'
    }));
    expect(secondResponse.sendMock).toHaveBeenCalledWith(Buffer.from('tile-png'));
  });

  it('trả 502 và không cache khi provider không trả PNG', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('<html>error</html>', {
      status: 200,
      headers: { 'content-type': 'text/html' }
    }));
    vi.stubGlobal('fetch', fetchMock);
    const firstResponse = createResponse();
    const secondResponse = createResponse();
    const request = createRequest({ z: '4', x: '1', y: '2' });

    await proxyMapTile(request, firstResponse.response);
    await proxyMapTile(request, secondResponse.response);

    expect(firstResponse.statusMock).toHaveBeenCalledWith(502);
    expect(firstResponse.jsonMock).toHaveBeenCalledWith({
      error: 'Tile provider returned unsupported content'
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('proxy lớp địa giới sau sáp nhập qua WMS chính thức với bounding box Web Mercator', async () => {
    const fetchMock = vi.fn().mockResolvedValue(createPngResponse());
    vi.stubGlobal('fetch', fetchMock);
    const { response, setMock } = createResponse();

    await proxyAdministrativeMapTile(createRequest({ z: '0', x: '0', y: '0' }), response);

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('LAYERS=vietnam_2026%2Cvietnam_label_2026'),
      expect.any(Object)
    );
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('SRS=EPSG%3A3857'), expect.any(Object));
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('BBOX=-20037508.342789244%2C-20037508.342789244%2C20037508.342789244%2C20037508.342789244'),
      expect.any(Object)
    );
    expect(setMock).toHaveBeenCalledWith(expect.objectContaining({ 'Content-Type': 'image/png' }));
  });

  it('cache tile địa giới hợp lệ để không gọi WMS lần hai', async () => {
    const fetchMock = vi.fn().mockResolvedValue(createPngResponse());
    vi.stubGlobal('fetch', fetchMock);
    const request = createRequest({ z: '6', x: '54', y: '35' });

    await proxyAdministrativeMapTile(request, createResponse().response);
    await proxyAdministrativeMapTile(request, createResponse().response);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: 'provider trả lỗi HTTP',
      providerResponse: new Response('', { status: 503 }),
      expectedStatusCode: 503,
      expectedError: 'Administrative map tile not found'
    },
    {
      name: 'provider không trả PNG',
      providerResponse: new Response('<html>error</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
      expectedStatusCode: 502,
      expectedError: 'Administrative map provider returned unsupported content'
    },
    {
      name: 'provider công bố tile quá lớn',
      providerResponse: new Response('tile-png', {
        status: 200,
        headers: { 'content-type': 'image/png', 'content-length': '524289' }
      }),
      expectedStatusCode: 502,
      expectedError: 'Administrative map provider returned an oversized response'
    }
  ])('không cache khi $name', async ({ providerResponse, expectedStatusCode, expectedError }) => {
    const fetchMock = vi.fn().mockResolvedValue(providerResponse);
    vi.stubGlobal('fetch', fetchMock);
    const request = createRequest({ z: '6', x: '54', y: '35' });
    const firstResponse = createResponse();
    const secondResponse = createResponse();

    await proxyAdministrativeMapTile(request, firstResponse.response);
    await proxyAdministrativeMapTile(request, secondResponse.response);

    expect(firstResponse.statusMock).toHaveBeenCalledWith(expectedStatusCode);
    expect(firstResponse.jsonMock).toHaveBeenCalledWith({ error: expectedError });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('trả lỗi 502 an toàn khi WMS không thể kết nối', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network unavailable')));
    const { response, statusMock, jsonMock } = createResponse();

    await proxyAdministrativeMapTile(createRequest({ z: '6', x: '54', y: '35' }), response);

    expect(statusMock).toHaveBeenCalledWith(502);
    expect(jsonMock).toHaveBeenCalledWith({ error: 'Failed to fetch administrative map tile' });
  });

  it('chặn tile địa giới vượt mức zoom chính thức hỗ trợ', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { response, statusMock, jsonMock } = createResponse();

    await proxyAdministrativeMapTile(createRequest({ z: '17', x: '0', y: '0' }), response);

    expect(statusMock).toHaveBeenCalledWith(400);
    expect(jsonMock).toHaveBeenCalledWith({ error: 'Invalid administrative map zoom level' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('chặn tọa độ tile địa giới nằm ngoài phạm vi zoom hợp lệ', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { response, statusMock, jsonMock } = createResponse();

    await proxyAdministrativeMapTile(createRequest({ z: '16', x: '65536', y: '0' }), response);

    expect(statusMock).toHaveBeenCalledWith(400);
    expect(jsonMock).toHaveBeenCalledWith({ error: 'Tile coordinates out of bounds' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
