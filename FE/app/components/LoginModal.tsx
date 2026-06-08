'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { persistAuthSession } from '../utils/authSession';

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (options: {
            client_id: string;
            callback: (response: { credential?: string }) => void;
            use_fedcm_for_prompt?: boolean;
          }) => void;
          prompt: (notificationHandler?: (notification: {
            isNotDisplayed?: () => boolean;
            isSkippedMoment?: () => boolean;
            isDismissedMoment?: () => boolean;
            getNotDisplayedReason?: () => string;
            getSkippedReason?: () => string;
            getDismissedReason?: () => string;
          }) => void) => void;
          renderButton: (
            parent: HTMLElement,
            options: {
              type?: 'standard' | 'icon';
              theme?: 'outline' | 'filled_blue' | 'filled_black';
              size?: 'large' | 'medium' | 'small';
              text?: 'signin_with' | 'signup_with' | 'continue_with' | 'signin';
              shape?: 'rectangular' | 'pill' | 'circle' | 'square';
              width?: string;
            }
          ) => void;
        };
      };
    };
  }
}

/**
 * Props cho LoginModal component.
 * Mục đích: định nghĩa giao diện tương tác của modal đăng nhập.
 */
type LoginModalProps = {
  /** Callback khi modal được đóng (do người dùng bấm X hoặc overlay). */
  onClose: () => void;
  /** Callback khi người dùng muốn chuyển sang trang đăng ký. */
  onNavigateToRegister?: () => void;
};

/**
 * Component modal đăng nhập có thể tái sử dụng.
 * Mục đích: hiển thị overlay đăng nhập chặn nội dung trang khi người dùng chưa xác thực.
 *
 * Hành vi:
 * - Khi người dùng đăng nhập thành công: persistAuthSession được gọi → event được fire →
 *   component cha tự động nhận biết via useAuthCheck → đóng modal.
 * - Khi người dùng đóng modal mà chưa đăng nhập: gọi onClose → component cha redirect về trang chủ.
 *
 * Lưu ý: Component không tự gọi router.push, để component cha quyết định redirect hay giữ nguyên trang.
 */
