import { describe, expect, it } from 'vitest';
import { scrubSentryEvent, scrubUrl } from '@/app/utils/sentryScrub';

describe('scrubSentryEvent — hợp đồng riêng tư', () => {
  it('che message, exception và metadata nhưng giữ nguyên stacktrace/trace context', () => {
    const stacktrace = {
      frames: [
        {
          filename: '/app/.next/server/chunks/page.js',
          abs_path: 'https://cdn.dcp.vn/_next/static/chunk.js',
          function: 'renderDonation'
        }
      ]
    };
    const expectedStacktrace = structuredClone(stacktrace);
    const event = {
      message: 'Provider failed: token=message-secret for donor@example.com',
      exception: {
        values: [
          {
            value: 'PayOS failed: Bearer exception-secret at https://api.payos.vn/claim',
            stacktrace
          }
        ]
      },
      extra: {
        token: 'extra-secret',
        nested: { email: 'donor@example.com' }
      },
      user: {
        ip_address: '203.0.113.42',
        email: 'donor@example.com'
      },
      tags: {
        authorization: 'Bearer tag-secret',
        feature: 'donation'
      },
      contexts: {
        trace: { trace_id: 'trace-1', span_id: 'span-1' },
        payment: { bankAccount: '0123456789' }
      },
      breadcrumbs: [
        { category: 'ui.click', message: 'Retry with token=breadcrumb-secret' }
      ]
    };

    const result = scrubSentryEvent(event);
    const serializedResult = JSON.stringify(result);

    expect(serializedResult).not.toContain('message-secret');
    expect(serializedResult).not.toContain('exception-secret');
    expect(serializedResult).not.toContain('extra-secret');
    expect(serializedResult).not.toContain('tag-secret');
    expect(serializedResult).not.toContain('breadcrumb-secret');
    expect(serializedResult).not.toContain('donor@example.com');
    expect(serializedResult).not.toContain('203.0.113.42');
    expect(serializedResult).not.toContain('0123456789');
    expect(result.contexts?.trace).toEqual({ trace_id: 'trace-1', span_id: 'span-1' });
    expect(result.exception?.values?.[0].stacktrace).toEqual(expectedStacktrace);
  });

  it('caps exception and handles circular metadata without throwing', () => {
    const circularMetadata: Record<string, unknown> = {};
    circularMetadata.self = circularMetadata;
    const event = {
      exception: {
        values: [{ value: `token=long-secret ${'x'.repeat(300)}` }]
      },
      extra: circularMetadata
    };

    const result = scrubSentryEvent(event);

    expect(result.exception?.values?.[0].value).toHaveLength(240);
    expect(result.exception?.values?.[0].value).not.toContain('long-secret');
    expect(result.extra?.self).toBe('[CIRCULAR_REDACTED]');
  });
});

describe('scrubUrl', () => {
  it('loại bỏ query và fragment khỏi URL telemetry', () => {
    expect(scrubUrl('https://dcp.vn/claim?token=secret&page=2#result'))
      .toBe('https://dcp.vn/claim');
  });

  it('loại bỏ fragment chứa access token hoặc id token', () => {
    expect(scrubUrl('https://dcp.vn/login#access_token=bearer-secret'))
      .toBe('https://dcp.vn/login');
    expect(scrubUrl('https://dcp.vn/login#id_token=id-secret'))
      .toBe('https://dcp.vn/login');
  });

  it('giữ nguyên URL không có query hoặc fragment', () => {
    expect(scrubUrl('https://dcp.vn/donate')).toBe('https://dcp.vn/donate');
  });
});

describe('scrubSentryEvent', () => {
  it('chỉ giữ request method và header trong allowlist', () => {
    const event = {
      request: {
        url: 'https://dcp.vn/claim?access_token=secret#id_token=secret',
        method: 'POST',
        cookies: { session: 'session-secret' },
        data: { bankAccount: '0123456789' },
        query_string: 'token=secret',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'x-request-id': 'req-1',
          'X-Forwarded-For': '203.0.113.42',
          'X-Real-IP': '203.0.113.43',
          'Proxy-Authorization': 'Basic secret',
          'X-Api-Key': 'api-secret',
          Authorization: 'Bearer secret'
        }
      }
    };

    const result = scrubSentryEvent(event);

    expect(result.request).toEqual({
      url: 'https://dcp.vn/claim',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'x-request-id': 'req-1'
      }
    });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(JSON.stringify(result)).not.toContain('203.0.113.42');
  });

  it('loại breadcrumb console và scrub URL/token trong navigation/http', () => {
    const event = {
      breadcrumbs: [
        {
          category: 'console',
          data: { token: 'console-secret' }
        },
        {
          category: 'navigation',
          data: {
            from: 'https://dcp.vn/login#access_token=navigation-secret',
            to: 'https://dcp.vn/callback?code=oauth-secret#id_token=id-secret'
          }
        },
        {
          category: 'http',
          data: {
            url: 'https://api.dcp.vn/claim?access_token=http-secret#fragment',
            apiKey: 'api-secret'
          }
        }
      ]
    };

    const result = scrubSentryEvent(event);

    expect(result.breadcrumbs).toHaveLength(2);
    expect(result.breadcrumbs?.[0]).toEqual({
      category: 'navigation',
      data: {
        from: 'https://dcp.vn/login',
        to: 'https://dcp.vn/callback'
      }
    });
    expect(result.breadcrumbs?.[1]).toEqual({
      category: 'http',
      data: {
        url: 'https://api.dcp.vn/claim',
        apiKey: '[REDACTED]'
      }
    });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('không nổ khi event không có request', () => {
    expect(() => scrubSentryEvent({})).not.toThrow();
  });
});
