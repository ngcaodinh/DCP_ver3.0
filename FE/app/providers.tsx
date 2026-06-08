'use client';

/**
 * QueryClientProvider cho TanStack Query v5 trong Next.js App Router.
 * Dùng useState để đảm bảo QueryClient được tạo 1 lần duy nhất (singleton).
 * Mục đích: cung cấp TanStack Query context cho toàn bộ app,
 * cần thiết cho GuestWalletProvider (useGuestWalletOps dùng useQueryClient).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 60 * 1000,
        retry: 1,
      },
    },
  });
}

let browserQueryClient: QueryClient | undefined = undefined;

/**
 * Lấy QueryClient phù hợp cho môi trường.
 * Server: luôn tạo mới (mỗi request một instance).
 * Browser: reuse cùng instance (singleton).
 */
function getQueryClient(): QueryClient {
  if (typeof window === 'undefined') {
    return makeQueryClient();
  }
  if (!browserQueryClient) {
    browserQueryClient = makeQueryClient();
  }
  return browserQueryClient;
}

interface QueryClientProviderWrapperProps {
  children: React.ReactNode;
}

/**
 * Component bọc TanStack Query provider — an toàn cho SSR.
 * Tái tạo QueryClient khi server render, reuse khi hydrate.
 */
export function QueryClientProviderWrapper({ children }: QueryClientProviderWrapperProps) {
  const [queryClient] = useState(() => getQueryClient());

  return (
    <QueryClientProvider client={queryClient}>
      {children}
    </QueryClientProvider>
  );
}
