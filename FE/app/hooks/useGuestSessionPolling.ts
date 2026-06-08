/**
 * Hook quản lý TanStack Query polling cho session status.
 * Mục đích: tách polling logic ra khỏi Provider để dễ test và maintain.
 */
'use client';

import { useCallback, useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getGuestSessionStatus } from '../utils/guestApiClient';
import { loadGuestSessionToken } from '../utils/guestWalletStorage';
import { SESSION_POLL_INTERVAL_MS } from '../constants/guestDonationLimits';

interface UseGuestSessionPollingOptions {
  sessionId: string | null;
  isReady: boolean;
  onPollData: (data: {
    donationCount: number;
    remainingDonations: number;
    donationQuota: number;
    hasPendingDonation?: boolean;
  }) => void;
}

interface UseGuestSessionPollingReturn {
  isPolling: boolean;
  refreshNow: () => void;
}

/**
 * Hook quản lý TanStack Query polling cho guest session status.
 * Poll server mỗi SESSION_POLL_INTERVAL_MS để sync donationCount real-time.
 * Backoff khi server errors: double interval lên đến MAX_POLL_INTERVAL_MS.
 */
export function useGuestSessionPolling({
  sessionId,
  isReady,
  onPollData,
}: UseGuestSessionPollingOptions): UseGuestSessionPollingReturn {
  const onPollDataRef = useRef(onPollData);
  const backoffRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const currentIntervalRef = useRef(SESSION_POLL_INTERVAL_MS);

  // Cập nhật ref trong effect để tránh side-effect trong render phase (Concurrent Mode safe)
  useEffect(() => {
    onPollDataRef.current = onPollData;
  }, [onPollData]);

  // Lấy token từ sessionStorage — cần thiết cho API call
  const getToken = useCallback((): string | null => {
    const tokenData = loadGuestSessionToken();
    return tokenData?.token ?? null;
  }, []);

  const sessionQuery = useQuery({
    queryKey: ['guest-session-status', sessionId],
    queryFn: async () => {
      if (!sessionId) throw new Error('No session ID');
      const token = getToken();
      if (!token) throw new Error('No session token');
      return getGuestSessionStatus(sessionId, token);
    },
    enabled: isReady && !!sessionId,
    refetchInterval: currentIntervalRef.current,
    refetchIntervalInBackground: false,
    retry: false,
    gcTime: 1000 * 60 * 5, // 5 phút — cleanup stale queries
    throwOnError: false,
  });

  // Backoff: tăng interval khi query thất bại, reset khi thành công
  const MAX_POLL_INTERVAL_MS = 60 * 1000;
  const BASE_POLL_INTERVAL_MS = SESSION_POLL_INTERVAL_MS;

  useEffect(() => {
    if (!sessionQuery.isError && !sessionQuery.isFetching) return;

    if (sessionQuery.isError) {
      // Tăng interval gấp đôi, tối đa MAX_POLL_INTERVAL_MS
      currentIntervalRef.current = Math.min(
        currentIntervalRef.current * 2,
        MAX_POLL_INTERVAL_MS,
      );
    } else if (sessionQuery.isSuccess) {
      // Reset về base interval khi query thành công
      currentIntervalRef.current = BASE_POLL_INTERVAL_MS;
    }
  }, [sessionQuery.isError, sessionQuery.isFetching, sessionQuery.isSuccess]);

  useEffect(() => {
    if (!sessionQuery.data) return;
    onPollDataRef.current({
      donationCount: sessionQuery.data.donationCount,
      remainingDonations: sessionQuery.data.remainingDonations,
      donationQuota: sessionQuery.data.donationQuota,
      hasPendingDonation: sessionQuery.data.hasPendingDonation ?? false,
    });
  }, [sessionQuery.data]);

  // Cleanup: xóa interval khi hook unmount hoặc polling bị disable
  useEffect(() => {
    return () => {
      if (backoffRef.current !== null) {
        clearInterval(backoffRef.current);
        backoffRef.current = null;
      }
      currentIntervalRef.current = BASE_POLL_INTERVAL_MS;
    };
  }, []);

  const refreshNow = useCallback(() => {
    void sessionQuery.refetch();
  }, [sessionQuery.refetch]);

  return {
    isPolling: sessionQuery.isFetching && isReady && !!sessionId,
    refreshNow,
  };
}
