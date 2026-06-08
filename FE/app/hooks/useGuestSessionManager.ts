/**
 * Hook quản lý session lifecycle của Guest Wallet.
 * Mục đích: tách logic init, bootstrap, restore, refresh, clear session ra khỏi God Provider.
 * Tập trung vào session state và các thao tác khởi tạo/restore/refresh/clear.
 */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { BrowserCompatibilityResult, detectBrowserCompatibility } from '../utils/browserCompat';
import {
  clearGuestWallet,
  clearGuestSessionToken,
  hasGuestWallet,
  isSessionExpired,
  loadGuestWallet,
  loadGuestSessionToken,
  saveGuestWallet,
  saveGuestSessionToken,
} from '../utils/guestWalletStorage';
import {
  GuestApiError,
  createGuestSession,
  getGuestSessionStatus,
  refreshGuestSession as refreshGuestSessionApi,
  getGuestServerSalt,
} from '../utils/guestApiClient';
import { getDonationErrorMessage } from '../constants/guestErrorUtils';
import {
  MAX_DONATIONS_PER_SESSION,
} from '../constants/guestDonationLimits';

/* ============================================================
 * TYPES
 * ============================================================ */

/**
 * Trạng thái khởi tạo guest wallet — phản ánh lifecycle của toàn bộ flow.
 */
export type GuestWalletInitStatus =
  | 'IDLE'
  | 'CHECKING_BROWSER'
  | 'BROWSER_INCOMPATIBLE'
  | 'LOADING_STORAGE'
  | 'RESTORING_SESSION'
  | 'BOOTSTRAPPING_NEW'
  | 'READY'
  | 'CLAIMED'
  | 'ERROR';

/**
 * Cấu trúc trạng thái init của guest wallet.
 * Immutable update pattern — mỗi field đều có ý nghĩa rõ ràng.
 */
export interface GuestWalletInitState {
  initStatus: GuestWalletInitStatus;
  initError: string | null;
  walletAddress: string | null;
  sessionId: string | null;
  guestSessionToken: string | null;
  donationQuota: number;
  donationCount: number;
  remainingDonations: number;
  canDonate: boolean;
  hasPendingDonation: boolean;
  expiresAt: string | null;
  browserCompat: BrowserCompatibilityResult | null;
  claimPromptDismissed: boolean;
}

/* ============================================================
 * HOOK INTERFACE
 * ============================================================ */

export interface UseGuestSessionManagerReturn {
  initState: GuestWalletInitState;
  updateInitState: (updates: Partial<GuestWalletInitState>) => void;
  bootstrapGuestWallet: () => Promise<void>;
  restoreGuestSession: () => Promise<void>;
  /** Refresh session token — kéo dài expiry mà không cần tạo lại session */
  refreshGuestSession: () => Promise<void>;
  dismissClaimPrompt: () => void;
  clearGuestWalletData: () => void;
  syncPollResults: (data: {
    donationCount: number;
    remainingDonations: number;
    donationQuota: number;
    hasPendingDonation?: boolean;
  }) => void;
  /** Bootstrap trực tiếp không qua browser check — dùng cho auto-bootstrap khi status là BOOTSTRAPPING_NEW */
  bootstrapNewWallet: () => Promise<void>;
}

/* ============================================================
 * HOOK
 * ============================================================ */

/**
 * Hook quản lý session lifecycle của Guest Wallet.
 * Mục đích: tách logic init, bootstrap, restore session để giảm complexity của Provider.
 */
