/**
 * Hook quản lý các operations donation và claim của Guest Wallet.
 * Mục đích: tách logic donation execution và claim ra khỏi God Provider.
 * Tập trung vào donation state và các thao tác executeDonation/claimGuestWallet.
 */
'use client';

import { useCallback, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  GuestApiError,
  prepareGuestClaim,
  executeGuestClaim,
  requestPaymasterSponsorship,
  bindGuestEncryptedKey,
} from '../utils/guestApiClient';
import { relayGuestDonation, RelayApiError } from '../utils/guestRelayApiClient';
import { getDonationErrorMessage } from '../constants/guestErrorUtils';
import { GUEST_DONATION_ERROR_MESSAGES } from '../constants/guestDonationErrors';
import {
  buildDonateCallData,
  buildChangeOwnerCallData,
  buildClaimUserOpPayload,
} from '../utils/guestUserOpBuilder';
import {
  submitUserOpToBundler,
  submitClaimUserOpToBackend,
  fetchAccountNonce,
  estimateUserOpGas,
  DEFAULT_MAX_FEE_PER_GAS,
  DEFAULT_MAX_PRIORITY_FEE_PER_GAS,
  type BundlerUserOp,
} from '../utils/guestBundlerClient';
import {
  loadGuestWallet,
  loadGuestSessionToken,
  clearGuestWallet,
  clearGuestSessionToken,
} from '../utils/guestWalletStorage';
import {
  MAX_AMOUNT_PER_DONATION,
  MIN_AMOUNT_PER_DONATION,
  OWNER_KEY_CACHE_TTL_MS,
  WALLET_ADDRESS_REGEX,
  ENTRYPOINT_ADDRESS_V06,
} from '../constants/guestDonationLimits';
import type { GuestWalletInitState } from './useGuestSessionManager';

/* ============================================================
 * TYPES
 * ============================================================ */

/**
 * Trạng thái donation — phản ánh các bước trong luồng executeDonation.
 */
export type GuestDonationStatus =
  | 'IDLE'
  | 'DECRYPTING_KEY'
  | 'BUILDING_USER_OP'
  | 'REQUESTING_PAYMASTER'
  | 'SUBMITTING_BUNDLER'
  | 'INDEXING'
  | 'SUCCESS'
  | 'FAILED';

/**
 * Cấu trúc trạng thái donation — dùng cho UI feedback trong DonationModal.
 */
export interface GuestDonationState {
  donationStatus: GuestDonationStatus;
  donationError: string | null;
  lastUserOpHash: string | null;
  lastTxHash: string | null;
}

/* ============================================================
 * HOOK INTERFACE
 * ============================================================ */

export interface UseGuestWalletOpsReturn {
  donationState: GuestDonationState;
  executeDonation: (projectId: string, amount: number, initState: GuestWalletInitState) => Promise<boolean>;
  /** Thực hiện donation qua backend relay — user chỉ click, không cần sign.
   * Backend tự build transaction và gửi lên chain. */
  executeRelayDonation: (projectId: string, amount: number, initState: GuestWalletInitState) => Promise<boolean>;
  claimGuestWallet: (authToken: string, initState: GuestWalletInitState) => Promise<boolean>;
  getCachedOwnerKey: () => string | null;
  setOwnerKeyCache: (key: string) => void;
  clearOwnerKeyCache: () => void;
  clearDonationState: () => void;
}

/* ============================================================
 * HELPERS
 * ============================================================ */

/**
 * Verify wallet address hợp lệ.
 * Mục đích: đảm bảo địa chỉ ví đúng format trước khi dùng.
 */
function isValidWalletAddress(address: string): boolean {
  return WALLET_ADDRESS_REGEX.test(address);
}

/**
 * Sign dữ liệu bằng owner key theo EIP-191 standard (personal_sign).
 * Dùng ethers v6 SigningKey để tạo ECDSA signature.
 * Chú ý: truyền getBytes(data) để convert hex string thành bytes trước khi hash,
 * tránh ethers hiểu nhầm là UTF-8 literal string.
 *
 * @param ownerKey - Private key dạng hex (có prefix 0x)
 * @param data - Hex string cần ký (userOpHash)
 * @returns Signature serialized (r + s + v)
 */
async function signData(ownerKey: string, data: string): Promise<string> {
  const { SigningKey, hashMessage, getBytes } = await import('ethers');
  const signingKey = new SigningKey(ownerKey);
  return signingKey.sign(hashMessage(getBytes(data))).serialized;
}

