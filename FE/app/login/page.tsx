'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
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


const honeycombOverlayDataUri =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='60' height='52'%3E%3Cpolygon points='30,2 58,16 58,44 30,58 2,44 2,16' fill='none' stroke='rgba(255,255,255,0.07)' stroke-width='1.5'/%3E%3C/svg%3E";

/**
 * Hàm hiển thị lớp phủ tổ ong cho panel nền xanh.
 * Mục đích: tạo pattern phủ kín panel theo kích thước tile chuẩn.
 */
const HoneycombOverlay = () => (
  <div
    className="pointer-events-none absolute inset-0 z-[1]"
    style={{
      backgroundImage: `url("${honeycombOverlayDataUri}")`,
      backgroundSize: '60px 52px',
      backgroundPosition: '0 0',
      backgroundRepeat: 'repeat',
      backgroundColor: 'rgba(255, 255, 255, 0.02)',
      outline: '1px dashed rgba(255, 255, 255, 0.25)',
      mixBlendMode: 'screen',
      opacity: 1,
    }}
  />
);


/** Hàm chuẩn hóa role để mapping điều hướng ổn định giữa dữ liệu role mới và legacy. */
function normalizeUserRole(userRoleValue: string | undefined | null): string {
  if (!userRoleValue) {
    return '';
  }

  return userRoleValue.trim().toLowerCase().replace(/[\s_-]+/g, '');
}

/** Hàm ánh xạ role sang đường dẫn sau đăng nhập để không rơi về trang chủ sai ngữ cảnh. */
function resolvePostLoginRedirectPath(userRoleValue: string | undefined | null): string {
  const normalizedUserRole = normalizeUserRole(userRoleValue);

  if (normalizedUserRole === 'regulatory' || normalizedUserRole === 'regulatorybody' || normalizedUserRole === 'regulatorybodies') {
    return '/regulatory-bodies';
  }

  if (normalizedUserRole === 'organization' || normalizedUserRole === 'organizations') {
    return '/organizations';
  }

  if (normalizedUserRole === 'auditor') {
    return '/auditor';
  }

  if (normalizedUserRole === 'executivechair' || normalizedUserRole === 'executivemember') {
    return '/executive';
  }

  if (normalizedUserRole === 'admin' || normalizedUserRole === 'systemadmin') {
    return '/admin';
  }

  return '/';
}

/**
 * Hàm lấy đường dẫn điều hướng sau đăng nhập từ query param.
 * Mục đích: chỉ thay đổi đích redirect mà không can thiệp logic đăng nhập hiện có.
 * @param returnToValue - Giá trị returnTo đọc từ URL hiện tại
 * @returns Đường dẫn nội bộ hợp lệ hoặc null nếu không an toàn
 */
function resolveSafeReturnToPath(returnToValue: string | null): string | null {
  if (!returnToValue) {
    return null;
  }

  if (!returnToValue.startsWith('/') || returnToValue.startsWith('//')) {
    return null;
  }

  if (returnToValue.includes('://')) {
    return null;
  }

  const normalizedReturnToPath = returnToValue.split('?')[0]?.toLowerCase() || '/';

  // Ghi chú logic phức tạp: chặn quay lại auth page để tránh vòng lặp điều hướng sau đăng nhập thành công.
  if (normalizedReturnToPath === '/login' || normalizedReturnToPath === '/register') {
    return null;
  }

  return returnToValue;
}

// useSearchParams() phải nằm trong Suspense boundary — Next.js 14 yêu cầu khi dùng App Router
/**
 * Kiểm tra Google OAuth Client ID nhận từ cấu hình public của backend.
 * Mục đích: chỉ cho phép Google Identity Services dùng đúng định dạng Web client ID.
 */
function isGoogleClientIdValid(googleClientIdValue: string): boolean {
  return googleClientIdValue.length > 0 && googleClientIdValue.includes('.apps.googleusercontent.com');
}

/**
 * Trích xuất Google OAuth Client ID từ phản hồi cấu hình không tin cậy.
 * Mục đích: tránh khởi tạo Google Identity Services bằng dữ liệu API sai cấu trúc.
 */
function extractGoogleClientId(responseData: unknown): string | null {
  if (!responseData || typeof responseData !== 'object') {
    return null;
  }

  const clientId = (responseData as { clientId?: unknown }).clientId;
  if (typeof clientId !== 'string') {
    return null;
  }

  const normalizedClientId = clientId.trim();
  return isGoogleClientIdValid(normalizedClientId) ? normalizedClientId : null;
}

