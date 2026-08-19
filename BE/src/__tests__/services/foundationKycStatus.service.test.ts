import { beforeEach, describe, expect, it, vi } from 'vitest';

const { cacheValues, mockFindLatestApprovedFoundationKycSubmission } = vi.hoisted(() => ({
  cacheValues: new Map<string, string>(),
  mockFindLatestApprovedFoundationKycSubmission: vi.fn()
}));

vi.mock('../../config/redis', () => ({
  getRedisClientIfReady: vi.fn(() => null)
}));

vi.mock('../../models/organizationKycModel', () => ({
  findLatestApprovedFoundationKycSubmission: mockFindLatestApprovedFoundationKycSubmission
}));

vi.mock('../../utils/cacheIntegrity', () => ({
  signCachePayload: vi.fn((payload: string) => `signed:${payload}`),
  verifyCachePayload: vi.fn((payload: string) => (payload.startsWith('signed:') ? payload.slice(7) : null))
}));

vi.mock('../../utils/inMemoryCache', () => ({
  createInMemoryCache: vi.fn(() => ({
    get: (key: string) => cacheValues.get(key) ?? null,
    set: (key: string, value: string) => cacheValues.set(key, value),
    deleteByKey: (key: string) => cacheValues.delete(key)
  }))
}));

import { getFoundationKycPublicStatus } from '../../services/foundationKycStatus.service';

const CACHE_KEY = 'transparency:foundation-kyc-status';

describe('foundation KYC status service', () => {
  beforeEach(() => {
    cacheValues.clear();
    vi.clearAllMocks();
  });

  it('returns only the public fields for the latest approved submission', async () => {
    mockFindLatestApprovedFoundationKycSubmission.mockResolvedValue({
      organizationName: 'Green Foundation',
      reviewedAt: new Date('2026-08-18T10:00:00.000Z'),
      bankAccountNumber: 'must-not-leak',
      files: [{ cid: 'must-not-leak' }]
    });

    await expect(getFoundationKycPublicStatus()).resolves.toEqual({
      status: 'VERIFIED',
      verifiedAt: '2026-08-18T10:00:00.000Z',
      organizationName: 'Green Foundation'
    });
  });

  it('ignores a cache payload with fields outside the public contract', async () => {
    cacheValues.set(
      CACHE_KEY,
      `signed:${JSON.stringify({
        status: 'VERIFIED',
        verifiedAt: '2026-08-18T10:00:00.000Z',
        organizationName: 'Green Foundation',
        bankAccountNumber: 'must-not-leak'
      })}`
    );
    mockFindLatestApprovedFoundationKycSubmission.mockResolvedValue(null);

    await expect(getFoundationKycPublicStatus()).resolves.toEqual({
      status: 'NOT_VERIFIED',
      verifiedAt: null,
      organizationName: null
    });
    expect(mockFindLatestApprovedFoundationKycSubmission).toHaveBeenCalledOnce();
  });

  it('uses a valid cache entry without querying MongoDB again', async () => {
    mockFindLatestApprovedFoundationKycSubmission.mockResolvedValue(null);

    await getFoundationKycPublicStatus();
    mockFindLatestApprovedFoundationKycSubmission.mockClear();

    await expect(getFoundationKycPublicStatus()).resolves.toEqual({
      status: 'NOT_VERIFIED',
      verifiedAt: null,
      organizationName: null
    });
    expect(mockFindLatestApprovedFoundationKycSubmission).not.toHaveBeenCalled();
  });
});
