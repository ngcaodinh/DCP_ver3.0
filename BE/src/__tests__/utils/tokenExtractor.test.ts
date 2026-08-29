import { describe, expect, it } from 'vitest';
import { extractBearerToken } from '../../utils/tokenExtractor';

describe('extractBearerToken', () => {
  it.each([
    ['Bearer token-1', 'token-1'],
    ['bearer token-2', 'token-2'],
    ['  Bearer   token-3  ', 'token-3']
  ])('normalizes a valid Authorization value', (header, expected) => {
    expect(extractBearerToken(header)).toBe(expected);
  });

  it.each([undefined, '', 'Basic token', 'Bearer'])('rejects a missing or non-Bearer value', header => {
    expect(extractBearerToken(header)).toBeNull();
  });
});
