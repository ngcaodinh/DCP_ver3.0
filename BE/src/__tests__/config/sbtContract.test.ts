import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';

const sbtSignerKey = `0x${'11'.repeat(32)}`;
const charitySignerKey = `0x${'22'.repeat(32)}`;

describe('sbtContract signer configuration', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('uses the dedicated ImpactSBT signer key', async () => {
    vi.stubEnv('IMPACT_SBT_MINTER_PRIVATE_KEY', sbtSignerKey);
    vi.stubEnv('BACKEND_MINTER_PRIVATE_KEY', charitySignerKey);

    const { getImpactSbtMintSignerAddress } = await import('../../config/sbtContract');

    expect(getImpactSbtMintSignerAddress()).toBe(new ethers.Wallet(sbtSignerKey).address);
  });

  it('rejects sharing the CharityToken signer key', async () => {
    vi.stubEnv('IMPACT_SBT_MINTER_PRIVATE_KEY', sbtSignerKey);
    vi.stubEnv('BACKEND_MINTER_PRIVATE_KEY', sbtSignerKey);

    const { getImpactSbtMintSignerAddress } = await import('../../config/sbtContract');

    expect(() => getImpactSbtMintSignerAddress()).toThrow('phải khác BACKEND_MINTER_PRIVATE_KEY');
  });
});