/**
 * Lấy session token từ state hoặc sessionStorage.
 * Ưu tiên state vì đã được update khi init thành công.
 */
function getSessionToken(initState: GuestWalletInitState): string {
  let sessionToken = initState.guestSessionToken;
  if (!sessionToken) {
    const tokenData = loadGuestSessionToken();
    if (!tokenData?.token) {
      throw new GuestApiError({
        success: false,
        message: 'Session token không tồn tại. Vui lòng khởi tạo ví mới.',
        errorCode: 'GUEST_TOKEN_REQUIRED',
        statusCode: 401,
      });
    }
    sessionToken = tokenData.token;
  }
  return sessionToken;
}

/* ============================================================
 * HOOK
 * ============================================================ */

/**
 * Hook quản lý các operations donation và claim của Guest Wallet.
 * Mục đích: tách logic donation execution và claim để giảm complexity của Provider.
 */
export function useGuestWalletOps(): UseGuestWalletOpsReturn {
  const [donationState, setDonationState] = useState<GuestDonationState>({
    donationStatus: 'IDLE',
    donationError: null,
    lastUserOpHash: null,
    lastTxHash: null,
  });

  // Cache owner key decrypted — KHÔNG BAO GIỜ lưu vào state (tránh serialization)
  const ownerKeyCacheRef = useRef<{ key: string; expiresAt: number } | null>(null);
  const ownerKeyTtlRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Guard chống concurrent donations — ngăn user click nhiều lần trong lúc đang execute
  const donationInProgressRef = useRef(false);

  // QueryClient cho TanStack Query — dùng để invalidate queries sau donation thành công
  const queryClient = useQueryClient();

  // Hàm tiện ích cập nhật donation state
  const updateDonationState = useCallback((updates: Partial<GuestDonationState>) => {
    setDonationState((prev) => ({ ...prev, ...updates }));
  }, []);

  // Hàm cache owner key với TTL — tự động clear sau OWNER_KEY_CACHE_TTL_MS
  const setOwnerKeyCache = useCallback((key: string) => {
    if (ownerKeyTtlRef.current) {
      clearTimeout(ownerKeyTtlRef.current);
    }
    ownerKeyCacheRef.current = { key, expiresAt: Date.now() + OWNER_KEY_CACHE_TTL_MS };
    ownerKeyTtlRef.current = setTimeout(() => {
      ownerKeyCacheRef.current = null;
    }, OWNER_KEY_CACHE_TTL_MS);
  }, []);

  /**
   * Lấy owner key từ cache nếu còn valid.
   * Trả về null nếu cache miss — caller phải tự decrypt.
   * KHÔNG trả về empty string để tránh ambiguous với private key thực.
   */
  const getCachedOwnerKey = useCallback((): string | null => {
    const cached = ownerKeyCacheRef.current;
    if (cached && cached.expiresAt > Date.now()) {
      return cached.key;
    }
    return null;
  }, []);

  // Hàm xóa owner key cache
  // Lưu ý: JavaScript không hỗ trợ zero-out bộ nhớ trực tiếp.
  // Clearing ref giúp GC thu hồi sớm hơn nhưng không đảm bảo xóa ngay lập tức.
  // Đây là trade-off chấp nhận được cho browser security model.
  const clearOwnerKeyCache = useCallback(() => {
    ownerKeyCacheRef.current = null;
    if (ownerKeyTtlRef.current) {
      clearTimeout(ownerKeyTtlRef.current);
      ownerKeyTtlRef.current = null;
    }
  }, []);

  /** Xóa donation state */
  const clearDonationState = useCallback(() => {
    setDonationState({
      donationStatus: 'IDLE',
      donationError: null,
      lastUserOpHash: null,
      lastTxHash: null,
    });
  }, []);

  // ============================================================
  // EXECUTE DONATION
  // ============================================================

  /**
   * Thực hiện donation qua backend relay.
   * Backend tự build transaction (approve + donate) và gửi lên chain.
   * User chỉ click — không cần sign, không cần popup.
   *
   * Luồng Backend Relay:
   * 1. Gửi request lên BE với projectId, amount, sessionId
   * 2. BE đọc encrypted owner key từ DB
   * 3. BE giải mã → tạo kernel client → build tx → send
   * 4. BE trả về transactionHash
   */
  const executeRelayDonation = useCallback(
    async (projectId: string, amount: number, initState: GuestWalletInitState): Promise<boolean> => {
      if (!initState.walletAddress || !initState.sessionId) {
        updateDonationState({
          donationStatus: 'FAILED',
          donationError: 'Guest wallet chưa được khởi tạo.',
        });
        return false;
      }

      if (!isValidWalletAddress(initState.walletAddress)) {
        updateDonationState({
          donationStatus: 'FAILED',
          donationError: 'Địa chỉ ví không hợp lệ. Vui lòng khởi tạo ví mới.',
        });
        return false;
      }

      if (initState.remainingDonations <= 0) {
        updateDonationState({
          donationStatus: 'FAILED',
          donationError: GUEST_DONATION_ERROR_MESSAGES.GUEST_DONATION_QUOTA_EXCEEDED!,
        });
        return false;
      }

      if (amount < MIN_AMOUNT_PER_DONATION || amount > MAX_AMOUNT_PER_DONATION) {
        updateDonationState({
          donationStatus: 'FAILED',
          donationError: `Số token quyên góp phải từ ${MIN_AMOUNT_PER_DONATION} đến ${MAX_AMOUNT_PER_DONATION.toLocaleString()}.`,
        });
        return false;
      }

      if (donationInProgressRef.current) {
        return false;
      }
      donationInProgressRef.current = true;

      updateDonationState({ donationStatus: 'SUBMITTING_BUNDLER', donationError: null });

      try {
        const sessionToken = getSessionToken(initState);

        const result = await relayGuestDonation(
          {
            projectId,
            amount,
            sessionId: initState.sessionId,
            sender: initState.walletAddress,
          },
          sessionToken
        );

        updateDonationState({
          donationStatus: 'SUCCESS',
          donationError: null,
          lastUserOpHash: null,
          lastTxHash: result.transactionHash,
        });
        return true;
      } catch (error) {
        console.error('[GuestWalletProvider] Lỗi executeRelayDonation.');

        let errorMessage = 'Lỗi kết nối không xác định.';
        if (error instanceof RelayApiError) {
          errorMessage = error.message;
        } else if (error instanceof Error) {
          errorMessage = error.message;
        }

        updateDonationState({
          donationStatus: 'FAILED',
          donationError: errorMessage,
        });
        return false;
      } finally {
        donationInProgressRef.current = false;
        await queryClient.invalidateQueries({ queryKey: ['guest-session-status', initState.sessionId] });
      }
    },
    [updateDonationState, queryClient]
  );

  /**
   * Thực hiện donation guest.
   *
   * Luồng EIP-4337 đúng chuẩn:
   * 1. Decrypt owner key (lazy — chỉ khi user click Donate)
   * 2. Build unsigned UserOp với calldata donate(projectId, amount, true)
   * 3. Gửi unsignedUserOp lên BE → Paymaster sponsor → nhận signedPaymasterAndData + userOpHash
   * 4. Sign trực tiếp lên userOpHash (KHÔNG phải EIP-191 message tùy chỉnh)
   * 5. Gửi signed UserOp lên Bundler → EntryPoint → on-chain donate()
   */
  const executeDonation = useCallback(
    async (projectId: string, amount: number, initState: GuestWalletInitState): Promise<boolean> => {
      // Validate wallet address format trước khi thực hiện donation
      // Defense-in-depth: đảm bảo dữ liệu từ LocalStorage không bị user sửa thủ công
      if (!initState.walletAddress || !initState.sessionId) {
        updateDonationState({
          donationStatus: 'FAILED',
          donationError: 'Guest wallet chưa được khởi tạo.',
        });
        return false;
      }
      if (!isValidWalletAddress(initState.walletAddress)) {
        updateDonationState({
          donationStatus: 'FAILED',
          donationError: 'Địa chỉ ví không hợp lệ. Vui lòng khởi tạo ví mới.',
        });
        return false;
      }
      if (initState.remainingDonations <= 0) {
        updateDonationState({
          donationStatus: 'FAILED',
          donationError: GUEST_DONATION_ERROR_MESSAGES.GUEST_DONATION_QUOTA_EXCEEDED!,
        });
        return false;
      }
      if (amount < MIN_AMOUNT_PER_DONATION || amount > MAX_AMOUNT_PER_DONATION) {
        updateDonationState({
          donationStatus: 'FAILED',
          donationError: `Số token quyên góp phải từ ${MIN_AMOUNT_PER_DONATION} đến ${MAX_AMOUNT_PER_DONATION.toLocaleString()}.`,
        });
        return false;
      }

      // Guard chống concurrent donations — ngăn double-click
      if (donationInProgressRef.current) {
        return false;
      }
      donationInProgressRef.current = true;

      updateDonationState({ donationStatus: 'DECRYPTING_KEY', donationError: null });

      try {
        const stored = loadGuestWallet();
        if (!stored) {
          throw new Error('Dữ liệu guest wallet không tồn tại trong LocalStorage.');
        }

        // Thử lấy owner key từ cache trước, nếu không có thì decrypt
        let ownerKey: string | null = getCachedOwnerKey();
        if (!ownerKey) {
          const { decryptOwnerKey } = await import('../utils/guestWalletCrypto');
          const { generateDeviceFingerprint } = await import('../utils/deviceFingerprint');
          const fingerprintHash = await generateDeviceFingerprint();
          ownerKey = await decryptOwnerKey(
            {
              encryptedOwnerKey: stored.encryptedOwnerKey,
              clientSalt: stored.clientSalt,
              iv: stored.iv,
            },
            fingerprintHash,
            stored.serverSalt,
          );
          setOwnerKeyCache(ownerKey);
        }

        // Build unsigned UserOp
        updateDonationState({ donationStatus: 'BUILDING_USER_OP' });

        // Lấy token từ state hoặc sessionStorage
        const sessionToken = getSessionToken(initState);

        // Build callData một lần — tránh gọi lại ethers import
        const callData = await buildDonateCallData(projectId, amount, true);

        // Fetch account nonce từ EntryPoint trước khi build UserOp
        updateDonationState({ donationStatus: 'BUILDING_USER_OP' });
        const accountNonce = await fetchAccountNonce(initState.walletAddress);

        // Estimate gas limits — truyền vào unsignedUserOp để Paymaster BE tính paymasterAndData chính xác
        const entryPoint = process.env.NEXT_PUBLIC_ENTRYPOINT_ADDRESS ?? ENTRYPOINT_ADDRESS_V06;
        const gasLimits = await estimateUserOpGas(
          { sender: initState.walletAddress, callData },
          entryPoint,
        );

        // Gửi unsigned UserOp lên BE để Paymaster sponsor — truyền đủ gas limits để BE tính paymasterAndData đúng
        updateDonationState({ donationStatus: 'REQUESTING_PAYMASTER' });
        const paymasterResponse = await requestPaymasterSponsorship(
          {
            unsignedUserOp: {
              sender: initState.walletAddress,
              nonce: accountNonce,
              initCode: '0x',
              callData,
              callGasLimit: gasLimits.callGasLimit,
              verificationGasLimit: gasLimits.verificationGasLimit,
              preVerificationGas: gasLimits.preVerificationGas,
              maxFeePerGas: DEFAULT_MAX_FEE_PER_GAS,
              maxPriorityFeePerGas: DEFAULT_MAX_PRIORITY_FEE_PER_GAS,
            },
            projectId,
            amount,
            sessionId: initState.sessionId,
          },
          sessionToken,
        );

        // Sign trực tiếp lên userOpHash — đúng chuẩn EIP-4337
        // KHÔNG sign EIP-191 message tùy chỉnh "DCP-Donate:..."
        // PaymasterResponse.userOpHash là hash chuẩn được tính bởi EntryPoint
        updateDonationState({ donationStatus: 'SUBMITTING_BUNDLER' });
        const signedUserOp = await signData(ownerKey, paymasterResponse.userOpHash);

        // Build UserOp đầy đủ với signature và paymasterAndData
        const userOp: BundlerUserOp = {
          sender: initState.walletAddress,
          nonce: accountNonce,
          initCode: '0x',
          callData,
          callGasLimit: gasLimits.callGasLimit,
          verificationGasLimit: gasLimits.verificationGasLimit,
          preVerificationGas: gasLimits.preVerificationGas,
          maxFeePerGas: DEFAULT_MAX_FEE_PER_GAS,
          maxPriorityFeePerGas: DEFAULT_MAX_PRIORITY_FEE_PER_GAS,
          paymasterAndData: paymasterResponse.paymasterAndData,
          signature: signedUserOp,
        };

        // Gửi signed UserOp lên Bundler
        const bundlerResponse = await submitUserOpToBundler(userOp, gasLimits);

        // Index donation event
        updateDonationState({ donationStatus: 'INDEXING' });

        updateDonationState({
          donationStatus: 'SUCCESS',
          donationError: null,
          lastUserOpHash: paymasterResponse.userOpHash,
          lastTxHash: bundlerResponse?.txHash ?? null,
        });
        return true;
      } catch (error) {
        // Chỉ log message, không log error object để tránh lộ thông tin internal
        console.error('[GuestWalletProvider] Lỗi executeDonation.');
        updateDonationState({
          donationStatus: 'FAILED',
          donationError: getDonationErrorMessage(error),
        });
        return false;
      } finally {
        // Invalidate queries trong finally để đảm bảo cleanup luôn chạy,
        // kể cả khi component unmount trong quá trình donation.
        donationInProgressRef.current = false;
        await queryClient.invalidateQueries({ queryKey: ['guest-session-status', initState.sessionId] });
        clearOwnerKeyCache();
      }
    },
    [updateDonationState, getCachedOwnerKey, setOwnerKeyCache, clearOwnerKeyCache, queryClient],
  );

  // ============================================================
  // CLAIM GUEST WALLET
  // ============================================================

  /**
   * Claim guest wallet — gọi khi user đã đăng nhập.
   * Throw error nếu fail để caller có thể hiển thị lỗi cụ thể cho user.
   *
   * Luồng EIP-4337 đúng chuẩn cho Keyless Claim:
   * 1. Gọi BE prepareGuestClaim → nhận claimEOAAddress + claimNonce
   * 2. Build calldata cho Kernel.changeOwner(claimEOAAddress)
   * 3. Gửi calldata lên BE → nhận userOpHash chuẩn EIP-4337
   * 4. Sign trực tiếp lên userOpHash (KHÔNG phải EIP-191 message tùy chỉnh)
   * 5. Gửi signedUserOp lên BE → BE submit lên Bundler → Kernel.changeOwner() on-chain
   */
  const claimGuestWallet = useCallback(
    async (authToken: string, initState: GuestWalletInitState): Promise<boolean> => {
      const stored = loadGuestWallet();
      const sessionToken = getSessionToken(initState);

      // Validate wallet address format trước khi thực hiện claim
      if (!stored || !initState.walletAddress || !isValidWalletAddress(initState.walletAddress)) {
        return false;
      }

      try {
        // Bước 1: Backend sinh claimEOA, trả về claimNonce
        const prepareResponse = await prepareGuestClaim(
          {
            guestSessionToken: sessionToken,
            guestWalletAddress: initState.walletAddress,
          },
          authToken,
        );

        // Bước 2: Decrypt owner key
        const { decryptOwnerKey } = await import('../utils/guestWalletCrypto');
        const { generateDeviceFingerprint } = await import('../utils/deviceFingerprint');
        const fingerprintHash = await generateDeviceFingerprint();
        const ownerKey = await decryptOwnerKey(
          {
            encryptedOwnerKey: stored.encryptedOwnerKey,
            clientSalt: stored.clientSalt,
            iv: stored.iv,
          },
          fingerprintHash,
          stored.serverSalt,
        );

        // Bước 3: Build calldata cho Kernel.changeOwner(claimEOAAddress)
        const changeOwnerCallData = await buildChangeOwnerCallData(prepareResponse.claimEOAAddress);

        // Bước 4: Gửi calldata lên BE → nhận userOpHash chuẩn EIP-4337
        const claimPayload = await buildClaimUserOpPayload(
          initState.walletAddress,
          changeOwnerCallData,
        );
        const claimPayloadResponse = await submitClaimUserOpToBackend(
          claimPayload,
          authToken,
        );

        // Bước 5: Sign trực tiếp lên userOpHash — đúng chuẩn EIP-4337
        // KHÔNG sign EIP-191 message tùy chỉnh "DCP-Claim:..."
        const signedUserOp = await signData(ownerKey, claimPayloadResponse.userOpHash);

        // Bước 6: Execute claim — backend gửi signed UserOp lên Bundler
        await executeGuestClaim(
          {
            guestSessionToken: sessionToken,
            guestWalletAddress: initState.walletAddress,
            claimNonce: prepareResponse.claimNonce,
            signedUserOp,
          },
          authToken,
        );

        // Cleanup — xóa cả localStorage và sessionStorage sau khi claim thành công
        clearGuestWallet();
        clearGuestSessionToken();
        clearOwnerKeyCache();

        return true;
      } catch (error) {
        // Chỉ log message, không log error object để tránh lộ thông tin internal
        console.error('[GuestWalletProvider] Lỗi claim guest wallet.');
        // Re-throw để DonationModal có thể hiển thị lỗi cụ thể cho user
        throw error;
      }
    },
    [clearOwnerKeyCache],
  );

  return {
    donationState,
    executeDonation,
    executeRelayDonation,
    claimGuestWallet,
    getCachedOwnerKey,
    setOwnerKeyCache,
    clearOwnerKeyCache,
    clearDonationState,
  };
}
