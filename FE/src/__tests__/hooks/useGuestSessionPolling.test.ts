/**
 * Unit tests cho useGuestSessionPolling hook — test polling logic và callback behavior.
 * Pattern giống các test files hiện có trong project.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useGuestSessionPolling } from '@/app/hooks/useGuestSessionPolling';

// Mock TanStack Query
const mockRefetch = vi.fn(() => Promise.resolve());
const mockOnPollData = vi.fn();

function createMockUseQueryResult(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      sessionId: 'sess123',
      walletAddress: '0x1234567890123456789012345678901234567890',
      status: 'ACTIVE',
      donationCount: 1,
      totalDonatedAmount: 100,
      donationQuota: 3,
      remainingDonations: 2,
      hasPendingDonation: false,
    },
    isFetching: false,
    isLoading: false,
    isError: false,
    isSuccess: true,
    isPlaceholderData: false,
    isStale: false,
    error: null,
    failureCount: 0,
    failureReason: null,
    refetch: mockRefetch,
    status: 'success',
    fetchStatus: 'idle',
    dataUpdatedAt: 0,
    errorUpdatedAt: 0,
    ...overrides,
  };
}

vi.mock('@tanstack/react-query', () => ({
  useQuery: vi.fn(() => createMockUseQueryResult()),
}));

// Mock storage
vi.mock('@/app/utils/guestWalletStorage', () => ({
  loadGuestSessionToken: vi.fn(() => ({
    token: 'token123',
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  })),
}));

// Mock guestApiClient
vi.mock('@/app/utils/guestApiClient', () => ({
  getGuestSessionStatus: vi.fn(() =>
    Promise.resolve({
      sessionId: 'sess123',
      walletAddress: '0x1234567890123456789012345678901234567890',
      status: 'ACTIVE',
      donationCount: 1,
      totalDonatedAmount: 100,
      donationQuota: 3,
      remainingDonations: 2,
      hasPendingDonation: false,
    }),
  ),
}));

import { useQuery } from '@tanstack/react-query';

describe('useGuestSessionPolling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    mockOnPollData.mockClear();
  });

  describe('Initial state', () => {
    it('should return isPolling false initially when isReady=false', () => {
      const { result } = renderHook(() =>
        useGuestSessionPolling({
          sessionId: 'sess123',
          isReady: false,
          onPollData: mockOnPollData,
        }),
      );

      expect(result.current.isPolling).toBe(false);
    });

    it('should return isPolling false initially when sessionId=null', () => {
      const { result } = renderHook(() =>
        useGuestSessionPolling({
          sessionId: null,
          isReady: true,
          onPollData: mockOnPollData,
        }),
      );

      expect(result.current.isPolling).toBe(false);
    });

    it('should provide refreshNow function', () => {
      const { result } = renderHook(() =>
        useGuestSessionPolling({
          sessionId: 'sess123',
          isReady: true,
          onPollData: mockOnPollData,
        }),
      );

      expect(typeof result.current.refreshNow).toBe('function');
    });
  });

  describe('Polling behavior', () => {
    it('should not enable polling when isReady=false', () => {
      renderHook(() =>
        useGuestSessionPolling({
          sessionId: 'sess123',
          isReady: false,
          onPollData: mockOnPollData,
        }),
      );

      expect(vi.mocked(useQuery)).toHaveBeenCalledWith(
        expect.objectContaining({
          enabled: false,
        }),
      );
    });

    it('should not enable polling when sessionId is null', () => {
      renderHook(() =>
        useGuestSessionPolling({
          sessionId: null,
          isReady: true,
          onPollData: mockOnPollData,
        }),
      );

      expect(vi.mocked(useQuery)).toHaveBeenCalledWith(
        expect.objectContaining({
          enabled: false,
        }),
      );
    });

    it('should enable polling when isReady=true and sessionId is not null', () => {
      renderHook(() =>
        useGuestSessionPolling({
          sessionId: 'sess123',
          isReady: true,
          onPollData: mockOnPollData,
        }),
      );

      expect(vi.mocked(useQuery)).toHaveBeenCalledWith(
        expect.objectContaining({
          enabled: true,
        }),
      );
    });

    it('should call onPollData when query returns data', () => {
      const testData = {
        sessionId: 'sess123',
        walletAddress: '0x1234567890123456789012345678901234567890',
        status: 'ACTIVE',
        donationCount: 2,
        totalDonatedAmount: 200,
        donationQuota: 3,
        remainingDonations: 1,
        hasPendingDonation: true,
      };

      vi.mocked(useQuery).mockReturnValueOnce(
        createMockUseQueryResult({ data: testData }) as unknown as ReturnType<typeof useQuery>,
      );

      renderHook(() =>
        useGuestSessionPolling({
          sessionId: 'sess123',
          isReady: true,
          onPollData: mockOnPollData,
        }),
      );

      expect(mockOnPollData).toHaveBeenCalledWith({
        donationCount: 2,
        remainingDonations: 1,
        donationQuota: 3,
        hasPendingDonation: true,
      });
    });

    it('should pass correct polling data shape to onPollData', () => {
      const testData = {
        sessionId: 'sess123',
        walletAddress: '0x1234567890123456789012345678901234567890',
        status: 'ACTIVE',
        donationCount: 0,
        totalDonatedAmount: 0,
        donationQuota: 3,
        remainingDonations: 3,
        hasPendingDonation: false,
      };

      vi.mocked(useQuery).mockReturnValueOnce(
        createMockUseQueryResult({ data: testData }) as unknown as ReturnType<typeof useQuery>,
      );

      renderHook(() =>
        useGuestSessionPolling({
          sessionId: 'sess123',
          isReady: true,
          onPollData: mockOnPollData,
        }),
      );

      expect(mockOnPollData).toHaveBeenCalledWith({
        donationCount: 0,
        remainingDonations: 3,
        donationQuota: 3,
        hasPendingDonation: false,
      });
    });

    it('should handle data without hasPendingDonation field', () => {
      const testData = {
        sessionId: 'sess123',
        walletAddress: '0x1234567890123456789012345678901234567890',
        status: 'ACTIVE',
        donationCount: 1,
        totalDonatedAmount: 100,
        donationQuota: 3,
        remainingDonations: 2,
      };

      vi.mocked(useQuery).mockReturnValueOnce(
        createMockUseQueryResult({ data: testData }) as unknown as ReturnType<typeof useQuery>,
      );

      renderHook(() =>
        useGuestSessionPolling({
          sessionId: 'sess123',
          isReady: true,
          onPollData: mockOnPollData,
        }),
      );

      expect(mockOnPollData).toHaveBeenCalledWith({
        donationCount: 1,
        remainingDonations: 2,
        donationQuota: 3,
        hasPendingDonation: false,
      });
    });

    it('should not call onPollData when data is undefined', () => {
      vi.mocked(useQuery).mockReturnValueOnce(
        createMockUseQueryResult({ data: undefined }) as unknown as ReturnType<typeof useQuery>,
      );

      renderHook(() =>
        useGuestSessionPolling({
          sessionId: 'sess123',
          isReady: true,
          onPollData: mockOnPollData,
        }),
      );

      expect(mockOnPollData).not.toHaveBeenCalled();
    });
  });

  describe('refreshNow', () => {
    it('should call refetch when refreshNow is called', async () => {
      const { result } = renderHook(() =>
        useGuestSessionPolling({
          sessionId: 'sess123',
          isReady: true,
          onPollData: mockOnPollData,
        }),
      );

      await act(async () => {
        result.current.refreshNow();
      });

      expect(mockRefetch).toHaveBeenCalled();
    });

    it('should be callable multiple times', async () => {
      const { result } = renderHook(() =>
        useGuestSessionPolling({
          sessionId: 'sess123',
          isReady: true,
          onPollData: mockOnPollData,
        }),
      );

      await act(async () => {
        result.current.refreshNow();
        result.current.refreshNow();
        result.current.refreshNow();
      });

      expect(mockRefetch).toHaveBeenCalledTimes(3);
    });
  });

  describe('isPolling state', () => {
    it('should return isPolling true when isFetching and isReady and sessionId present', () => {
      vi.mocked(useQuery).mockReturnValueOnce(
        createMockUseQueryResult({ isFetching: true }) as unknown as ReturnType<typeof useQuery>,
      );

      const { result } = renderHook(() =>
        useGuestSessionPolling({
          sessionId: 'sess123',
          isReady: true,
          onPollData: mockOnPollData,
        }),
      );

      expect(result.current.isPolling).toBe(true);
    });

    it('should return isPolling false when not fetching', () => {
      vi.mocked(useQuery).mockReturnValueOnce(
        createMockUseQueryResult({ isFetching: false }) as unknown as ReturnType<typeof useQuery>,
      );

      const { result } = renderHook(() =>
        useGuestSessionPolling({
          sessionId: 'sess123',
          isReady: true,
          onPollData: mockOnPollData,
        }),
      );

      expect(result.current.isPolling).toBe(false);
    });
  });

  describe('Query configuration', () => {
    it('should set correct queryKey', () => {
      renderHook(() =>
        useGuestSessionPolling({
          sessionId: 'sess123',
          isReady: true,
          onPollData: mockOnPollData,
        }),
      );

      expect(vi.mocked(useQuery)).toHaveBeenCalledWith(
        expect.objectContaining({
          queryKey: ['guest-session-status', 'sess123'],
        }),
      );
    });

    it('should set retry to false', () => {
      renderHook(() =>
        useGuestSessionPolling({
          sessionId: 'sess123',
          isReady: true,
          onPollData: mockOnPollData,
        }),
      );

      expect(vi.mocked(useQuery)).toHaveBeenCalledWith(
        expect.objectContaining({
          retry: false,
        }),
      );
    });

    it('should set throwOnError to false', () => {
      renderHook(() =>
        useGuestSessionPolling({
          sessionId: 'sess123',
          isReady: true,
          onPollData: mockOnPollData,
        }),
      );

      expect(vi.mocked(useQuery)).toHaveBeenCalledWith(
        expect.objectContaining({
          throwOnError: false,
        }),
      );
    });
  });
});
