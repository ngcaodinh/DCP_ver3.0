import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// Test: sbtValidator - exports and basic validation
// ============================================================

describe('sbtValidator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should export validateMintRequestIdParam function', async () => {
    const { validateMintRequestIdParam } = await import('../../validators/sbtValidator');
    expect(typeof validateMintRequestIdParam).toBe('function');
  });

  it('should export validatePaginationQuery function', async () => {
    const { validatePaginationQuery } = await import('../../validators/sbtValidator');
    expect(typeof validatePaginationQuery).toBe('function');
  });

  it('should export mintRequestIdParamSchema', async () => {
    const { mintRequestIdParamSchema } = await import('../../validators/sbtValidator');
    expect(mintRequestIdParamSchema).toBeDefined();
  });

  it('should export paginationQuerySchema', async () => {
    const { paginationQuerySchema } = await import('../../validators/sbtValidator');
    expect(paginationQuerySchema).toBeDefined();
  });

  it('validatePaginationQuery parse thành công với page và limit', async () => {
    const { validatePaginationQuery } = await import('../../validators/sbtValidator');
    const result = validatePaginationQuery({ page: '2', limit: '50' });
    expect(result.isValid).toBe(true);
    if (result.isValid && result.data) {
      expect(result.data.limit).toBe(50);
      expect(result.data.page).toBe(2);
    }
  });

  it('validatePaginationQuery parse với giá trị mặc định', async () => {
    const { validatePaginationQuery } = await import('../../validators/sbtValidator');
    const result = validatePaginationQuery({});
    expect(result.isValid).toBe(true);
    if (result.isValid && result.data) {
      expect(result.data.limit).toBe(20);
      expect(result.data.page).toBe(1);
    }
  });

  it('validatePaginationQuery trả về isValid=false khi limit vượt max 100', async () => {
    const { validatePaginationQuery } = await import('../../validators/sbtValidator');
    const result = validatePaginationQuery({ limit: '500' });
    expect(result.isValid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('validatePaginationQuery trả về isValid=false khi page < 1', async () => {
    const { validatePaginationQuery } = await import('../../validators/sbtValidator');
    const result = validatePaginationQuery({ page: '0' });
    expect(result.isValid).toBe(false);
  });

  it('validateMintRequestIdParam parse thành công với mintRequestId hợp lệ', async () => {
    const { validateMintRequestIdParam } = await import('../../validators/sbtValidator');
    const result = validateMintRequestIdParam({ mintRequestId: 'SBT-MINT-123' });
    expect(result.isValid).toBe(true);
    if (result.isValid && result.data) {
      expect(result.data.mintRequestId).toBe('SBT-MINT-123');
    }
  });

  it('validateMintRequestIdParam trả về isValid=false với mintRequestId rỗng', async () => {
    const { validateMintRequestIdParam } = await import('../../validators/sbtValidator');
    const result = validateMintRequestIdParam({ mintRequestId: '' });
    expect(result.isValid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
