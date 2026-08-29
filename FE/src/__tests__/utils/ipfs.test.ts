import { describe, expect, it } from 'vitest';
import { buildIpfsGatewayUrl, buildIpfsGatewayUrlList, isAllowedIpfsGatewayUrl, normalizeIpfsCid } from '@/app/utils/ipfs';

const VALID_CID = `Qm${'a'.repeat(44)}`;

describe('IPFS gallery helpers', () => {
  it('normalizes ipfs:// prefix and preserves a bare CID', () => {
    expect(normalizeIpfsCid(`ipfs://${VALID_CID}`)).toBe(VALID_CID);
    expect(normalizeIpfsCid(VALID_CID)).toBe(VALID_CID);
  });

  it('uses the Pinata gateway first to avoid ipfs.io anti-bot responses', () => {
    expect(buildIpfsGatewayUrl(VALID_CID)).toBe(`https://gateway.pinata.cloud/ipfs/${VALID_CID}`);

    const urls = buildIpfsGatewayUrlList(VALID_CID);

    expect(urls).toHaveLength(3);
    expect(urls[0]).toContain('gateway.pinata.cloud');
    expect(urls[1]).toContain('cloudflare-ipfs.com');
    expect(urls[2]).toContain('ipfs.io');
    expect(new URL(urls[0]).host).not.toBe(new URL(urls[1]).host);
  });

  it('returns no gateway URL for an invalid CID', () => {
    expect(buildIpfsGatewayUrlList('not-a-cid')).toEqual([]);
  });

  it('accepts only HTTPS URLs from the fixed IPFS gateway host allowlist', () => {
    expect(isAllowedIpfsGatewayUrl(`https://gateway.pinata.cloud/ipfs/${VALID_CID}`)).toBe(true);
    expect(isAllowedIpfsGatewayUrl(`https://ipfs.io/ipfs/${VALID_CID}`)).toBe(true);
    expect(isAllowedIpfsGatewayUrl(`https://cloudflare-ipfs.com/ipfs/${VALID_CID}`)).toBe(true);
    expect(isAllowedIpfsGatewayUrl(`https://attacker.example/ipfs/${VALID_CID}`)).toBe(false);
    expect(isAllowedIpfsGatewayUrl(`http://ipfs.io/ipfs/${VALID_CID}`)).toBe(false);
  });
});
