import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sentryInitMock = vi.hoisted(() => vi.fn());

vi.mock('@sentry/nextjs', () => ({
  init: sentryInitMock
}));

interface SentryBreadcrumb {
  category?: string;
  data?: Record<string, unknown>;
}

interface SentryEvent {
  request?: {
    url?: string;
    method?: string;
    headers?: Record<string, string>;
  };
  breadcrumbs?: SentryBreadcrumb[];
}

interface SentryInitOptions {
  environment?: string;
  sendDefaultPii?: boolean;
  maxBreadcrumbs?: number;
  beforeSend?: (event: SentryEvent) => SentryEvent | null;
  beforeBreadcrumb?: (breadcrumb: SentryBreadcrumb) => SentryBreadcrumb | null;
}

const runtimeConfigLoaders = [
  { name: 'client', load: () => import('../../sentry.client.config') },
  { name: 'server', load: () => import('../../sentry.server.config') },
  { name: 'edge', load: () => import('../../sentry.edge.config') }
] as const;

describe('Sentry frontend runtime configuration', () => {
  beforeEach(() => {
    sentryInitMock.mockClear();
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('NEXT_PUBLIC_SENTRY_DSN', 'https://public@example.ingest.sentry.io/1');
    vi.stubEnv('SENTRY_DSN', 'https://server@example.ingest.sentry.io/2');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it.each(runtimeConfigLoaders)('gắn đầy đủ guardrail cho runtime $name', async ({ load }) => {
    await load();

    expect(sentryInitMock).toHaveBeenCalledTimes(1);
    const options = sentryInitMock.mock.calls[0]?.[0] as SentryInitOptions;

    expect(options.sendDefaultPii).toBe(false);
    expect(options.maxBreadcrumbs).toBe(50);
    expect(options.beforeSend).toEqual(expect.any(Function));
    expect(options.beforeBreadcrumb).toEqual(expect.any(Function));

    const scrubbedEvent = options.beforeSend?.({
      request: {
        url: 'https://dcp.vn/callback?code=oauth-secret#access_token=bearer-secret',
        headers: {
          accept: 'application/json',
          'X-Forwarded-For': '203.0.113.42',
          'X-Api-Key': 'api-secret'
        }
      },
      breadcrumbs: [
        { category: 'console', data: { token: 'console-secret' } },
        {
          category: 'http',
          data: { url: 'https://api.dcp.vn/x?token=http-secret#fragment' }
        }
      ]
    });

    expect(JSON.stringify(scrubbedEvent)).not.toContain('secret');
    expect(scrubbedEvent?.request?.headers).toEqual({ accept: 'application/json' });
    expect(scrubbedEvent?.breadcrumbs).toHaveLength(1);

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

  it('đưa environment staging vào browser config từ biến public build-time', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_SENTRY_ENVIRONMENT', 'staging');

    await import('../../sentry.client.config');

    const options = sentryInitMock.mock.calls[0]?.[0] as SentryInitOptions;

    expect(options.environment).toBe('staging');
  });

  it('giữ biến Sentry public qua Dockerfile, Compose, env template và workflow frontend', () => {
    const frontendRoot = process.cwd();
    const repositoryRoot = resolve(frontendRoot, '..');
    const dockerfile = readFileSync(resolve(frontendRoot, 'Dockerfile'), 'utf8');
    const composeFile = readFileSync(resolve(repositoryRoot, 'docker-compose.prod.yml'), 'utf8');
    const composeEnvironmentFile = readFileSync(
      resolve(repositoryRoot, 'deploy', 'compose.env.example'),
      'utf8'
    );
    const workflowFile = readFileSync(
      resolve(repositoryRoot, '.github', 'workflows', 'docker-publish.yml'),
      'utf8'
    );
    const readme = readFileSync(resolve(repositoryRoot, 'README.md'), 'utf8');

    expect(dockerfile).toContain('ARG NEXT_PUBLIC_SENTRY_ENVIRONMENT');
    expect(dockerfile).toContain(
      'ENV NEXT_PUBLIC_SENTRY_ENVIRONMENT=${NEXT_PUBLIC_SENTRY_ENVIRONMENT}'
    );
    expect(composeFile).toContain(
      'NEXT_PUBLIC_SENTRY_ENVIRONMENT: ${NEXT_PUBLIC_SENTRY_ENVIRONMENT}'
    );
    expect(composeEnvironmentFile).toMatch(/^NEXT_PUBLIC_SENTRY_DSN=$/m);
    expect(composeEnvironmentFile).toMatch(/^NEXT_PUBLIC_SENTRY_ENVIRONMENT=production$/m);
    expect(workflowFile).toContain(
      'NEXT_PUBLIC_SENTRY_ENVIRONMENT=${{ vars.NEXT_PUBLIC_SENTRY_ENVIRONMENT }}'
    );
    expect(readme).toContain(
      'docker compose --env-file /opt/dcp/env/compose.env -f docker-compose.prod.yml up -d --build'
    );
  });
});