function LoginContent() {
  const [isInfoCollapsed, setIsInfoCollapsed] = useState(false);
  const [isProgressLoading, setIsProgressLoading] = useState(false);
  const [isSuccessVisible, setIsSuccessVisible] = useState(false);
  const [authErrorMessage, setAuthErrorMessage] = useState('');
  const [walletAddress, setWalletAddress] = useState('');
  const [userFullName, setUserFullName] = useState('');
  const [correlationId, setCorrelationId] = useState('');

  const backendBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:4000';
  const router = useRouter();
  const searchParams = useSearchParams();

  /**
   * Hàm lấy đối tượng Google Accounts ID từ GSI script.
   * Mục đích: gom logic truy cập window.google để tái sử dụng và dễ debug.
   */
  const getGoogleAccountsId = useCallback(() => window.google?.accounts?.id, []);

  const googleRedirectButtonContainerId = 'googleRedirectButtonContainer';

  /**
   * Hàm hiển thị nút Google redirect/popup do GSI cung cấp.
   * Mục đích: tạo đường đăng nhập chủ động khi One Tap/FedCM không hoạt động ổn định.
   */
  const renderGoogleRedirectButton = useCallback(() => {
    const googleAccounts = getGoogleAccountsId();
    if (!googleAccounts) {
      return;
    }

    const containerElement = document.getElementById(googleRedirectButtonContainerId);
    if (!containerElement) {
      return;
    }

    // Ghi chú logic phức tạp: luôn xóa nội dung cũ trước khi render lại để tránh nhân bản nút Google.
    containerElement.innerHTML = '';
    googleAccounts.renderButton(containerElement, {
      type: 'standard',
      theme: 'outline',
      size: 'large',
      text: 'continue_with',
      shape: 'rectangular',
      width: '320'
    });
  }, [getGoogleAccountsId]);


  /**
   * Tải Google OAuth Client ID từ backend.
   * Mục đích: frontend luôn dùng cùng client ID với audience mà backend xác minh ID token.
   */
  const fetchGoogleClientId = useCallback(async (): Promise<string> => {
    const response = await fetch(`${backendBaseUrl}/auth/google-client-config`);
    const responseData: unknown = await response.json();
    const googleClientId = extractGoogleClientId(responseData);

    if (!response.ok || !googleClientId) {
      throw new Error('Google OAuth client configuration is unavailable.');
    }

    return googleClientId;
  }, [backendBaseUrl]);

  /**
   * Hàm tạo dữ liệu thống kê minh bạch cho khối nội dung bên trái.
   */
  const trustCardItems = [
    { icon: '⛓', title: '98,341 giao dịch', label: 'đã ghi nhận trên Blockchain' },
    { icon: '🔒', title: 'Smart Contract bảo vệ', label: '100% giải ngân qua đa chữ ký' },
    { icon: '👥', title: '15,842 nhà hảo tâm', label: 'đang tin dùng DCP' },
  ];

  /**
   * Hàm đổi trạng thái hộp thông tin.
   */
  const handleToggleInfoBox = () => {
    setIsInfoCollapsed(previousValue => !previousValue);
  };

  /**
   * Hàm bật trạng thái loading của thanh tiến trình.
   */
  const triggerProgressBar = () => {
    setIsProgressLoading(true);
    window.setTimeout(() => setIsProgressLoading(false), 1800);
  };

  /**
   * Hàm gọi backend để xác thực Google ID token và tạo ví blockchain.
   * Mục đích: luôn gửi kèm role mặc định donor để tương thích payload backend mới.
   */
  const requestGoogleLogin = useCallback(
    async (idToken: string) => {
      setAuthErrorMessage('');
      triggerProgressBar();

      try {
        const response = await fetch(`${backendBaseUrl}/auth/google-login`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ idToken, role: 'donor' }),
        });
        const responseData = await response.json();

        // Ghi chú logic phức tạp: luôn kiểm tra trạng thái HTTP trước khi dùng dữ liệu trả về
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
        const correlationIdValue = responseData?.correlationId as string | undefined;

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

        setUserFullName(userData?.fullName || 'Người dùng');
        setWalletAddress(userData?.walletAddress || '');
        setCorrelationId(correlationIdValue || '');
        setIsSuccessVisible(true);

        // Ghi chú logic phức tạp: điều hướng theo role để mỗi nhóm người dùng vào đúng màn hình nghiệp vụ ngay sau đăng nhập.
        const safeReturnToPath = resolveSafeReturnToPath(searchParams.get('returnTo'));
        const redirectPath = safeReturnToPath || resolvePostLoginRedirectPath(userData?.role);
        router.push(redirectPath);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Không thể đăng nhập, vui lòng thử lại.';
        setAuthErrorMessage(errorMessage);
      } finally {
        // Ghi chú logic phức tạp: giữ khối finally để đảm bảo luồng xử lý luôn khép kín sau request.
      }
    },
    [backendBaseUrl, router, searchParams]
  );

  /**
   * Hàm xử lý phản hồi credential từ Google.
   */
  const handleGoogleCredential = useCallback(
    (response: { credential?: string }) => {
      if (!response.credential) {
        setAuthErrorMessage('Không nhận được thông tin đăng nhập từ Google.');
        return;
      }

      requestGoogleLogin(response.credential);
    },
    [requestGoogleLogin]
  );

  /**
   * Hàm khởi tạo Google Identity Services.
   * Mục đích: đăng ký callback nhận credential và render nút Google chính thức.
   */
  const initializeGoogleLogin = useCallback((googleClientId: string) => {
    const googleAccounts = getGoogleAccountsId();
    if (!googleAccounts) {
      return false;
    }

    googleAccounts.initialize({
      client_id: googleClientId,
      callback: handleGoogleCredential,
      use_fedcm_for_prompt: true,
    });

    renderGoogleRedirectButton();
    return true;
  }, [getGoogleAccountsId, handleGoogleCredential, renderGoogleRedirectButton]);

  /**
   * Hàm chuẩn bị Google Identity khi script sẵn sàng.
   */
  useEffect(() => {
    let isMounted = true;
    let initializationTimer: number | null = null;

    const loadConfigurationAndInitialize = async (): Promise<void> => {
      try {
        const googleClientId = await fetchGoogleClientId();
        if (!isMounted || initializeGoogleLogin(googleClientId)) {
          return;
        }

        // Ghi chú logic phức tạp: script GSI có thể tải sau phản hồi cấu hình,
        // nên polling ngắn hạn chỉ bắt đầu khi đã có client ID được backend xác nhận.
        initializationTimer = window.setInterval(() => {
          if (initializeGoogleLogin(googleClientId) && initializationTimer !== null) {
            window.clearInterval(initializationTimer);
            initializationTimer = null;
          }
        }, 300);
      } catch {
        if (isMounted) {
          setAuthErrorMessage('Không thể tải cấu hình đăng nhập Google. Vui lòng thử lại sau.');
        }
      }
    };

    void loadConfigurationAndInitialize();

    return () => {
      isMounted = false;
      if (initializationTimer !== null) {
        window.clearInterval(initializationTimer);
      }
    };
  }, [fetchGoogleClientId, initializeGoogleLogin]);


  return (
    <main className="grid min-h-screen grid-cols-1 overflow-hidden bg-[#f8fafb] text-[#0d1117] lg:h-screen lg:grid-cols-2">
      <div
        className={`fixed left-0 right-0 top-0 z-[999] h-[3px] origin-left bg-gradient-to-r from-[#0e7c6b] to-[#1aae97] transition-transform ${isProgressLoading ? 'scale-x-100 duration-[1800ms]' : 'scale-x-0 duration-300'
          }`}
      />
      <div
        className={`fixed inset-0 z-[200] flex flex-col items-center justify-center bg-[#f8fafb]/95 px-6 text-center backdrop-blur ${isSuccessVisible ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0'
          } transition-opacity duration-300`}
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
        <div className="mt-2 text-sm text-[#9ca3af]">Đang tải dashboard của bạn...</div>
      </div>

      <aside className="relative hidden flex-col overflow-hidden bg-gradient-to-br from-[#0e7c6b] via-[#0a5c50] to-[#073d36] px-12 py-10 text-white lg:flex">
        <HoneycombOverlay />
        <div className="absolute -right-28 -top-28 z-0 h-[360px] w-[360px] rounded-full bg-[radial-gradient(circle,rgba(26,174,151,0.25)_0%,transparent_70%)]" />
        <div className="absolute -bottom-24 -left-24 z-0 h-[320px] w-[320px] rounded-full bg-[radial-gradient(circle,rgba(255,255,255,0.06)_0%,transparent_70%)]" />

        <a href="/" className="relative z-10 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-[10px] border border-white/30 bg-white/15 backdrop-blur">
            <svg viewBox="0 0 24 24" className="h-[22px] w-[22px] fill-white">
              <path d="M12 21.7C5.8 17.5 2 13.2 2 9a6 6 0 0112 0 6 6 0 0112 0c0 4.2-3.8 8.5-10 12.7z" />
            </svg>
          </div>
          <div>
            <div className="text-[19px] font-extrabold tracking-[-0.3px]">DCP</div>
            <div className="text-[10.5px] leading-none text-white/55">Decentralized Charity Platform</div>
          </div>
        </a>

        <div className="relative z-10 flex flex-1 flex-col justify-center">
          <div className="mb-7 flex h-[60px] w-[60px] items-center justify-center rounded-2xl border border-white/20 bg-white/10 text-[26px]">
            ⛓
          </div>
          <div className="text-[clamp(20px,2.2vw,26px)] font-bold leading-[1.35] tracking-[-0.3px]">
            Mỗi đồng quyên góp đều để lại <span className="text-[#f59e0b]">dấu vết</span> trên Blockchain.
          </div>
          <div className="mt-4 text-[13.5px] italic text-white/55">— Không thể xóa. Không thể giả mạo. Mãi minh bạch.</div>
        </div>

        <div className="relative z-10 space-y-2.5">
          {trustCardItems.map(item => (
            <div
              key={item.title}
              className="flex items-center gap-4 rounded-xl border border-white/15 bg-white/10 px-[18px] py-[13px] transition hover:bg-white/15"
            >
              <div className="text-xl">{item.icon}</div>
              <div>
                <div className="text-[14.5px] font-semibold leading-tight text-white">{item.title}</div>
                <div className="text-[11.5px] text-white/55">{item.label}</div>
              </div>
            </div>
          ))}
        </div>

        <div className="relative z-10 mt-6 flex items-center gap-2 text-[11px] text-white/40">
          <svg viewBox="0 0 24 24" className="h-3 w-3 fill-white/40">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          </svg>
          Được bảo mật bởi ERC-4337 Account Abstraction
        </div>
      </aside>

      <section className="flex flex-col overflow-y-visible bg-[#f8fafb] lg:overflow-y-auto">
        <a href="/" className="flex items-center justify-center gap-3 px-6 py-5 lg:hidden">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#0e7c6b]">
            <svg viewBox="0 0 24 24" className="h-5 w-5 fill-white">
              <path d="M12 21.7C5.8 17.5 2 13.2 2 9a6 6 0 0112 0 6 6 0 0112 0c0 4.2-3.8 8.5-10 12.7z" />
            </svg>
          </div>
          <span className="text-lg font-extrabold text-[#0d1117]">DCP</span>
        </a>

        <div className="mt-6 flex flex-wrap items-center justify-between gap-2 px-12 pt-3 pb-2 text-sm text-[#4b5563] max-[900px]:mt-4 max-[900px]:px-6 max-[900px]:pt-2.5 max-[900px]:pb-2 max-[480px]:mt-3 max-[480px]:px-4 max-[480px]:pt-2 max-[480px]:pb-1.5 lg:mt-0 lg:pt-0.5 lg:pb-0.5">
          <a href="/" className="flex items-center gap-2 text-xs text-[#9ca3af] transition hover:text-[#0e7c6b]">
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="15 18 9 12 15 6" />
            </svg>
            Về trang chủ
          </a>
          <div>
            Chưa có tài khoản? <Link href="/register" className="font-semibold text-[#0e7c6b]">Đăng ký →</Link>
          </div>
        </div>

        <div className="mx-auto flex w-full max-w-[480px] flex-1 flex-col justify-center px-14 pb-10 pt-6 max-[900px]:px-7 max-[480px]:max-w-full max-[480px]:px-5 max-[480px]:pt-4 max-[480px]:pb-8">
          <div className="mb-2 text-sm font-semibold text-[#0e7c6b]">Chào mừng trở lại 👋</div>
          <h1 className="text-[28px] font-extrabold text-[#0d1117]">Đăng nhập vào DCP</h1>
          <p className="mt-2 text-sm text-[#9ca3af]">Tiếp tục hành trình từ thiện minh bạch của bạn</p>

          <div className="mt-6">
            {authErrorMessage ? (
              <div className="rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-xs text-red-600">
                {authErrorMessage}
              </div>
            ) : null}
            <div className="mt-3">
              {/* Ghi chú logic phức tạp: lớp bao ngoài mô phỏng chính xác social button trong file mẫu,
                  còn nút thật vẫn do Google render để giữ nguyên luồng xác thực hiện tại. */}
              <div className="group flex h-[50px] w-full items-center justify-center rounded-[10px] border-[1.5px] border-[#e5e7eb] bg-white font-['Be_Vietnam_Pro',sans-serif] text-[14.5px] font-semibold text-[#0d1117] transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-[1px] hover:border-[#0e7c6b] hover:shadow-[0_2px_14px_rgba(14,124,107,0.12)]">
                <div id={googleRedirectButtonContainerId} className="flex min-h-[40px] w-full items-center justify-center" />
              </div>
            </div>
            {(userFullName || walletAddress || correlationId) && (
              <div className="mt-4 rounded-xl border border-[#e5e7eb] bg-white px-4 py-3 text-xs text-[#4b5563]">
                <div className="text-[11px] font-semibold uppercase text-[#9ca3af]">Thông tin ví sau đăng nhập</div>
                {userFullName && <div className="mt-2">Tên người dùng: <span className="font-semibold text-[#0d1117]">{userFullName}</span></div>}
                {walletAddress && <div className="mt-1">Ví blockchain: <span className="font-semibold text-[#0d1117]">{walletAddress}</span></div>}
                {correlationId && <div className="mt-1">Correlation ID: <span className="font-semibold text-[#0d1117]">{correlationId}</span></div>}
              </div>
            )}
          </div>

          <div className="mt-6 rounded-xl border-l-[3px] border-[#0e7c6b] bg-[#e6f7f4] px-4 py-3 text-sm text-[#4b5563]">
            <button
              type="button"
              onClick={handleToggleInfoBox}
              className="flex w-full items-center justify-between gap-3 text-left text-sm font-semibold text-[#0e7c6b]"
            >
              <span className="flex items-center gap-2">
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="16" x2="12" y2="12" />
                  <line x1="12" y1="8" x2="12.01" y2="8" />
                </svg>
                Tại sao không cần seed phrase?
              </span>
              <svg
                className={`h-4 w-4 transition ${isInfoCollapsed ? '-rotate-90' : 'rotate-0'}`}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
            {!isInfoCollapsed && (
              <p className="mt-3 text-xs leading-relaxed text-[#4b5563]">
                DCP sử dụng công nghệ <strong className="font-semibold text-[#0e7c6b]">Account Abstraction (ERC-4337)</strong> — tài khoản
                của bạn được tạo tự động từ Google. An toàn như ngân hàng, không cần ghi nhớ hay lưu trữ khóa bí mật.
                Mọi giao dịch vẫn được ghi nhận đầy đủ trên Blockchain.
              </p>
            )}
          </div>

          <div className="mt-6 border-t border-[#e5e7eb] pt-4 text-center text-xs text-[#9ca3af]">
            Bằng cách đăng nhập, bạn đồng ý với <a href="#" className="font-medium text-[#0e7c6b]">Điều khoản sử dụng</a> và{' '}
            <a href="#" className="font-medium text-[#0e7c6b]">Chính sách bảo mật</a> của DCP.
          </div>
        </div>
      </section>

      <style jsx global>{`
        /* Ghi chú logic phức tạp: chỉ tinh chỉnh lớp CSS do Google render để bỏ viền khung mặc định,
           không thay đổi hành vi đăng nhập hoặc callback xác thực. */
        #googleRedirectButtonContainer .nsm7Bb-HzV7m-LgbsSe-bN97Pc-sM5MNb {
          border: none !important;
          box-shadow: none !important;
        }
      `}</style>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={
      <main className="grid min-h-screen place-items-center bg-[#f8fafb]">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-[#0e7c6b] border-t-transparent" />
      </main>
    }>
      <LoginContent />
    </Suspense>
  );
}

