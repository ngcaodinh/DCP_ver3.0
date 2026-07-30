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

import { __resetTileProxyCache, proxyOsmTile } from '../../controllers/tileProxyController';

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
 * Tạo HTTP response PNG giả lập từ OSM.
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

  it('trả 400 và không gọi OSM khi tile parameter không phải số nguyên', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { response, statusMock, jsonMock } = createResponse();

    await proxyOsmTile(createRequest({ z: '4abc', x: '1', y: '2' }), response);

    expect(statusMock).toHaveBeenCalledWith(400);
    expect(jsonMock).toHaveBeenCalledWith({ error: 'Invalid tile coordinates' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('cache server-side tile hợp lệ để request cùng tọa độ không gọi OSM lần hai', async () => {
    const fetchMock = vi.fn().mockResolvedValue(createPngResponse());
    vi.stubGlobal('fetch', fetchMock);
    const firstResponse = createResponse();
    const secondResponse = createResponse();
    const request = createRequest({ z: '4', x: '1', y: '2' });

    await proxyOsmTile(request, firstResponse.response);
    await proxyOsmTile(request, secondResponse.response);

    expect(fetchMock).toHaveBeenCalledTimes(1);
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

    await proxyOsmTile(request, firstResponse.response);
    await proxyOsmTile(request, secondResponse.response);

    expect(firstResponse.statusMock).toHaveBeenCalledWith(502);
    expect(firstResponse.jsonMock).toHaveBeenCalledWith({
      error: 'Tile provider returned unsupported content'
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
