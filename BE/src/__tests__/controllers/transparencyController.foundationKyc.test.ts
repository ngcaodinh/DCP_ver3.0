import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetFoundationKycPublicStatus } = vi.hoisted(() => ({
  mockGetFoundationKycPublicStatus: vi.fn()
}));

vi.mock('../../services/foundationKycStatus.service', () => ({
  getFoundationKycPublicStatus: mockGetFoundationKycPublicStatus
}));

import { handleGetFoundationKycStatus } from '../../controllers/transparencyController';

/** Tạo request/response tối thiểu để kiểm tra contract public mà không boot Express. */
function createMockResponse(): Parameters<typeof handleGetFoundationKycStatus>[1] {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis()
  } as unknown as Parameters<typeof handleGetFoundationKycStatus>[1];
}

describe('transparency foundation KYC controller', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns exactly the three-field NOT_VERIFIED public contract', async () => {
    mockGetFoundationKycPublicStatus.mockResolvedValue({
      status: 'NOT_VERIFIED',
      verifiedAt: null,
      organizationName: null
    });
    const response = createMockResponse();

    await handleGetFoundationKycStatus({} as Parameters<typeof handleGetFoundationKycStatus>[0], response);

    expect(response.status).toHaveBeenCalledWith(200);
    const body = vi.mocked(response.json).mock.calls[0][0] as { data: Record<string, unknown> };
    expect(Object.keys(body.data).sort()).toEqual(['organizationName', 'status', 'verifiedAt']);
    expect(body.data).toEqual({ status: 'NOT_VERIFIED', verifiedAt: null, organizationName: null });
  });

  it('does not leak internal fields when a FOUNDATION is verified', async () => {
    mockGetFoundationKycPublicStatus.mockResolvedValue({
      status: 'VERIFIED',
      verifiedAt: '2026-08-18T00:00:00.000Z',
      organizationName: 'Quỹ An Tâm'
    });
    const response = createMockResponse();

    await handleGetFoundationKycStatus({} as Parameters<typeof handleGetFoundationKycStatus>[0], response);

    expect(vi.mocked(response.json)).toHaveBeenCalledWith(expect.objectContaining({
      data: {
        status: 'VERIFIED',
        verifiedAt: '2026-08-18T00:00:00.000Z',
        organizationName: 'Quỹ An Tâm'
      }
    }));
    expect(vi.mocked(response.json).mock.calls[0][0]).not.toHaveProperty('data.beneficiaryBankAccount');
  });

  it('maps status service failures to the standard internal error contract', async () => {
    mockGetFoundationKycPublicStatus.mockRejectedValue(new Error('database unavailable'));
    const response = createMockResponse();

    await handleGetFoundationKycStatus({} as Parameters<typeof handleGetFoundationKycStatus>[0], response);

    expect(response.status).toHaveBeenCalledWith(500);
    expect(vi.mocked(response.json)).toHaveBeenCalledWith(expect.objectContaining({
      success: false,
      errorCode: 'INTERNAL_ERROR'
    }));
  });
});
