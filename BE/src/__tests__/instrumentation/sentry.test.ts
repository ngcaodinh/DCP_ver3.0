import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sentryInitMock = vi.hoisted(() => vi.fn());
const uncaughtExceptionIntegrationMock = vi.hoisted(() => vi.fn(() => ({
  name: 'OnUncaughtException'
})));

vi.mock('@sentry/node', () => ({
  init: sentryInitMock,
  onUncaughtExceptionIntegration: uncaughtExceptionIntegrationMock
}));

vi.mock('dotenv/config', () => ({}));

interface NamedIntegration {
  name?: string;
}

interface SentryBreadcrumb {
  category?: string;
  data?: Record<string, unknown>;
}

interface SentryInitOptions {
  sendDefaultPii?: boolean;
  maxBreadcrumbs?: number;
  beforeSend?: (event: unknown) => unknown;
  beforeSendTransaction?: (event: unknown) => unknown;
  beforeBreadcrumb?: (breadcrumb: SentryBreadcrumb) => SentryBreadcrumb | null;
  integrations?: (integrations: NamedIntegration[]) => NamedIntegration[];
}

describe('backend Sentry instrumentation', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('SENTRY_DSN', 'https://key@example.ingest.sentry.io/1');
    vi.stubEnv('VITEST', 'true');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('không gọi Sentry.init trong môi trường test dù có DSN', async () => {
    await import('../../instrumentation/sentry');

    expect(sentryInitMock).not.toHaveBeenCalled();
  });

  it('khởi tạo guardrail PII và filter integration trong development', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('VITEST', '');

    await import('../../instrumentation/sentry');

    expect(sentryInitMock).toHaveBeenCalledTimes(1);
    const options = sentryInitMock.mock.calls[0]?.[0] as SentryInitOptions;

    expect(options.sendDefaultPii).toBe(false);
    expect(options.maxBreadcrumbs).toBe(50);
    expect(options.beforeSend).toEqual(expect.any(Function));
    expect(options.beforeSendTransaction).toEqual(expect.any(Function));
    expect(options.beforeBreadcrumb).toEqual(expect.any(Function));

    const filteredIntegrations = options.integrations?.([
      { name: 'Console' },
      { name: 'OnUncaughtException' },
      { name: 'Http' }
    ]);

    expect(filteredIntegrations?.map(integration => integration.name)).toEqual([
      'Http',
      'OnUncaughtException'
    ]);
    expect(uncaughtExceptionIntegrationMock).toHaveBeenCalledWith({
      exitEvenIfOtherHandlersAreRegistered: false
    });

    expect(options.beforeBreadcrumb?.({
      category: 'console',
      data: { token: 'console-secret' }
    })).toBeNull();
    expect(options.beforeBreadcrumb?.({
      category: 'http',
      data: { url: 'https://api.dcp.vn/x?token=http-secret#fragment' }
    })).toEqual({
      category: 'http',
      data: { url: 'https://api.dcp.vn/x' }
    });
  });
});
