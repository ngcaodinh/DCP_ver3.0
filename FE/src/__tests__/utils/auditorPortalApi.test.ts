import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockBuildApiUrl, mockFetchApi } = vi.hoisted(() => ({
  mockBuildApiUrl: vi.fn((pathname: string) => `https://api.example${pathname}`),
  mockFetchApi: vi.fn(),
}));

vi.mock('@/app/utils/apiClient', () => ({
  buildApiUrl: mockBuildApiUrl,
  buildSameOriginApiUrl: mockBuildApiUrl,
  fetchApi: mockFetchApi,
}));

import {
  createAuditorPortalDeposit,
  getAuditorPortalDepositStatus,
  getAuditorWalletTokenBalance,
  submitAuditorListingVerification
} from '@/app/utils/auditorPortalApi';

describe('getAuditorWalletTokenBalance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reads the flat payload returned by /api/deposit/balance without accessing undefined data', async () => {
    mockFetchApi.mockResolvedValue({ tokenBalance: '9007199254740993' });

    await expect(getAuditorWalletTokenBalance('auditor-token')).resolves.toBe('9007199254740993');
    expect(mockFetchApi).toHaveBeenCalledWith(
      'https://api.example/api/deposit/balance',
      { headers: { Authorization: 'Bearer auditor-token' } },
    );
  });

  it('also accepts the standard API envelope for forward compatibility', async () => {
    mockFetchApi.mockResolvedValue({ success: true, data: { tokenBalance: '42' } });

    await expect(getAuditorWalletTokenBalance('auditor-token')).resolves.toBe('42');
  });

  it('throws a descriptive error when the balance payload is missing or malformed', async () => {
    mockFetchApi.mockResolvedValue({ success: true });

    await expect(getAuditorWalletTokenBalance('auditor-token')).rejects.toThrow('Phản hồi số dư Smart Account không hợp lệ.');
  });

  it('creates an Auditor PayOS top-up from the flat deposit response', async () => {
    mockFetchApi.mockResolvedValue({
      orderCode: '1787650889515545',
      paymentUrl: 'https://pay.example/checkout',
      status: 'PENDING_PAYMENT'
    });

    await expect(createAuditorPortalDeposit('auditor-token', 12_000)).resolves.toEqual({
      orderCode: '1787650889515545',
      paymentUrl: 'https://pay.example/checkout',
      status: 'PENDING_PAYMENT'
    });
    expect(mockFetchApi).toHaveBeenCalledWith(
      'https://api.example/api/deposit/create',
      expect.objectContaining({
        body: JSON.stringify({ amountVnd: 12_000, paymentFlow: 'AUDITOR_PORTAL' })
      })
    );
  });

  it('reconciles the flat deposit status returned after PayOS redirects to Auditor', async () => {
    mockFetchApi.mockResolvedValue({
      status: 'MINT_COMPLETED',
      paymentUrl: 'https://pay.example/checkout',
      paymentExpiredAt: '2026-08-26T12:15:00.000Z',
      failureReason: null,
      isPaymentConfirmedButMintFailed: false
    });

    await expect(getAuditorPortalDepositStatus('auditor-token', '1787650889515545')).resolves.toEqual({
      status: 'MINT_COMPLETED',
      paymentUrl: 'https://pay.example/checkout',
      paymentExpiredAt: '2026-08-26T12:15:00.000Z',
      failureReason: null,
      isPaymentConfirmedButMintFailed: false
    });
    expect(mockFetchApi).toHaveBeenCalledWith(
      'https://api.example/api/deposit/1787650889515545?reconcile=true',
      { headers: { Authorization: 'Bearer auditor-token' } }
    );
  });

  it('sends the current Bearer token when submitting field verification', async () => {
    mockFetchApi.mockResolvedValue({ success: true, data: {} });
    const payload = {
      projectId: 'project-1',
      clientSubmittedAt: '2026-08-26T12:15:00.000Z',
      photos: [{
        contentBase64: 'jpeg-base64', mimeType: 'image/jpeg' as const, fileName: 'capture-1.jpg',
        gps: { latitude: 10, longitude: 106 }, accuracyMeters: 5,
        capturedAtClient: '2026-08-26T12:15:00.000Z', geolocationTimestamp: '2026-08-26T12:15:00.000Z',
        lowAccuracyOverride: false, overrideUnlockedAfterMs: null, lowAccuracyReason: null
      }]
    };

    await submitAuditorListingVerification('auditor-token', payload);

    expect(mockFetchApi).toHaveBeenCalledWith(
      'https://api.example/api/project-governance/auditor/listing-verification',
      expect.objectContaining({ headers: { Authorization: 'Bearer auditor-token' }, body: JSON.stringify(payload) })
    );
  });
});
