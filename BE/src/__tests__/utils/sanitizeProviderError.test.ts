import { describe, expect, it } from 'vitest';
import { sanitizeProviderError } from '../../utils/sanitizeProviderError';

describe('sanitizeProviderError', () => {
  it('removes credentials, bearer tokens, email and EVM address from provider text', () => {
    const result = sanitizeProviderError(
      'https://user:secret@rpc.example/?apiKey=abc123&token=xyz Bearer jwt-value '
      + 'https://rpc.example/v2/path-secret admin@example.com '
      + '0x1234567890123456789012345678901234567890'
    );

    expect(result).not.toContain('secret');
    expect(result).not.toContain('abc123');
    expect(result).not.toContain('xyz');
    expect(result).not.toContain('jwt-value');
    expect(result).not.toContain('path-secret');
    expect(result).not.toContain('admin@example.com');
    expect(result).not.toContain('0x1234567890123456789012345678901234567890');
  });

  it('redacts secret-like object keys without hiding harmless token identifiers', () => {
    const result = sanitizeProviderError({
      apiKey: 'api-secret',
      authorization: 'Bearer secret-token',
      token: 'private-token',
      tokenId: 'public-token-id'
    });

    expect(result).not.toContain('api-secret');
    expect(result).not.toContain('secret-token');
    expect(result).not.toContain('private-token');
    expect(result).toContain('public-token-id');
  });
});