export default function LoginModal({ onClose, onNavigateToRegister }: LoginModalProps) {
  const [isProgressLoading, setIsProgressLoading] = useState(false);
  const [authErrorMessage, setAuthErrorMessage] = useState('');
  const [isSuccessVisible, setIsSuccessVisible] = useState(false);
  const [isInitialized, setIsInitialized] = useState(false);

  const backendBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:4000';
  const googleButtonContainerRef = useRef<HTMLDivElement>(null);
  const initializationTimerRef = useRef<number | null>(null);

  /**
   * Hàm chuẩn hóa Google Client ID.
   * Mục đích: loại bỏ khoảng trắng thừa gây lỗi thiếu client_id khi khởi tạo GSI.
   */
  const normalizeGoogleClientId = (rawGoogleClientId: string) => rawGoogleClientId.trim();

  /**
   * Hàm kiểm tra định dạng Google Client ID.
   * Mục đích: đảm bảo FE chỉ khởi tạo GSI khi client ID hợp lệ.
   */
  const isGoogleClientIdValid = (googleClientIdValue: string) =>
    googleClientIdValue.length > 0 && googleClientIdValue.includes('.apps.googleusercontent.com');

  const googleClientId = normalizeGoogleClientId(process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || '');

  /**
   * Hàm gọi backend để xác thực Google ID token và tạo session.
   * Mục đích: sau khi backend xác thực thành công, dữ liệu phiên được persist vào localStorage.
   * persistAuthSession sẽ tự động fire event → component cha nhận biết và đóng modal.
   */
  const requestGoogleLogin = useCallback(
    async (idToken: string) => {
      setAuthErrorMessage('');
      setIsProgressLoading(true);

      try {
        const response = await fetch(`${backendBaseUrl}/auth/google-login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idToken, role: 'donor' })
        });
        const responseData = await response.json();

        if (!response.ok) {
          throw new Error(responseData?.message || 'Đăng nhập thất bại, vui lòng thử lại.');
        }

        const accessToken = responseData?.accessToken as string | undefined;
        const refreshToken = responseData?.refreshToken as string | undefined;
        const csrfToken = responseData?.csrfToken as string | undefined;
        const refreshSessionId = responseData?.refreshSessionId as string | undefined;
        const refreshTokenExpiresAt = responseData?.expiresAt as string | undefined;
        const userData = responseData?.user as {
          id?: string;
          fullName?: string;
          email?: string;
          walletAddress?: string;
          role?: string;
        } | undefined;

        // Ghi chú logic phức tạp: persistAuthSession fire event "dcpAuthSessionUpdated"
        // → useAuthCheck hook nhận biết → cập nhật isLoggedIn → component cha đóng modal.
        persistAuthSession({
          accessToken,
          refreshToken,
          csrfToken,
          refreshSessionId,
          refreshTokenExpiresAt,
          userFullName: userData?.fullName || 'Người dùng',
          userEmail: userData?.email || '',
          userWalletAddress: userData?.walletAddress || '',
          userId: userData?.id || '',
          userRole: userData?.role || ''
        });

        setIsSuccessVisible(true);

        // Đóng modal sau khi animation thành công hoàn tất (300ms transition).
        // persistAuthSession đã fire event trước đó nên component cha đã nhận biết.
        window.setTimeout(() => {
          setIsProgressLoading(false);
          onClose();
        }, 1200);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Không thể đăng nhập, vui lòng thử lại.';
        setAuthErrorMessage(errorMessage);
        setIsProgressLoading(false);
      }
    },
    [backendBaseUrl, onClose]
  );

  /**
   * Hàm xử lý credential từ Google.
   * Mục đích: gateway nhận response từ GSI trước khi gọi backend.
   */
  const handleGoogleCredential = useCallback(
    (response: { credential?: string }) => {
      if (!response.credential) {
        setAuthErrorMessage('Không nhận được thông tin đăng nhập từ Google.');
        return;
      }
      void requestGoogleLogin(response.credential);
    },
    [requestGoogleLogin]
  );

  /**
   * Hàm khởi tạo Google Identity Services và render button.
   * Mục đích: đăng ký callback và render nút Google bên trong modal.
   */
  const initializeGoogleLogin = useCallback(() => {
    if (!isGoogleClientIdValid(googleClientId)) {
      setAuthErrorMessage('Thiếu hoặc sai cấu hình Google Client ID.');
      return false;
    }

    const googleAccounts = window.google?.accounts?.id;
    if (!googleAccounts) {
      return false;
    }

    googleAccounts.initialize({
      client_id: googleClientId,
      callback: handleGoogleCredential,
      use_fedcm_for_prompt: true
    });

    // Render nút Google bên trong modal container.
    if (googleButtonContainerRef.current) {
      googleButtonContainerRef.current.innerHTML = '';
      googleAccounts.renderButton(googleButtonContainerRef.current, {
        type: 'standard',
        theme: 'outline',
        size: 'large',
        text: 'continue_with',
        shape: 'rectangular',
        width: '300'
      });
    }

    setIsInitialized(true);
    return true;
  }, [googleClientId, handleGoogleCredential]);

  /**
   * Khởi tạo GSI khi modal mount.
   * Mục đích: script GSI có thể tải sau khi component mount, nên cần polling ngắn.
   */
  useEffect(() => {
    const tryInitialize = () => initializeGoogleLogin();

    if (tryInitialize()) {
      return;
    }

    initializationTimerRef.current = window.setInterval(() => {
      if (tryInitialize()) {
        if (initializationTimerRef.current !== null) {
          window.clearInterval(initializationTimerRef.current);
        }
      }
    }, 300);

    return () => {
      if (initializationTimerRef.current !== null) {
        window.clearInterval(initializationTimerRef.current);
      }
    };
  }, [initializeGoogleLogin]);

  /**
   * Hàm xử lý đóng modal khi người dùng bấm X hoặc click overlay.
   * Mục đích: chỉ đơn giản gọi onClose, không tự redirect ở đây.
   */
  const handleOverlayClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) {
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 px-4 backdrop-blur-sm"
      onClick={handleOverlayClick}
      role="dialog"
      aria-modal="true"
      aria-labelledby="login-modal-title"
    >
      {/* Lớp loading hiệu ứng thanh tiến trình trên cùng. */}
      <div
        className={`fixed left-0 top-0 z-[10000] h-[3px] origin-left bg-gradient-to-r from-[#0e7c6b] to-[#1aae97] transition-transform ${isProgressLoading ? 'scale-x-100 duration-[1800ms]' : 'scale-x-0 duration-300'
          }`}
      />

      {/* Overlay thành công hiển thị khi đăng nhập thành công. */}
      <div
        className={`fixed inset-0 z-[10001] flex flex-col items-center justify-center bg-white/95 px-6 text-center backdrop-blur transition-opacity duration-300 ${isSuccessVisible ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0'
          }`}
      >
        <div
          className={`mb-5 flex h-[72px] w-[72px] items-center justify-center rounded-full border-2 border-[#10b981] bg-[#d1fae5] transition-transform duration-300 ${isSuccessVisible ? 'scale-100' : 'scale-0'
            }`}
        >
          <svg viewBox="0 0 24 24" className="h-8 w-8" fill="none" stroke="#10b981" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </div>
        <div className="text-[22px] font-extrabold text-[#0d1117]">Đăng nhập thành công!</div>
        <div className="mt-2 text-sm text-[#9ca3af]">Đang tải trang của bạn...</div>
      </div>

      {/* Nội dung modal chính. */}
      <div className="relative z-[9999] w-full max-w-[440px] overflow-hidden rounded-2xl bg-white shadow-2xl">
        {/* Header: Logo + Nút đóng. */}
        <div className="flex items-center justify-between border-b border-gray-100 px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#0e7c6b]">
              <svg viewBox="0 0 24 24" className="h-5 w-5 fill-white">
                <path d="M12 21.7C5.8 17.5 2 13.2 2 9a6 6 0 0112 0 6 6 0 0112 0c0 4.2-3.8 8.5-10 12.7z" />
              </svg>
            </div>
            <span className="text-base font-extrabold text-[#0d1117]">DCP</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-full text-gray-400 transition hover:bg-gray-100 hover:text-gray-600"
            aria-label="Đóng modal đăng nhập"
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Body: Form đăng nhập. */}
        <div className="px-6 py-6">
          <div className="mb-5 text-center">
            <h2 id="login-modal-title" className="text-xl font-extrabold text-[#0d1117]">
              Đăng nhập để tiếp tục
            </h2>
            <p className="mt-1.5 text-sm text-[#9ca3af]">
              Vui lòng đăng nhập để truy cập trang Nạp tiền
            </p>
          </div>

          {authErrorMessage ? (
            <div className="mb-4 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-xs text-red-600">
              {authErrorMessage}
            </div>
          ) : null}

          {/* Nút đăng nhập Google. */}
          <div
            className={`group flex h-[50px] w-full items-center justify-center rounded-[10px] border-[1.5px] border-[#e5e7eb] bg-white text-[14.5px] font-semibold text-[#0d1117] transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-[1px] hover:border-[#0e7c6b] hover:shadow-[0_2px_14px_rgba(14,124,107,0.12)] ${isProgressLoading || isSuccessVisible ? 'pointer-events-none opacity-50' : ''
              }`}
          >
            <div
              ref={googleButtonContainerRef}
              className={`flex min-h-[40px] w-full items-center justify-center ${!isInitialized ? 'hidden' : ''}`}
            />
            {!isInitialized && !authErrorMessage && (
              <span className="text-sm text-gray-400">Đang tải...</span>
            )}
          </div>

          {/* Thông tin giải thích. */}
          <div className="mt-4 rounded-xl border-l-[3px] border-[#0e7c6b] bg-[#e6f7f4] px-4 py-3">
            <p className="text-xs leading-relaxed text-[#4b5563]">
              Sử dụng <strong className="font-semibold text-[#0e7c6b]">Account Abstraction (ERC-4337)</strong> —
              tài khoản được tạo tự động từ Google. An toàn như ngân hàng, không cần seed phrase.
            </p>
          </div>

          {/* Link đăng ký. */}
          <div className="mt-4 text-center text-xs text-[#9ca3af]">
            Chưa có tài khoản?{' '}
            {onNavigateToRegister ? (
              <button
                type="button"
                onClick={onNavigateToRegister}
                className="font-semibold text-[#0e7c6b] transition hover:text-[#0a5c50]"
              >
                Đăng ký →
              </button>
            ) : (
              <Link href="/register" className="font-semibold text-[#0e7c6b] transition hover:text-[#0a5c50]">
                Đăng ký →
              </Link>
            )}
          </div>

          {/* Điều khoản. */}
          <div className="mt-3 text-center text-[10px] text-[#9ca3af]">
            Bằng cách đăng nhập, bạn đồng ý với{' '}
            <a href="#" className="font-medium text-[#0e7c6b]">Điều khoản sử dụng</a> và{' '}
            <a href="#" className="font-medium text-[#0e7c6b]">Chính sách bảo mật</a>.
          </div>
        </div>
      </div>

      <style jsx global>{`
        #login-modal-google-btn .nsm7Bb-HzV7m-LgbsSe-bN97Pc-sM5MNb {
          border: none !important;
          box-shadow: none !important;
        }
      `}</style>
    </div>
  );
}