export function useGuestSessionManager(): UseGuestSessionManagerReturn {
  const [initState, setInitState] = useState<GuestWalletInitState>({
    initStatus: 'IDLE',
    initError: null,
    walletAddress: null,
    sessionId: null,
    guestSessionToken: null,
    donationQuota: MAX_DONATIONS_PER_SESSION,
    donationCount: 0,
    remainingDonations: MAX_DONATIONS_PER_SESSION,
    canDonate: false,
    hasPendingDonation: false,
    expiresAt: null,
    browserCompat: null,
    claimPromptDismissed: false,
  });

  // Ref để track abort signal cho cleanup — reset TRONG useEffect (sau commit)
  // để tránh race với StrictMode double-render và đảm bảo reset chạy sau cleanup
  const abortRef = useRef<boolean>(false);

  // Reset abortRef trong commit phase — đảm bảo luôn chạy SAU useEffect cleanup
  // Còn cleanup thì set true khi unmount thật để block stale updates
  useEffect(() => {
    abortRef.current = false;
    return () => {
      abortRef.current = true;
    };
  }, []);

  // Hàm tiện ích cập nhật init state immutable — guard against stale updates after unmount
  // KHÔNG đưa initState.initStatus vào deps vì initState object mới mỗi render
  // dẫn đến stale closure. Dùng prev form của setInitState để luôn đọc state mới nhất.
  const updateInitState = useCallback((updates: Partial<GuestWalletInitState>) => {
    if (abortRef.current) return;
    setInitState((prev) => ({ ...prev, ...updates }));
  }, []); // deps rỗng — dùng prev callback form thay vì đọc initState trực tiếp

  // ============================================================
  // INTERNAL HELPERS
  // ============================================================

  /** Kiểm tra browser compatibility — bước đầu tiên của init */
  const checkBrowserCompatibility = useCallback(async (): Promise<BrowserCompatibilityResult> => {
    updateInitState({ initStatus: 'CHECKING_BROWSER' });
    const compat = await detectBrowserCompatibility();
    updateInitState({ browserCompat: compat });

    if (compat.riskLevel === 'CRITICAL') {
      updateInitState({
        initStatus: 'BROWSER_INCOMPATIBLE',
        initError: 'Trình duyệt không đủ điều kiện sử dụng Guest Wallet. Vui lòng dùng trình duyệt khác.',
      });
    }
    return compat;
  }, [updateInitState]);

  /** Load từ LocalStorage và kiểm tra expiry */
  const loadStorageData = useCallback(() => {
    updateInitState({ initStatus: 'LOADING_STORAGE' });
    if (!hasGuestWallet()) {
      updateInitState({ initStatus: 'BOOTSTRAPPING_NEW' });
      return null;
    }

    const stored = loadGuestWallet();
    if (!stored) {
      updateInitState({ initStatus: 'BOOTSTRAPPING_NEW' });
      return null;
    }

    if (isSessionExpired(stored)) {
      clearGuestWallet();
      updateInitState({ initStatus: 'BOOTSTRAPPING_NEW' });
      return null;
    }

    return stored;
  }, [updateInitState]);

  /** Restore session từ server */
  const restoreSessionFromServer = useCallback(
    async (stored: NonNullable<ReturnType<typeof loadGuestWallet>>) => {
      updateInitState({
        initStatus: 'RESTORING_SESSION',
        walletAddress: stored.walletAddress,
        sessionId: stored.sessionId,
      });

      // Lấy token từ sessionStorage trước khi gọi API
      const sessionTokenData = loadGuestSessionToken();
      if (!sessionTokenData?.token) {
        // Token không tồn tại (hết hạn hoặc bị mất) — tạo session mới với ví đang có.
        // BE sẽ tạo session mới và encrypt owner key mới (dùng cùng wallet address).
        // LocalStorage dữ liệu ví cũ sẽ được ghi đè bởi bootstrapNewWallet.
        await bootstrapNewWallet();
        return;
      }

      try {
        const status = await getGuestSessionStatus(stored.sessionId, sessionTokenData.token);

        if (status.status === 'CLAIMED') {
          clearGuestWallet();
          clearGuestSessionToken();
          updateInitState({ initStatus: 'CLAIMED', canDonate: false });
          return;
        }

        if (status.status === 'EXPIRED') {
          clearGuestWallet();
          clearGuestSessionToken();
          // Session hết hạn trên BE — tạo ví mới để user có thể donate tiếp.
          await bootstrapNewWallet();
          return;
        }

        const sessionToken = sessionTokenData.token;

        updateInitState({
          initStatus: 'READY',
          walletAddress: status.walletAddress,
          sessionId: status.sessionId,
          guestSessionToken: sessionToken,
          donationQuota: status.donationQuota,
          donationCount: status.donationCount,
          remainingDonations: status.remainingDonations,
          canDonate: status.donationCount < status.donationQuota,
          hasPendingDonation: false,
          expiresAt: status.expiresAt,
          initError: null,
        });
      } catch (serverError) {
        // Chỉ log generic message, không log error object để tránh lộ thông tin internal
        console.warn('[GuestWalletProvider] Không thể xác minh session với server, dùng LocalStorage.');
        // Server unreachable — dùng stored data nếu chưa expired.
        // Token phải tồn tại trong sessionStorage sau bootstrap thành công.
        const sessionToken = sessionTokenData.token;
        if (!sessionToken) {
          clearGuestWallet();
          clearGuestSessionToken();
          updateInitState({
            initStatus: 'ERROR',
            initError: 'Session token không tồn tại. Vui lòng khởi tạo ví mới.',
          });
          return;
        }
        // donationCount không lưu trong localStorage — khi server unreachable,
        // giữ remainingDonations = donationQuota để tránh user bị block sai.
        // Nguy cơ: user có thể donate nhiều hơn quota nếu server đang down.
        // Đây là acceptable trade-off vì quota enforcement thực sự nằm ở BE.
        updateInitState({
          initStatus: 'READY',
          walletAddress: stored.walletAddress,
          sessionId: stored.sessionId,
          guestSessionToken: sessionToken,
          donationQuota: stored.donationQuota,
          donationCount: 0,
          remainingDonations: stored.donationQuota,
          canDonate: stored.donationQuota > 0,
          hasPendingDonation: false,
          expiresAt: stored.expiresAt,
          initError: null,
        });
      }
    },
    [updateInitState],
  );

  /** Bootstrap ví guest hoàn toàn mới */
  const bootstrapNewWallet = useCallback(async (): Promise<void> => {
    updateInitState({ initStatus: 'BOOTSTRAPPING_NEW', initError: null });

    try {
      // Sinh owner key bằng ethers v6 Wallet — đảm bảo format chuẩn 0x
      const { Wallet } = await import('ethers');
      const wallet = Wallet.createRandom();
      const ownerKey = wallet.privateKey;
      const walletAddress = wallet.address;

      // Sinh device fingerprint
      const { generateDeviceFingerprint } = await import('../utils/deviceFingerprint');
      const fingerprintHash = await generateDeviceFingerprint();

      // Bước 1: Lấy serverSalt từ BE để encrypt owner key
      // Chia 2 bước để BE không bao giờ thấy raw private key
      const { serverSalt } = await getGuestServerSalt(walletAddress, fingerprintHash);

      // Bước 2: Encrypt owner key bằng PBKDF2 với serverSalt
      const { encryptOwnerKey } = await import('../utils/guestWalletCrypto');
      const { encryptedOwnerKey, clientSalt, iv } = await encryptOwnerKey(
        ownerKey,
        fingerprintHash,
        serverSalt
      );

      // Bước 3: Tạo session với encrypted owner key
      const sessionResponse = await createGuestSession({
        walletAddress,
        deviceFingerprintHash: fingerprintHash,
        encryptedOwnerKey: { encryptedOwnerKey, clientSalt, iv }
      });

      // Lưu encrypted key và metadata vào localStorage, token vào sessionStorage
      const storageData = {
        encryptedOwnerKey,
        clientSalt,
        serverSalt: sessionResponse.serverSalt,
        iv,
        walletAddress,
        sessionId: sessionResponse.sessionId,
        expiresAt: sessionResponse.expiresAt,
        createdAt: new Date().toISOString(),
        donationQuota: sessionResponse.donationQuota,
      };
      saveGuestWallet(storageData);

      // Lưu token vào sessionStorage — có thể bị throw (Safari Private Mode, Brave Shields)
      // Catch để tránh uncaught error, user sẽ thấy initError thay vì crash
      try {
        saveGuestSessionToken(sessionResponse.guestSessionToken, sessionResponse.expiresAt);
      } catch (sessionStorageError) {
        // Xóa localStorage để giữ consistent state
        clearGuestWallet();
        updateInitState({
          initStatus: 'ERROR',
          initError: 'Trình duyệt không hỗ trợ lưu trữ phiên. Vui lòng tắt chế độ Private hoặc thử trình duyệt khác.',
        });
        return;
      }

      // Cập nhật state — KHÔNG auto-cache owner key vì bảo mật
      // Owner key chỉ decrypt khi user click Donate (lazy decryption)
      updateInitState({
        initStatus: 'READY',
        walletAddress,
        sessionId: sessionResponse.sessionId,
        guestSessionToken: sessionResponse.guestSessionToken,
        donationQuota: sessionResponse.donationQuota,
        donationCount: 0,
        remainingDonations: sessionResponse.donationQuota,
        canDonate: true,
        hasPendingDonation: false,
        expiresAt: sessionResponse.expiresAt,
        initError: null,
      });
    } catch (error) {
      // Chỉ log message, không log error object để tránh lộ thông tin internal
      console.error('[GuestWalletProvider] Lỗi bootstrap guest wallet.');
      updateInitState({
        initStatus: 'ERROR',
        initError: getDonationErrorMessage(error),
      });
    }
  }, [updateInitState]);

  // ============================================================
  // PUBLIC METHODS
  // ============================================================

  /** Restore session — gọi khi có LocalStorage và muốn verify với server */
  const restoreGuestSession = useCallback(async (): Promise<void> => {
    try {
      const compat = await checkBrowserCompatibility();
      if (compat.riskLevel === 'CRITICAL') return;

      const stored = loadStorageData();
      if (!stored) {
        await bootstrapNewWallet();
        return;
      }

      await restoreSessionFromServer(stored);
    } catch (error) {
      // Chỉ log message, không log error object để tránh lộ thông tin internal
      console.error('[GuestWalletProvider] Lỗi khôi phục phiên khách.');
    }
  }, [checkBrowserCompatibility, loadStorageData, restoreSessionFromServer, bootstrapNewWallet]);

  /** Bootstrap ví — khôi phục session cũ hoặc tạo ví mới nếu chưa có */
  const bootstrapGuestWallet = useCallback(async (): Promise<void> => {
    const compat = await checkBrowserCompatibility();
    if (compat.riskLevel === 'CRITICAL') return;
    await restoreGuestSession();
  }, [checkBrowserCompatibility, restoreGuestSession]);

  /** Refresh session token — kéo dài expiry mà không cần tạo lại session */
  const refreshGuestSession = useCallback(async (): Promise<void> => {
    if (!initState.sessionId || !initState.guestSessionToken) {
      throw new GuestApiError({
        success: false,
        message: 'Không có session để refresh.',
        errorCode: 'GUEST_SESSION_NOT_FOUND',
        statusCode: 400,
      });
    }

    try {
      const refreshed = await refreshGuestSessionApi(
        { sessionId: initState.sessionId },
        initState.guestSessionToken,
      );

      // Cập nhật token mới vào cả state và sessionStorage
      try {
        saveGuestSessionToken(refreshed.guestSessionToken, refreshed.expiresAt);
      } catch {
        console.error('[GuestWalletProvider] Không thể lưu session token mới.');
      }

      updateInitState({
        guestSessionToken: refreshed.guestSessionToken,
        expiresAt: refreshed.expiresAt,
      });
    } catch (error) {
      console.error('[GuestWalletProvider] Lỗi refresh session.');
      throw error;
    }
  }, [initState.sessionId, initState.guestSessionToken, updateInitState]);

  /** Xóa claim prompt */
  const dismissClaimPrompt = useCallback((): void => {
    updateInitState({ claimPromptDismissed: true });
  }, [updateInitState]);

  /** Xóa toàn bộ guest wallet data */
  const clearGuestWalletData = useCallback((): void => {
    clearGuestWallet();
    clearGuestSessionToken();
    // Reset abortRef để cho phép bootstrap mới sau khi clear
    abortRef.current = false;
    updateInitState({
      initStatus: 'IDLE',
      initError: null,
      walletAddress: null,
      sessionId: null,
      guestSessionToken: null,
      donationQuota: MAX_DONATIONS_PER_SESSION,
      donationCount: 0,
      remainingDonations: MAX_DONATIONS_PER_SESSION,
      canDonate: false,
      hasPendingDonation: false,
      expiresAt: null,
      claimPromptDismissed: false,
    });
  }, [updateInitState]);

  /** Sync kết quả poll vào state — gọi từ useGuestSessionPolling */
  const syncPollResults = useCallback((data: {
    donationCount: number;
    remainingDonations: number;
    donationQuota: number;
    hasPendingDonation?: boolean;
  }) => {
    updateInitState({
      donationCount: data.donationCount,
      remainingDonations: data.remainingDonations,
      canDonate: data.donationCount < data.donationQuota,
      hasPendingDonation: data.hasPendingDonation ?? false,
    });
  }, [updateInitState]);

  return {
    initState,
    updateInitState,
    bootstrapGuestWallet,
    restoreGuestSession,
    refreshGuestSession,
    dismissClaimPrompt,
    clearGuestWalletData,
    syncPollResults,
    bootstrapNewWallet,
  };
}
