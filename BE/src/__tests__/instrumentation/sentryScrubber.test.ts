import { describe, expect, it } from 'vitest';
import type { Breadcrumb, Event } from '@sentry/node';
import {
  redactSentryBreadcrumb,
  redactSentryEvent,
  resolveTracesSampleRate
} from '../../instrumentation/sentryScrubber';

/** Dựng stacktrace giống runtime để khóa bất biến source map quan trọng nhất của E7. */
function createEventWithStacktrace(): Event {
  return {
    exception: {
      values: [
        {
          type: 'TypeError',
          value: 'Cannot read properties of undefined',
          stacktrace: {
            frames: [
              {
                filename: '/app/dist/services/donationService.js',
                abs_path: 'file:///app/dist/services/donationService.js',
                function: 'processDonation',
                lineno: 412,
                colno: 17,
                in_app: true
              },
              {
                filename: 'node:internal/process/task_queues',
                abs_path: 'node:internal/process/task_queues',
                function: 'processTicksAndRejections',
                lineno: 95,
                colno: 5,
                in_app: false
              }
            ]
          }
        }
      ]
    }
  };
}

describe('redactSentryEvent', () => {
  it('giữ nguyên toàn bộ stacktrace để Sentry ghép source map', () => {
    const event = createEventWithStacktrace();
    const expectedFrames = structuredClone(event.exception!.values![0].stacktrace!.frames);

    const result = redactSentryEvent(event, 'req-1');

    expect(result.exception!.values![0].stacktrace!.frames).toEqual(expectedFrames);
  });

  it('sanitize message exception nhưng không thay đổi abs_path của frame', () => {
    const event = createEventWithStacktrace();
    event.exception!.values![0].value = 'PayOS failed: token=abcdef123456 at https://api.payos.vn/x';

    const result = redactSentryEvent(event, null);
    const [firstFrame] = result.exception!.values![0].stacktrace!.frames!;

    expect(result.exception!.values![0].value).not.toContain('abcdef123456');
    expect(firstFrame.abs_path).toBe('file:///app/dist/services/donationService.js');
    expect(firstFrame.filename).not.toContain('REDACTED');
  });

  it('redact metadata app gắn và giữ contexts.trace nguyên vẹn', () => {
    const event: Event = {
      extra: { token: 'abcdefghij1234567890' },
      user: { id: 'user_1', ip_address: '203.0.113.42' },
      contexts: {
        trace: { trace_id: '1234567890abcdef1234567890abcdef', span_id: 'abcdef1234567890' },
        custom: { ipAddress: '203.0.113.42' }
      }
    };

    const result = redactSentryEvent(event, null);

    expect(result.extra!.token).toBe('abcdefgh...[REDACTED]');
    expect(result.user!.ip_address).toBe('[IP_REDACTED]');
    expect(result.contexts!.trace).toEqual(event.contexts!.trace);
    expect((result.contexts!.custom as Record<string, unknown>).ipAddress).toBe('[IP_REDACTED]');
  });

  it('chỉ giữ header allowlist, xóa body/cookie/query và cắt URL', () => {
    const event: Event = {
      request: {
        url: 'https://dcp.vn/api/claim?token=secret',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          cookie: 'session=secret',
          'x-forwarded-for': '203.0.113.42',
          authorization: 'Bearer secret'
        },
        data: { bankAccount: '0123456789' },
        query_string: 'token=secret',
        cookies: { session: 'secret' }
      }
    };

    const result = redactSentryEvent(event, null);

    expect(result.request!.headers).toEqual({
      'content-type': 'application/json',
      accept: 'application/json'
    });
    expect(result.request!.url).toBe('https://dcp.vn/api/claim');
    expect(result.request!.data).toBeUndefined();
    expect(result.request!.query_string).toBeUndefined();
    expect(result.request!.cookies).toBeUndefined();
  });

  it('gắn requestId khi thiếu và không ghi đè tag đã có', () => {
    expect(redactSentryEvent({} as Event, 'req-abc').tags?.requestId).toBe('req-abc');
    expect(redactSentryEvent({ tags: { requestId: 'from-reporter' } }, 'from-als').tags?.requestId)
      .toBe('from-reporter');
    expect(redactSentryEvent({} as Event, null).tags?.requestId).toBeUndefined();
  });
});

describe('redactSentryBreadcrumb', () => {
  it('loại breadcrumb console vì trùng Winston', () => {
    const breadcrumb: Breadcrumb = { category: 'console', message: 'debug output' };

    expect(redactSentryBreadcrumb(breadcrumb)).toBeNull();
  });

  it('redact dữ liệu và cắt query của breadcrumb http', () => {
    const breadcrumb: Breadcrumb = {
      category: 'http',
      data: {
        url: 'https://api.payos.vn/v2/x?apiKey=secret',
        walletAddress: '0x1234567890abcdef1234567890abcdef12345678',
        amount: 500000
      }
    };

    const result = redactSentryBreadcrumb(breadcrumb);

    expect(result!.data!.url).toBe('https://api.payos.vn/v2/x');
    expect(result!.data!.walletAddress).toBe('0x1234...5678');
    expect(result!.data!.amount).toBe('***VND');
  });
});

describe('resolveTracesSampleRate', () => {
  it('lấy mẫu 100% ở development và loại route hạ tầng', () => {
    expect(resolveTracesSampleRate({ name: 'POST /donations' }, 0.1, 'development')).toBe(1);
    expect(resolveTracesSampleRate({ name: 'GET /health' }, 0.1, 'development')).toBe(0);
  });

  it('dùng cấu hình production và kế thừa quyết định trace cha', () => {
    expect(resolveTracesSampleRate({ name: 'POST /donations' }, 0.1, 'production')).toBe(0.1);
    expect(resolveTracesSampleRate({ name: 'POST /x', parentSampled: true }, 0.1, 'production')).toBe(1);
    expect(resolveTracesSampleRate({ name: 'POST /x', parentSampled: false }, 1, 'development')).toBe(0);
  });
});
