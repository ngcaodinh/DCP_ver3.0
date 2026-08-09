import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchJsonFromIpfs,
  fetchBufferFromIpfs,
  normalizeIpfsCid
} from '../../utils/ipfsGateway';

const fetchMock = vi.fn();

vi.stubGlobal('fetch', fetchMock);

function createResponse(options: {
  status?: number;
  body?: unknown;
  contentLength?: string | null;
  arrayBuffer?: ArrayBuffer;
} = {}): Response {
  const body = options.body ?? { ok: true };
  return {
    ok: (options.status ?? 200) >= 200 && (options.status ?? 200) < 300,
    status: options.status ?? 200,
    headers: new Headers(options.contentLength === undefined || options.contentLength === null
      ? undefined
      : { 'content-length': options.contentLength }),
    json: vi.fn().mockResolvedValue(body),
    arrayBuffer: vi.fn().mockResolvedValue(
      options.arrayBuffer
      ?? new TextEncoder().encode(typeof body === 'string' ? body : JSON.stringify(body)).buffer
    )
  } as unknown as Response;
}

describe('ipfsGateway', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('falls back to gateway 2 after gateway 1 timeout', async () => {
    fetchMock
      .mockRejectedValueOnce(Object.assign(new Error('timeout'), { name: 'AbortError' }))
      .mockResolvedValueOnce(createResponse({ body: { name: 'SBT' } }));

    await expect(fetchJsonFromIpfs('ipfs://QmTest', {
      gatewayUrls: ['https://gw-one/ipfs', 'https://gw-two/ipfs'],
      maxGateways: 2,
      timeoutMsPerGateway: 10
    })).resolves.toEqual({ name: 'SBT' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws after all configured gateways fail without retrying a gateway', async () => {
    fetchMock.mockRejectedValue(new Error('unavailable'));

    await expect(fetchJsonFromIpfs('QmTest', {
      gatewayUrls: ['https://gw-one/ipfs', 'https://gw-two/ipfs', 'https://gw-three/ipfs'],
      maxGateways: 2,
      timeoutMsPerGateway: 10
    })).rejects.toThrow('unavailable');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('normalizes ipfs URI, raw CID and gateway URL to the same CID', () => {
    expect(normalizeIpfsCid('ipfs://QmTest')).toBe('QmTest');
    expect(normalizeIpfsCid('QmTest')).toBe('QmTest');
    expect(normalizeIpfsCid('https://gateway.test/ipfs/QmTest')).toBe('QmTest');
  });

  it('rejects oversized content before reading the response body', async () => {
    const response = createResponse({ contentLength: String(512 * 1024 + 1) });
    fetchMock.mockResolvedValue(response);

    await expect(fetchJsonFromIpfs('QmLarge', {
      gatewayUrls: ['https://gw-one/ipfs'],
      maxGateways: 1
    })).rejects.toMatchObject({ code: 'IPFS_PAYLOAD_TOO_LARGE' });
    expect(response.json).not.toHaveBeenCalled();
  });

  it('rejects oversized chunked content before parsing JSON', async () => {
    const response = createResponse();
    const chunkedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(512 * 1024));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      }
    });
    fetchMock.mockResolvedValue({ ...response, body: chunkedBody });

    await expect(fetchJsonFromIpfs('QmChunkedLarge', {
      gatewayUrls: ['https://gw-one/ipfs'],
      maxGateways: 1
    })).rejects.toMatchObject({ code: 'IPFS_PAYLOAD_TOO_LARGE' });
  });

  it('treats HTTP 404 as a gateway failure and tries the next gateway', async () => {
    fetchMock
      .mockResolvedValueOnce(createResponse({ status: 404 }))
      .mockResolvedValueOnce(createResponse({ body: { found: true } }));

    await expect(fetchJsonFromIpfs('QmMissing', {
      gatewayUrls: ['https://gw-one/ipfs', 'https://gw-two/ipfs'],
      maxGateways: 2
    })).resolves.toEqual({ found: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns a bounded binary buffer from IPFS', async () => {
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    fetchMock.mockResolvedValue(createResponse({ arrayBuffer: bytes }));

    await expect(fetchBufferFromIpfs('QmBinary', {
      gatewayUrls: ['https://gw-one/ipfs'],
      maxGateways: 1
    })).resolves.toEqual(Buffer.from([1, 2, 3]));
  });

  it('rejects malformed CID encoding and unsafe gateway configuration', async () => {
    await expect(fetchJsonFromIpfs('ipfs://Qm%ZZ', {
      gatewayUrls: ['https://gw-one/ipfs'],
      maxGateways: 1
    })).rejects.toMatchObject({ code: 'IPFS_UNAVAILABLE' });

    fetchMock.mockResolvedValue(createResponse({ body: { safe: true } }));
    await expect(fetchJsonFromIpfs('QmSafe', {
      gatewayUrls: ['http://169.254.169.254/latest/meta-data/'],
      maxGateways: 1
    })).resolves.toEqual({ safe: true });
    expect(fetchMock.mock.calls[0][0]).not.toContain('169.254.169.254');
  });

  it('disables redirects so a gateway cannot redirect backend fetches elsewhere', async () => {
    fetchMock.mockResolvedValue(createResponse({ body: { safe: true } }));

    await fetchJsonFromIpfs('QmNoRedirect', {
      gatewayUrls: ['https://gw-one/ipfs'],
      maxGateways: 1
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://gw-one/ipfs/QmNoRedirect',
      expect.objectContaining({ redirect: 'error' })
    );
  });
});
