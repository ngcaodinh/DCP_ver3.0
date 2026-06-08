/**
 * GuestWalletProvider — React Context cho toàn bộ luồng Guest Wallet.
 * Mục đích: cung cấp trạng thái và methods để init, restore, donate từ guest wallet
 * mà không cần đăng nhập. Provider wrap toàn bộ donate flow trong app.
 *
 * Kiến trúc tách layer:
 * - useGuestSessionManager: session lifecycle (init, bootstrap, restore, refresh, clear)
 * - useGuestSessionPolling: TanStack Query polling cho session status
 * - useGuestWalletOps: donation execution và claim operations
 *
 * NGUYÊN TẮC BẢO MẬT:
 * - Owner key chỉ decrypt khi user click "Donate" (lazy decryption)
 * - Owner key KHÔNG BAO GIỜ được log, gửi qua network, hoặc lưu dạng plain text
 * - Encrypted key chỉ có thể giải mã trên thiết bị tạo ra nó
 * - Owner key cache tự động clear sau 5 phút nếu không dùng
 */
'use client';

import { createContext, useCallback, useEffect, useMemo, useRef, useContext } from 'react';
import { useGuestSessionManager } from '../hooks/useGuestSessionManager';
import { useGuestSessionPolling } from '../hooks/useGuestSessionPolling';
import { useGuestWalletOps } from '../hooks/useGuestWalletOps';
import type { GuestWalletInitState } from '../hooks/useGuestSessionManager';
import type { GuestDonationState } from '../hooks/useGuestWalletOps';

/* ============================================================
 * TYPES
 * ============================================================ */

export type { GuestWalletInitStatus } from '../hooks/useGuestSessionManager';
export type { GuestDonationStatus } from '../hooks/useGuestWalletOps';
export type { GuestWalletInitState } from '../hooks/useGuestSessionManager';
export type { GuestDonationState } from '../hooks/useGuestWalletOps';

/**
 * Cấu trúc context của guest wallet — expose state + methods cho consumer components.
 */
export interface GuestWalletContextValue {
  initState: GuestWalletInitState;
  donationState: GuestDonationState;
  /** Khởi tạo bootstrap mới — gọi khi chưa có LocalStorage */
  bootstrapGuestWallet: () => Promise<void>;
  /** Restore session — gọi khi có LocalStorage và muốn verify với server */
  restoreGuestSession: () => Promise<void>;
  /** Refresh session token — kéo dài expiry mà không cần tạo lại session */
  refreshGuestSession: () => Promise<void>;
  /** Luồng EIP-4337: FE decrypt key → sign → Bundler (giữ lại fallback) */
  executeDonation: (projectId: string, amount: number) => Promise<boolean>;
  /** Luồng Backend Relay: BE tự build tx và gửi — user chỉ click */
  executeRelayDonation: (projectId: string, amount: number) => Promise<boolean>;
  dismissClaimPrompt: () => void;
  claimGuestWallet: (authToken: string) => Promise<boolean>;
  clearGuestWalletData: () => void;
}

/* ============================================================
 * CONTEXT
 * ============================================================ */

const GuestWalletContext = createContext<GuestWalletContextValue | null>(null);

/* ============================================================
 * PROVIDER COMPONENT
 * ============================================================ */

interface GuestWalletProviderProps {
  children: React.ReactNode;
}

/**
 * Provider wrap toàn bộ donate flow.
 * Tự động init khi mount — kiểm tra LocalStorage và server status.
 * Compose 3 hooks để tách biệt concerns:
 * - Session lifecycle: useGuestSessionManager
 * - Polling: useGuestSessionPolling
 * - Operations: useGuestWalletOps
 */
export function GuestWalletProvider({ children }: GuestWalletProviderProps) {
  // Ref ngăn chặn concurrent init (React StrictMode, route changes)
  const initInProgressRef = useRef(false);

  // ============================================================
  // HOOKS — COMPOSE SESSION + POLLING + OPS
  // ============================================================

  const {
    initState,
    updateInitState,
    bootstrapGuestWallet,
    bootstrapNewWallet,
    restoreGuestSession,
    refreshGuestSession,
    dismissClaimPrompt,
    clearGuestWalletData,
    syncPollResults,
  } = useGuestSessionManager();

  const {
    donationState,
    executeDonation: opsExecuteDonation,
    executeRelayDonation: opsExecuteRelayDonation,
    claimGuestWallet: opsClaimGuestWallet,
    clearDonationState,
    clearOwnerKeyCache,
  } = useGuestWalletOps();

  // Polling — chỉ active khi session READY
  const isReady = initState.initStatus === 'READY';
  useGuestSessionPolling({
    sessionId: initState.sessionId,
    isReady,
    onPollData: syncPollResults,
  });

  // ============================================================
  // CLEANUP ON UNMOUNT
  // ============================================================

  useEffect(() => {
    return () => {
      clearOwnerKeyCache();
    };
  }, [clearOwnerKeyCache]);

  // ============================================================
  // WRAPPED METHODS
  // ============================================================

  const wrappedExecuteDonation = useCallback(
    async (projectId: string, amount: number): Promise<boolean> => {
      return await opsExecuteDonation(projectId, amount, initState);
    },
    [opsExecuteDonation, initState],
  );

  const wrappedExecuteRelayDonation = useCallback(
    async (projectId: string, amount: number): Promise<boolean> => {
      return await opsExecuteRelayDonation(projectId, amount, initState);
    },
    [opsExecuteRelayDonation, initState],
  );

  const wrappedClaimGuestWallet = useCallback(
    async (authToken: string): Promise<boolean> => {
      const result = await opsClaimGuestWallet(authToken, initState);
      if (result) {
        updateInitState({ initStatus: 'CLAIMED', canDonate: false, claimPromptDismissed: true });
      }
      return result;
    },
    [opsClaimGuestWallet, initState, updateInitState],
  );

  const wrappedClearGuestWalletData = useCallback(() => {
    clearDonationState();
    clearGuestWalletData();
  }, [clearDonationState, clearGuestWalletData]);

  // ============================================================
  // CONTEXT VALUE
  // ============================================================

  const contextValue = useMemo<GuestWalletContextValue>(() => {
    return ({
      initState,
      donationState,
      bootstrapGuestWallet,
      restoreGuestSession,
      refreshGuestSession,
      executeDonation: wrappedExecuteDonation,
      executeRelayDonation: wrappedExecuteRelayDonation,
      dismissClaimPrompt,
      claimGuestWallet: wrappedClaimGuestWallet,
      clearGuestWalletData: wrappedClearGuestWalletData,
    });
  }, [
    initState,
    donationState,
    bootstrapGuestWallet,
    restoreGuestSession,
    refreshGuestSession,
    wrappedExecuteDonation,
    wrappedExecuteRelayDonation,
    dismissClaimPrompt,
    wrappedClaimGuestWallet,
    wrappedClearGuestWalletData,
  ]);

  return (
    <GuestWalletContext.Provider value={contextValue}>{children}</GuestWalletContext.Provider>
  );
}

/* ============================================================
 * HOOK
 * ============================================================ */

/**
 * Hook để consume GuestWalletContext.
 * Mục đích: cung cấp type-safe access vào guest wallet state/methods.
 */
export function useGuestWallet(): GuestWalletContextValue {
  const context = useContext(GuestWalletContext);
  if (!context) {
    throw new Error('useGuestWallet phải được gọi bên trong GuestWalletProvider.');
  }
  return context;
}

