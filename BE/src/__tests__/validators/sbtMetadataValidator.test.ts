import { describe, expect, it } from 'vitest';
import {
  sbtGalleryQuerySchema,
  sbtMetadataQuerySchema,
  sbtProjectIdParamSchema,
  sbtTokenIdParamSchema,
  updateSbtStatusBodySchema
} from '../../validators/sbtMetadataValidator';

describe('sbtMetadataValidator', () => {
  it('rejects limit above 20 and page zero, while defaulting missing values', () => {
    expect(sbtMetadataQuerySchema.safeParse({ limit: '50' }).success).toBe(false);
    expect(sbtMetadataQuerySchema.safeParse({ page: '0' }).success).toBe(false);
    expect(sbtMetadataQuerySchema.safeParse({ page: '501' }).success).toBe(false);
    expect(sbtMetadataQuerySchema.parse({})).toEqual({ page: 1, limit: 20 });
  });

  it('rejects non-numeric tokenId and accepts tokenId zero', () => {
    expect(sbtTokenIdParamSchema.safeParse({ tokenId: 'abc' }).success).toBe(false);
    expect(sbtTokenIdParamSchema.safeParse({ tokenId: '9007199254740992' }).success).toBe(false);
    expect(sbtTokenIdParamSchema.parse({ tokenId: '0' })).toEqual({ tokenId: 0 });
  });

  it('accepts BURNED and rejects empty or overlong reasons', () => {
    expect(updateSbtStatusBodySchema.parse({
      tokenId: 1,
      newStatus: 'BURNED',
      reason: 'Confirmed fraud.'
    })).toMatchObject({ newStatus: 'BURNED' });
    expect(updateSbtStatusBodySchema.safeParse({ tokenId: 1, newStatus: 'ACTIVE', reason: '' }).success).toBe(false);
    expect(updateSbtStatusBodySchema.safeParse({
      tokenId: 1,
      newStatus: 'ACTIVE',
      reason: 'x'.repeat(201)
    }).success).toBe(false);
  });

  it('normalizes bounded projectId values and rejects path or punctuation injection', () => {
    expect(sbtProjectIdParamSchema.parse({ projectId: '  project_001  ' })).toEqual({
      projectId: 'project_001'
    });
    expect(sbtGalleryQuerySchema.safeParse({ projectId: 'project.001' }).success).toBe(false);
    expect(sbtGalleryQuerySchema.safeParse({ projectId: 'p'.repeat(65) }).success).toBe(false);
    expect(sbtGalleryQuerySchema.parse({})).toEqual({ page: 1, limit: 20 });
  });
});
