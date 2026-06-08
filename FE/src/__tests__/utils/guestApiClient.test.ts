import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createGuestSession,
  refreshGuestSession,
  getGuestSessionStatus,
  requestPaymasterSponsorship,
  prepareGuestClaim,
  executeGuestClaim,
  getPendingDonationStatus,
  clearPendingDonation,
  GuestApiError,
  type GuestApiErrorCode,
} from '@/app/utils/guestApiClient';

const FIXTURE_WALLET = '0x742d35Cc6634C0532925a3b844Bc9e7595f0E8eD'.toLowerCase();
const FIXTURE_FINGERPRINT = 'a'.repeat(64);
const FIXTURE_TOKEN = 'guest.jwt.token';

function makeFetchMock(responseBody: unknown, ok: boolean, status: number) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    text: async () => JSON.stringify(responseBody),
  } as unknown as Response);
}

describe('guestApiClient', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('GuestApiError', () => {
    it('should preserve error properties from ApiErrorResponse', () => {
      const error = new GuestApiError({
        success: false,
        message: 'Test error',
        errorCode: 'GUEST_SESSION_NOT_FOUND',
        statusCode: 404,
        details: [{ field: 'sessionId', message: 'Not found' }],
      });

      expect(error.message).toBe('Test error');
      expect(error.errorCode).toBe('GUEST_SESSION_NOT_FOUND');
      expect(error.statusCode).toBe(404);
      expect(error.details).toHaveLength(1);
      expect(error.name).toBe('GuestApiError');
    });

    it('should default to UNKNOWN_ERROR when errorCode is absent', () => {
      const error = new GuestApiError({
        success: false,
        message: 'Test',
        errorCode: undefined as unknown as string,
        statusCode: 500,
      });

      expect(error.errorCode).toBe('UNKNOWN_ERROR');
    });

    it('should default to 500 when statusCode is absent', () => {
      const error = new GuestApiError({
        success: false,
        message: 'Test',
        errorCode: 'INTERNAL_ERROR',
        statusCode: undefined as unknown as number,
      });

      expect(error.statusCode).toBe(500);
    });
  });

  describe('unwrap error mapping', () => {
    /**
     * Kiểm tra unwrap() map ApiErrorResponse (throw từ fetchApi)
     * thành GuestApiError với đầy đủ thông tin errorCode, statusCode, details.
     * Đây là test cho logic đã fix ở B1.
     */

    it('should map API error 400 to GuestApiError with correct errorCode and statusCode', async () => {
      vi.stubGlobal('fetch', makeFetchMock({
        success: false,
        message: 'Địa chỉ ví không hợp lệ.',
        errorCode: 'INVALID_WALLET_ADDRESS',
        details: [{ field: 'walletAddress', message: 'Sai định dạng' }],
      }, false, 400));

      try {
        await createGuestSession({
          walletAddress: FIXTURE_WALLET,
          deviceFingerprintHash: FIXTURE_FINGERPRINT,
        });
        expect.fail('Should have thrown GuestApiError');
      } catch (error) {
        expect(error).toBeInstanceOf(GuestApiError);
        expect((error as GuestApiError).errorCode).toBe('INVALID_WALLET_ADDRESS');
        expect((error as GuestApiError).statusCode).toBe(400);
        expect((error as GuestApiError).message).toBe('Địa chỉ ví không hợp lệ.');
        expect((error as GuestApiError).details).toHaveLength(1);
      }
    });

    it('should map API error 429 to GuestApiError with rate limit errorCode', async () => {
      vi.stubGlobal('fetch', makeFetchMock({
        success: false,
        message: 'Quá nhiều yêu cầu từ IP này.',
        errorCode: 'GUEST_SESSION_RATE_LIMIT_EXCEEDED',
        details: [],
      }, false, 429));

      try {
        await getGuestSessionStatus('session-123', FIXTURE_TOKEN);
        expect.fail('Should have thrown GuestApiError');
      } catch (error) {
        expect(error).toBeInstanceOf(GuestApiError);
        expect((error as GuestApiError).errorCode).toBe('GUEST_SESSION_RATE_LIMIT_EXCEEDED');
        expect((error as GuestApiError).statusCode).toBe(429);
      }
    });

    it('should map API error 500 to GuestApiError with INTERNAL_ERROR', async () => {
      vi.stubGlobal('fetch', makeFetchMock({
        success: false,
        message: 'Lỗi máy chủ nội bộ.',
        errorCode: 'INTERNAL_ERROR',
        details: [],
      }, false, 500));

      try {
        await getGuestSessionStatus('session-123', FIXTURE_TOKEN);
        expect.fail('Should have thrown GuestApiError');
      } catch (error) {
        expect(error).toBeInstanceOf(GuestApiError);
        expect((error as GuestApiError).errorCode).toBe('INTERNAL_ERROR');
        expect((error as GuestApiError).statusCode).toBe(500);
      }
    });

    it('should map non-JSON error body to GuestApiError with UNKNOWN_ERROR', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        text: async () => 'Bad Gateway',
      } as unknown as Response));

      try {
        await getGuestSessionStatus('session-123', FIXTURE_TOKEN);
        expect.fail('Should have thrown GuestApiError');
      } catch (error) {
        expect(error).toBeInstanceOf(GuestApiError);
        expect((error as GuestApiError).errorCode).toBe('UNKNOWN_ERROR');
        expect((error as GuestApiError).statusCode).toBe(502);
      }
    });

    it('should preserve details array when mapping error from API', async () => {
      vi.stubGlobal('fetch', makeFetchMock({
        success: false,
        message: 'Yêu cầu không hợp lệ.',
        errorCode: 'INVALID_REQUEST',
        details: [
          { field: 'sessionId', message: 'Bắt buộc' },
          { field: 'guestSessionToken', message: 'Không được để trống' },
        ],
      }, false, 400));

      try {
        await getPendingDonationStatus(FIXTURE_TOKEN);
        expect.fail('Should have thrown GuestApiError');
      } catch (error) {
        expect(error).toBeInstanceOf(GuestApiError);
        expect((error as GuestApiError).details).toHaveLength(2);
        expect((error as GuestApiError).details?.[0].field).toBe('sessionId');
        expect((error as GuestApiError).details?.[1].field).toBe('guestSessionToken');
      }
    });
  });

  describe('createGuestSession', () => {
    it('should call POST /api/guest/session and return session data', async () => {
      vi.stubGlobal('fetch', makeFetchMock({
        success: true,
        message: 'Thành công.',
        data: {
          sessionId: 'sess-001',
          guestSessionToken: 'token-abc',
          expiresAt: '2026-06-07T00:00:00.000Z',
          serverSalt: 'deadbeef',
          donationQuota: 3,
        },
        correlationId: null,
      }, true, 200));

      const result = await createGuestSession({
        walletAddress: FIXTURE_WALLET,
        deviceFingerprintHash: FIXTURE_FINGERPRINT,
      });

      expect(result.sessionId).toBe('sess-001');
      expect(result.donationQuota).toBe(3);
      expect(fetch).toHaveBeenCalledWith(
        'http://localhost:3000/api/guest/session',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('should throw GuestApiError with INVALID_WALLET_ADDRESS for malformed address', async () => {
      try {
        await createGuestSession({
          walletAddress: '0xinvalid',
          deviceFingerprintHash: FIXTURE_FINGERPRINT,
        });
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(GuestApiError);
        expect((error as GuestApiError).errorCode).toBe('INVALID_WALLET_ADDRESS');
        expect((error as GuestApiError).statusCode).toBe(400);
      }
    });

    it('should throw when API returns session limit exceeded', async () => {
      vi.stubGlobal('fetch', makeFetchMock({
        success: false,
        message: 'Đã đạt giới hạn session.',
        errorCode: 'GUEST_SESSION_LIMIT_EXCEEDED',
        details: [],
      }, false, 429));

      await expect(
        createGuestSession({ walletAddress: FIXTURE_WALLET, deviceFingerprintHash: FIXTURE_FINGERPRINT }),
      ).rejects.toMatchObject({
        errorCode: 'GUEST_SESSION_LIMIT_EXCEEDED',
        statusCode: 429,
      });
    });
  });

  describe('refreshGuestSession', () => {
    it('should return new token and renewal count on success', async () => {
      vi.stubGlobal('fetch', makeFetchMock({
        success: true,
        message: 'Thành công.',
        data: {
          guestSessionToken: 'new-token-xyz',
          expiresAt: '2026-06-08T00:00:00.000Z',
          renewalCount: 2,
        },
        correlationId: null,
      }, true, 200));

      const result = await refreshGuestSession({ sessionId: 'sess-001' }, FIXTURE_TOKEN);

      expect(result.guestSessionToken).toBe('new-token-xyz');
      expect(result.renewalCount).toBe(2);
    });

    it('should throw when renewal limit exceeded', async () => {
      vi.stubGlobal('fetch', makeFetchMock({
        success: false,
        message: 'Đã vượt quá giới hạn refresh.',
        errorCode: 'GUEST_RENEWAL_LIMIT_EXCEEDED',
        details: [],
      }, false, 429));

      await expect(
        refreshGuestSession({ sessionId: 'sess-001' }, FIXTURE_TOKEN),
      ).rejects.toMatchObject({
        errorCode: 'GUEST_RENEWAL_LIMIT_EXCEEDED',
        statusCode: 429,
      });
    });

    it('should throw when session expired', async () => {
      vi.stubGlobal('fetch', makeFetchMock({
        success: false,
        message: 'Phiên đã hết hạn.',
        errorCode: 'GUEST_SESSION_EXCEEDED',
        details: [],
      }, false, 401));

      await expect(
        refreshGuestSession({ sessionId: 'sess-001' }, 'expired-token'),
      ).rejects.toMatchObject({
        errorCode: 'GUEST_SESSION_EXCEEDED',
        statusCode: 401,
      });
    });
  });

  describe('getGuestSessionStatus', () => {
    it('should return session status with donation info', async () => {
      vi.stubGlobal('fetch', makeFetchMock({
        success: true,
        message: 'Thành công.',
        data: {
          sessionId: 'sess-001',
          walletAddress: FIXTURE_WALLET,
          status: 'ACTIVE',
          donationCount: 1,
          totalDonatedAmount: 50,
          expiresAt: '2026-06-07T00:00:00.000Z',
          remainingDonations: 2,
        },
        correlationId: null,
      }, true, 200));

      const result = await getGuestSessionStatus('session-123', FIXTURE_TOKEN);

      expect(result.sessionId).toBe('sess-001');
      expect(result.status).toBe('ACTIVE');
      expect(result.remainingDonations).toBe(2);
    });

    it('should throw when session not found', async () => {
      vi.stubGlobal('fetch', makeFetchMock({
        success: false,
        message: 'Session không tìm thấy.',
        errorCode: 'GUEST_SESSION_NOT_FOUND',
        details: [],
      }, false, 404));

      await expect(getGuestSessionStatus('invalid-token', FIXTURE_TOKEN)).rejects.toMatchObject({
        errorCode: 'GUEST_SESSION_NOT_FOUND',
        statusCode: 404,
      });
    });
  });

  describe('requestPaymasterSponsorship', () => {
    const mockUserOp = {
      sender: FIXTURE_WALLET,
      nonce: '0x1',
      initCode: '0x',
      callData: '0xabcdef',
    };

    it('should return FREE paymaster data when risk score is low', async () => {
      vi.stubGlobal('fetch', makeFetchMock({
        success: true,
        message: 'Thành công.',
        data: {
          paymasterAndData: '0xPaymasterData',
          userOpHash: '0xUserOpHash123',
          sponsorshipId: 'sponsor-001',
          paymasterType: 'FREE',
          paymasterSponsoredGas: true,
          trustMultiplier: 1.0,
          riskScore: 15,
        },
        correlationId: null,
      }, true, 200));

      const result = await requestPaymasterSponsorship(
        { unsignedUserOp: mockUserOp, projectId: 'proj-001', amount: 100, sessionId: 'sess-001' },
        FIXTURE_TOKEN,
      );

      expect(result.paymasterType).toBe('FREE');
      expect(result.gasChargeWarning).toBeUndefined();
    });

    it('should return TOKEN paymaster data with gas charge warning when risk score is high', async () => {
      vi.stubGlobal('fetch', makeFetchMock({
        success: true,
        message: 'Thành công.',
        data: {
          paymasterAndData: '0xTokenPaymasterData',
          userOpHash: '0xUserOpHash456',
          sponsorshipId: 'sponsor-002',
          paymasterType: 'TOKEN',
          paymasterSponsoredGas: false,
          trustMultiplier: 0.2,
          riskScore: 75,
          gasChargeAmount: 1,
          gasChargeWarning: true,
        },
        correlationId: null,
      }, true, 200));

      const result = await requestPaymasterSponsorship(
        { unsignedUserOp: mockUserOp, projectId: 'proj-001', amount: 100, sessionId: 'sess-001' },
        FIXTURE_TOKEN,
      );

      expect(result.paymasterType).toBe('TOKEN');
      expect(result.gasChargeWarning).toBe(true);
      expect(result.gasChargeAmount).toBe(1);
    });

    it('should throw when donation quota exceeded', async () => {
      vi.stubGlobal('fetch', makeFetchMock({
        success: false,
        message: 'Đã hết quota donation.',
        errorCode: 'GUEST_DONATION_QUOTA_EXCEEDED',
        details: [],
      }, false, 400));

      await expect(
        requestPaymasterSponsorship(
          { unsignedUserOp: mockUserOp, projectId: 'proj-001', amount: 100, sessionId: 'sess-001' },
          FIXTURE_TOKEN,
        ),
      ).rejects.toMatchObject({
        errorCode: 'GUEST_DONATION_QUOTA_EXCEEDED',
        statusCode: 400,
      });
    });

    it('should throw when amount exceeds 200 USD equivalent', async () => {
      vi.stubGlobal('fetch', makeFetchMock({
        success: false,
        message: 'Số tiền vượt quá giới hạn.',
        errorCode: 'GUEST_AMOUNT_LIMIT_EXCEEDED',
        details: [],
      }, false, 400));

      await expect(
        requestPaymasterSponsorship(
          { unsignedUserOp: mockUserOp, projectId: 'proj-001', amount: 500, sessionId: 'sess-001' },
          FIXTURE_TOKEN,
        ),
      ).rejects.toMatchObject({
        errorCode: 'GUEST_AMOUNT_LIMIT_EXCEEDED',
        statusCode: 400,
      });
    });

    it('should throw when call data is invalid', async () => {
      vi.stubGlobal('fetch', makeFetchMock({
        success: false,
        message: 'Call data không hợp lệ.',
        errorCode: 'INVALID_CALLDATA',
        details: [],
      }, false, 400));

      await expect(
        requestPaymasterSponsorship(
          { unsignedUserOp: { ...mockUserOp, callData: '0x' }, projectId: 'proj-001', amount: 100, sessionId: 'sess-001' },
          FIXTURE_TOKEN,
        ),
      ).rejects.toMatchObject({
        errorCode: 'INVALID_CALLDATA',
        statusCode: 400,
      });
    });
  });

  describe('prepareGuestClaim', () => {
    it('should return claim EOA address and nonce on success', async () => {
      vi.stubGlobal('fetch', makeFetchMock({
        success: true,
        message: 'Thành công.',
        data: {
          claimEOAAddress: '0x9f4C3b8d2a1E0f5B7c3D9e2A4b6C8d0E1f2A3B4c',
          claimNonce: 'nonce-abc-123',
        },
        correlationId: null,
      }, true, 200));

      const result = await prepareGuestClaim({
        guestSessionToken: FIXTURE_TOKEN,
        guestWalletAddress: FIXTURE_WALLET,
      }, 'user-jwt-token');

      expect(result.claimEOAAddress).toBe('0x9f4C3b8d2a1E0f5B7c3D9e2A4b6C8d0E1f2A3B4c');
      expect(result.claimNonce).toBe('nonce-abc-123');
    });

    it('should throw when user is not authenticated', async () => {
      vi.stubGlobal('fetch', makeFetchMock({
        success: false,
        message: 'Vui lòng đăng nhập.',
        errorCode: 'FORBIDDEN',
        details: [],
      }, false, 401));

      await expect(
        prepareGuestClaim({
          guestSessionToken: FIXTURE_TOKEN,
          guestWalletAddress: FIXTURE_WALLET,
        }, 'invalid-user-token'),
      ).rejects.toMatchObject({
        errorCode: 'FORBIDDEN',
        statusCode: 401,
      });
    });

    it('should throw INVALID_WALLET_ADDRESS when wallet address is malformed', async () => {
      try {
        await prepareGuestClaim({
          guestSessionToken: FIXTURE_TOKEN,
          guestWalletAddress: '0xinvalid',
        }, 'user-jwt-token');
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(GuestApiError);
        expect((error as GuestApiError).errorCode).toBe('INVALID_WALLET_ADDRESS');
        expect((error as GuestApiError).statusCode).toBe(400);
      }
    });
  });

  describe('executeGuestClaim', () => {
    it('should return claim result on success', async () => {
      vi.stubGlobal('fetch', makeFetchMock({
        success: true,
        message: 'Thành công.',
        data: {
          changeOwnerTxHash: '0xTxHash123',
          claimId: 'claim-001',
          claimType: 'NEW_ACCOUNT',
          donatedCount: 2,
        },
        correlationId: null,
      }, true, 200));

      const result = await executeGuestClaim({
        guestSessionToken: FIXTURE_TOKEN,
        guestWalletAddress: FIXTURE_WALLET,
        claimNonce: 'nonce-abc-123',
        signedUserOp: '0xSignedUserOpData',
      }, 'user-jwt-token');

      expect(result.claimType).toBe('NEW_ACCOUNT');
      expect(result.donatedCount).toBe(2);
    });

    it('should throw when claim nonce is expired', async () => {
      vi.stubGlobal('fetch', makeFetchMock({
        success: false,
        message: 'Nonce đã hết hạn.',
        errorCode: 'GUEST_SESSION_EXCEEDED',
        details: [],
      }, false, 410));

      await expect(
        executeGuestClaim({
          guestSessionToken: FIXTURE_TOKEN,
          guestWalletAddress: FIXTURE_WALLET,
          claimNonce: 'expired-nonce',
          signedUserOp: '0xSigned',
        }, 'user-jwt-token'),
      ).rejects.toMatchObject({
        errorCode: 'GUEST_SESSION_EXCEEDED',
        statusCode: 410,
      });
    });

    it('should throw INVALID_WALLET_ADDRESS when wallet address is malformed', async () => {
      try {
        await executeGuestClaim({
          guestSessionToken: FIXTURE_TOKEN,
          guestWalletAddress: 'not-a-valid-address',
          claimNonce: 'nonce-abc-123',
          signedUserOp: '0xSignedUserOpData',
        }, 'user-jwt-token');
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(GuestApiError);
        expect((error as GuestApiError).errorCode).toBe('INVALID_WALLET_ADDRESS');
        expect((error as GuestApiError).statusCode).toBe(400);
      }
    });
  });

  describe('getPendingDonationStatus', () => {
    it('should return pending donation status', async () => {
      vi.stubGlobal('fetch', makeFetchMock({
        success: true,
        message: 'Thành công.',
        data: {
          sessionId: 'sess-001',
          walletAddress: FIXTURE_WALLET,
          hasPendingDonation: true,
          donationCount: 1,
          totalDonatedAmount: 25,
          status: 'ACTIVE',
        },
        correlationId: null,
      }, true, 200));

      const result = await getPendingDonationStatus(FIXTURE_TOKEN);

      expect(result.hasPendingDonation).toBe(true);
      expect(result.totalDonatedAmount).toBe(25);
    });

    it('should throw when session not found', async () => {
      vi.stubGlobal('fetch', makeFetchMock({
        success: false,
        message: 'Session không tìm thấy.',
        errorCode: 'GUEST_SESSION_NOT_FOUND',
        details: [],
      }, false, 404));

      await expect(getPendingDonationStatus('invalid-token')).rejects.toMatchObject({
        errorCode: 'GUEST_SESSION_NOT_FOUND',
        statusCode: 404,
      });
    });
  });

  describe('clearPendingDonation', () => {
    it('should not throw when server returns 204 No Content', async () => {
      vi.stubGlobal('fetch', makeFetchMock('', true, 204));

      await expect(clearPendingDonation(FIXTURE_TOKEN)).resolves.toBeUndefined();
    });

    it('should throw GuestApiError when server returns error', async () => {
      vi.stubGlobal('fetch', makeFetchMock({
        success: false,
        message: 'Token không hợp lệ.',
        errorCode: 'GUEST_TOKEN_INVALID',
      }, false, 401));

      await expect(clearPendingDonation(FIXTURE_TOKEN)).rejects.toMatchObject({
        errorCode: 'GUEST_TOKEN_INVALID',
        statusCode: 401,
      });
    });

    it('should throw UNKNOWN_ERROR when server returns non-JSON error body', async () => {
      vi.stubGlobal('fetch', makeFetchMock('Internal Server Error', false, 500));

      await expect(clearPendingDonation(FIXTURE_TOKEN)).rejects.toMatchObject({
        errorCode: 'UNKNOWN_ERROR',
        statusCode: 500,
      });
    });

    it('should use buildApiUrl for URL consistency', async () => {
      vi.stubGlobal('fetch', makeFetchMock('', true, 204));

      await clearPendingDonation(FIXTURE_TOKEN);

      expect(fetch).toHaveBeenCalledWith(
        'http://localhost:3000/api/guest/pending-donation/clear',
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });

  describe('Error code type coverage', () => {
    it('should have all expected error codes as valid GuestApiErrorCode values', () => {
      const expectedCodes: GuestApiErrorCode[] = [
        'INVALID_WALLET_ADDRESS',
        'INVALID_FINGERPRINT',
        'GUEST_SESSION_LIMIT_EXCEEDED',
        'GUEST_SESSION_NOT_FOUND',
        'GUEST_SESSION_EXCEEDED',
        'GUEST_SESSION_NOT_ACTIVE',
        'GUEST_DONATION_QUOTA_EXCEEDED',
        'GUEST_AMOUNT_LIMIT_EXCEEDED',
        'GUEST_DONATION_RATE_LIMIT_EXCEEDED',
        'INVALID_CALLDATA',
        'DUPLICATE_USEROP',
        'PAYMASTER_POLICY_MISMATCH',
        'FORBIDDEN',
        'CONFLICT',
        'GUEST_TOKEN_REQUIRED',
        'GUEST_TOKEN_INVALID',
        'GUEST_SESSION_REQUIRED',
        'GUEST_RENEWAL_LIMIT_EXCEEDED',
        'GUEST_SESSION_RATE_LIMIT_EXCEEDED',
        'INVALID_REQUEST',
        'INTERNAL_ERROR',
        'UNKNOWN_ERROR',
        'INVALID_RESPONSE',
      ];

      expect(expectedCodes).toHaveLength(23);
    });
  });
});
