import { describe, expect, it } from 'vitest';
import { normalizeBlockchainRpcUrl } from '../../config/blockchainRpc';

describe('normalizeBlockchainRpcUrl', () => {
  it('migrates the retired Polygon Amoy public RPC host', () => {
    expect(normalizeBlockchainRpcUrl('https://rpc-amoy.polygon.technology/')).toBe('https://polygon-amoy.drpc.org');
  });

  it('preserves a valid supported provider URL', () => {
    expect(normalizeBlockchainRpcUrl('https://polygon-amoy.drpc.org')).toBe('https://polygon-amoy.drpc.org');
  });

  it('keeps empty and malformed values for the existing environment validation to handle', () => {
    expect(normalizeBlockchainRpcUrl(undefined)).toBe('');
    expect(normalizeBlockchainRpcUrl('not a URL')).toBe('not a URL');
  });
});
