import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getConfiguredTracesSampleRate,
  getSentryConfigWarning,
  isSentryEnabled,
  resolveSentryServerName
} from '../../config/sentryConfig';

const savedEnvironment = { ...process.env };

beforeEach(() => {
  delete process.env.SENTRY_DSN;
  delete process.env.SENTRY_TRACES_SAMPLE_RATE;
  delete process.env.SENTRY_SERVER_NAME;
  delete process.env.RUN_WORKERS;
});

afterEach(() => {
  process.env = { ...savedEnvironment };
});

describe('isSentryEnabled', () => {
  it('tắt trong test dù có DSN để giữ suite offline', () => {
    process.env.SENTRY_DSN = 'https://key@o1.ingest.sentry.io/1';

    expect(isSentryEnabled()).toBe(false);
  });

  it('tắt khi thiếu DSN', () => {
    expect(isSentryEnabled()).toBe(false);
  });
});

describe('getSentryConfigWarning', () => {
  it('production thiếu DSN thì cảnh báo chứ không throw', () => {
    process.env.NODE_ENV = 'production';

    expect(() => getSentryConfigWarning()).not.toThrow();
    expect(getSentryConfigWarning()).toContain('SENTRY_DSN');
  });

  it('development thiếu DSN thì không cảnh báo', () => {
    process.env.NODE_ENV = 'development';

    expect(getSentryConfigWarning()).toBeNull();
  });
});

describe('getConfiguredTracesSampleRate', () => {
  it.each([
    ['', 0.1],
    ['abc', 0.1],
    ['1.5', 0.1],
    ['-1', 0.1],
    ['0.25', 0.25],
    ['0', 0]
  ])('với SENTRY_TRACES_SAMPLE_RATE=%j trả %s', (rawValue, expected) => {
    process.env.SENTRY_TRACES_SAMPLE_RATE = rawValue;

    expect(getConfiguredTracesSampleRate()).toBe(expected);
  });
});

describe('resolveSentryServerName', () => {
  it('phân biệt worker process và API process', () => {
    process.env.RUN_WORKERS = 'true';
    expect(resolveSentryServerName()).toBe('dcp-backend-worker');

    process.env.RUN_WORKERS = 'false';
    expect(resolveSentryServerName()).toBe('dcp-backend');
  });

  it('ưu tiên tên process được cấu hình tường minh', () => {
    process.env.SENTRY_SERVER_NAME = 'custom-backend';

    expect(resolveSentryServerName()).toBe('custom-backend');
  });
});
