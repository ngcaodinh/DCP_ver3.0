import { describe, expect, it } from 'vitest';

const nextConfig = require('../../../next.config.js');

/** Lấy policy quyền thiết bị được cấu hình riêng cho trang Auditor. */
async function getAuditorPermissionsPolicy(): Promise<string | undefined> {
  const routes = await nextConfig.headers();
  const auditorRoute = routes.find((route: { source: string }) => route.source === '/auditor/:path*');
  return auditorRoute?.headers.find((header: { key: string }) => header.key === 'Permissions-Policy')?.value;
}

describe('nextConfig Permissions-Policy', () => {
  it('allows camera and geolocation only for Auditor evidence capture', async () => {
    await expect(getAuditorPermissionsPolicy()).resolves.toBe('camera=(self), microphone=(), geolocation=(self)');
  });

  it('does not apply the global device-denial policy to Auditor routes', async () => {
    const routes = await nextConfig.headers();
    const globalPermissionsRoute = routes.find((route: { source: string; headers: Array<{ key: string }> }) =>
      route.headers.some(header => header.key === 'Permissions-Policy' && route.source !== '/auditor/:path*'));

    expect(globalPermissionsRoute?.source).toBe('/((?!auditor(?:/|$)).*)');
  });
});
