import { describe, expect, it } from 'vitest';
import { readImageExifMetadata } from '../../utils/imageExifMetadata';

describe('readImageExifMetadata', () => {
  it('returns empty metadata instead of throwing for malformed image bytes', () => {
    expect(readImageExifMetadata(Buffer.from('not-an-image'))).toEqual({ gps: null, capturedAt: null });
  });

  it('returns empty metadata for an image buffer without EXIF', () => {
    expect(readImageExifMetadata(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toEqual({ gps: null, capturedAt: null });
  });
});
