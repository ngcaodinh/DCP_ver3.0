import { describe, expect, it } from 'vitest';
import nextConfigModule from '../../next.config.js';

type RewriteRule = { source: string; destination: string };
type NextConfigWithRewrites = { rewrites: () => Promise<RewriteRule[]> };

const nextConfig = nextConfigModule as NextConfigWithRewrites;

describe('Next.js donation certificate rewrites', () => {
  it('định tuyến /api/donations sang prefix /donations của backend', async () => {
    const rewrites = await nextConfig.rewrites();
    const certificateRewrite = rewrites.find(rule => rule.source === '/api/donations/:path*');

    expect(certificateRewrite).toBeDefined();
    expect(certificateRewrite?.destination).toMatch(/\/donations\/:path\*$/);
  });

  it('giữ nguyên rewrite /api cho các module backend khác', async () => {
    const rewrites = await nextConfig.rewrites();

    const genericApiRewrite = rewrites.find(rule => rule.source === '/api/:path*');

    expect(genericApiRewrite).toBeDefined();
    expect(genericApiRewrite?.destination).toMatch(/\/api\/:path\*$/);
  });
});
