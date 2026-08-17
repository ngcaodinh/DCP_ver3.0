'use client';

import { keepPreviousData, useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { buildApiUrl, fetchApi, type ApiErrorResponse } from '@/app/utils/apiClient';
import { authenticationSessionUpdatedEventName, readAuthSession } from '@/app/utils/authSession';
import {
  FAIR_RANKING_PAGE_SIZE,
  FAIR_RANKING_REFETCH_INTERVAL_MS,
  FAIR_RANKING_STALE_TIME_MS
} from '@/app/constants/fairRanking';
import type { FairRankingResponse, FairRankingSortBy } from '@/app/types/fairRanking';

const WALLET_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

/** Kiểm tra và lowercase wallet address trước khi gửi lên endpoint myRanking. */
export function normalizeFairRankingWalletAddress(walletAddress: string | null | undefined): string | undefined {
  if (!walletAddress || !WALLET_ADDRESS_PATTERN.test(walletAddress)) {
    return undefined;
  }
  return walletAddress.toLowerCase();
}

/** Dựng path duy nhất cho Trust-Adjusted QF API, không thêm tiền tố /api. */
export function buildTrustAdjustedRankingUrl(
  projectId: string,
  sortBy: FairRankingSortBy,
  page: number,
  donorAddress?: string
): string {
  const query = new URLSearchParams({
    projectId,
    sortBy,
    page: String(Math.max(1, Math.floor(page))),
    limit: String(FAIR_RANKING_PAGE_SIZE)
  });
  const normalizedWalletAddress = normalizeFairRankingWalletAddress(donorAddress);
  if (normalizedWalletAddress) {
    query.set('donorAddress', normalizedWalletAddress);
  }
  return `/rankings/trust-adjusted?${query.toString()}`;
}

/** Tham số điều khiển query ranking theo project, tab và trang hiện tại. */
export interface UseFairRankingOptions {
  projectId: string;
  sortBy: FairRankingSortBy;
  page: number;
  enabled: boolean;
}

/** Quyết định retry theo mã lỗi để không khuếch đại rate-limit 4xx. */
export function shouldRetryFairRanking(failureCount: number, error: ApiErrorResponse): boolean {
  if (error?.statusCode && error.statusCode >= 400 && error.statusCode < 500) return false;
  return failureCount < 1;
}

/** Hook tải ranking theo tab, polling khi active và tránh fetch tab đang ẩn. */
export function useFairRanking({ projectId, sortBy, page, enabled }: UseFairRankingOptions): UseQueryResult<FairRankingResponse, ApiErrorResponse> {
  const [donorAddress, setDonorAddress] = useState<string | undefined>();
  const [accessToken, setAccessToken] = useState<string | undefined>();
  const [isWalletResolved, setIsWalletResolved] = useState(false);

  /** Đồng bộ session sau hydration và sau mọi thay đổi login/logout/refresh trong cùng trang. */
  useEffect(() => {
    const syncAuthSession = (): void => {
      const authSession = readAuthSession();
      const walletAddress = authSession.accessToken
        ? normalizeFairRankingWalletAddress(authSession.userWalletAddress)
        : undefined;
      setAccessToken(authSession.accessToken || undefined);
      setDonorAddress(walletAddress);
      setIsWalletResolved(true);
    };

    syncAuthSession();
    window.addEventListener(authenticationSessionUpdatedEventName, syncAuthSession);
    return () => window.removeEventListener(authenticationSessionUpdatedEventName, syncAuthSession);
  }, []);

  const query = useQuery<FairRankingResponse, ApiErrorResponse>({
    queryKey: ['fairRanking', { projectId, sortBy, page, donorAddress, hasAccessToken: Boolean(accessToken) }],
    queryFn: async () => {
      try {
        const response = await fetchApi<FairRankingResponse>(
          buildApiUrl(buildTrustAdjustedRankingUrl(projectId, sortBy, page, donorAddress)),
          {
            method: 'GET',
            cache: 'no-store',
            headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined
          }
        );
        return response.data;
      } catch (error) {
        // Token hết hạn không được làm chết bảng public; đổi query key để fetch lại không kèm session.
        if ((error as ApiErrorResponse).statusCode === 401 && accessToken) {
          setAccessToken(undefined);
          setDonorAddress(undefined);
        }
        throw error;
      }
    },
    enabled: Boolean(projectId) && enabled && isWalletResolved,
    placeholderData: keepPreviousData,
    staleTime: FAIR_RANKING_STALE_TIME_MS,
    refetchInterval: enabled ? FAIR_RANKING_REFETCH_INTERVAL_MS : false,
    refetchIntervalInBackground: false,
    retry: shouldRetryFairRanking
  });

  return query;
}
