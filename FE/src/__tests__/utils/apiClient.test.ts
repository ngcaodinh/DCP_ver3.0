import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApiUrl, buildSameOriginApiUrl, fetchApi } from '@/app/utils/apiClient';

describe('fetchApi', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('giữ nguyên Authorization khi caller truyền Headers instance', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ success: true, message: 'ok', data: {} })
    } as Response);
    const headers = new Headers({ Authorization: 'Bearer auditor-token' });

    await fetchApi('/api/project-governance/auditor/listing-verification', {
      method: 'POST',
      headers,
      body: '{}'
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(requestInit.headers).get('Authorization')).toBe('Bearer auditor-token');
    expect(new Headers(requestInit.headers).get('Content-Type')).toBe('application/json');
  });

  it('dùng Next same-origin proxy cho API browser để giữ header xác thực', () => {
    expect(buildSameOriginApiUrl('/api/project-governance/auditor/listing-verification'))
      .toBe('/api/project-governance/auditor/listing-verification');
    expect(buildApiUrl('/api/project-governance/auditor/listing-verification'))
      .toBe('http://localhost:3000/api/project-governance/auditor/listing-verification');
  });
});
