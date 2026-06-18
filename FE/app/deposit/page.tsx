'use client';

import { Suspense, type ChangeEvent, type MouseEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams, type ReadonlyURLSearchParams } from 'next/navigation';
import { readAuthSession } from '../utils/authSession';
import { useAuthCheck } from '../utils/useAuthCheck';
import LoginModal from '../components/LoginModal';
import { clearAuthSession } from '../utils/authSession';

type QuickChip = { id: number; value: number; label: string };

type ProcessStep = { id: number; title: string; description: string; status: 'done' | 'active' | 'pending' };

type TransactionItem = {
  id: number;
  title: string;
  date: string;
  hash: string;
  rawHash: string | null;
  explorerUrl: string;
  amount: string;
  status: 'SUCCESS' | 'FAILED' | 'PENDING';
};

type DepositSidebarProfile = {
  fullName: string;
  role: string;
  walletAddress: string;
};

type DepositSidebarRecentDeposit = {
  orderCode: string;
  amountVnd: number;
  tokenAmount: number;
  status: 'PENDING_PAYMENT' | 'PAYMENT_CONFIRMED' | 'MINT_COMPLETED' | 'FAILED';
  onChainTransactionHash: string | null;
  createdAt: string;
  updatedAt: string;
};

type DepositSidebarResponse = {
  profile: DepositSidebarProfile;
  tokenBalance: number;
  tokenBalanceOnChain?: number;
  recentDeposits: DepositSidebarRecentDeposit[];
};

type DepositStatusResponse = {
  orderCode: string;
  amountVnd: number;
  tokenAmount: number;
  status: 'PENDING_PAYMENT' | 'PAYMENT_CONFIRMED' | 'MINT_COMPLETED' | 'FAILED';
  paymentUrl: string;
  onChainTransactionHash: string | null;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
  paymentExpiredAt?: string;
};

type NoteItem = { id: number; content: string; highlight?: boolean };


const quickChips: QuickChip[] = [
  { id: 1, value: 50000, label: '50.000đ' },
  { id: 2, value: 100000, label: '100.000đ' },
  { id: 3, value: 200000, label: '200.000đ' },
  { id: 4, value: 500000, label: '500.000đ' },
  { id: 5, value: 1000000, label: '1.000.000đ' }
];

const processSteps: ProcessStep[] = [
  {
    id: 1,
    title: 'Nhập số tiền VNĐ',
    description: 'Chọn số tiền muốn nạp vào ví Charity Token',
    status: 'active'
  },
  {
    id: 2,
    title: 'Chuyển hướng PayOS',
    description: 'Thanh toán qua Internet Banking hoặc QR Code',
    status: 'pending'
  },
  {
    id: 3,
    title: 'Xác nhận tự động',
    description: 'Backend nhận webhook, xác minh chữ ký HMAC',
    status: 'pending'
  },
  {
    id: 4,
    title: 'Token vào ví ngay',
    description: 'Smart Contract mint token ~30 giây sau khi xác nhận',
    status: 'pending'
  }
];

/**
 * Hàm rút gọn địa chỉ ví để hiển thị.
 * Mục đích: đảm bảo giao diện sidebar gọn và vẫn nhận diện được ví.
 */
const truncateWalletAddress = (walletAddress: string): string => {
  if (walletAddress.length <= 12) {
    return walletAddress;
  }

  return `${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`;
};

/** Hàm rút gọn transaction hash. Mục đích: hiển thị mã giao dịch gọn hơn nhưng vẫn đủ nhận diện. */
const shortenTransactionHash = (transactionHashValue: string): string => {
  if (transactionHashValue.length <= 9) {
    return transactionHashValue;
  }

  return `${transactionHashValue.slice(0, 3)}...${transactionHashValue.slice(-3)}`;
};

/** Hàm tạo link explorer cho transaction hash. Mục đích: cho phép người dùng mở blockchain explorer từ giao dịch nạp tiền. */
const buildTransactionExplorerUrl = (transactionHashValue: string): string => {
  if (!transactionHashValue) {
    return '';
  }

  const blockchainExplorerTxBaseUrl = String(process.env.NEXT_PUBLIC_BLOCKCHAIN_EXPLORER_TX_BASE_URL || 'https://amoy.polygonscan.com/tx').trim();
  return `${blockchainExplorerTxBaseUrl.replace(/\/$/, '')}/${transactionHashValue}`;
};

/**
 * Hàm format thời gian giao dịch.
 * Mục đích: chuẩn hóa cách hiển thị thời gian trên sidebar deposit.
 */
const formatTransactionDateTime = (dateTime: string): string => {
  const parsedDate = new Date(dateTime);
  if (Number.isNaN(parsedDate.getTime())) {
    return 'Không xác định thời gian';
  }

  return parsedDate.toLocaleString('vi-VN', {
    hour12: false,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
};

/**
 * Hàm tạo chữ viết tắt từ họ tên.
 * Mục đích: hiển thị avatar chữ cái khi không có ảnh đại diện.
 */
const buildUserInitials = (fullName: string): string => {
  const nameParts = fullName.trim().split(' ').filter((namePart) => namePart.length > 0);
  if (nameParts.length === 0) {
    return 'NA';
  }

  if (nameParts.length === 1) {
    return nameParts[0].slice(0, 2).toUpperCase();
  }

  return `${nameParts[0][0]}${nameParts[nameParts.length - 1][0]}`.toUpperCase();
};

/**
 * Hàm chuyển đổi trạng thái backend sang trạng thái hiển thị giao dịch.
 * Mục đích: đồng bộ trạng thái nghiệp vụ deposit và giao diện sidebar.
 */
const mapDepositStatusToTransactionStatus = (
  status: DepositSidebarRecentDeposit['status']
): TransactionItem['status'] => {
  if (status === 'MINT_COMPLETED') {
    return 'SUCCESS';
  }

  if (status === 'FAILED') {
    return 'FAILED';
  }

  return 'PENDING';
};

const noteItems: NoteItem[] = [
  { id: 1, content: 'Tỷ lệ cố định: <strong>1 VNĐ = 1 Charity Token</strong>.' },
  { id: 2, content: 'Số tiền tối thiểu: <strong>10,000 VNĐ</strong>.' },
  { id: 3, content: 'Token được mint sau <strong>2 block confirmations</strong>.' },
  { id: 4, content: 'Token chỉ dùng trong hệ thống DCP.' },
  { id: 5, content: '<strong>Không hỗ trợ rút Token về VNĐ</strong>.', highlight: true }
];

const trustedBanks = ['VCB', 'BIDV', 'TCB', 'VPB', 'MBB', 'ACB', '+40'];

/**
 * Hàm tạo đường dẫn returnTo an toàn cho trang deposit.
 * Mục đích: giữ nguyên route hiện tại cùng query string để đăng nhập xong quay lại đúng ngữ cảnh.
 * @param currentPathname - Đường dẫn hiện tại của trang
 * @param currentSearchParams - Tập query params hiện tại
 * @returns Đường dẫn nội bộ đầy đủ gồm pathname và query string nếu có
 */
const buildDepositReturnToPath = (
  currentPathname: string,
  currentSearchParams: ReadonlyURLSearchParams | URLSearchParams
): string => {
  const normalizedPathname = currentPathname.startsWith('/') ? currentPathname : `/${currentPathname}`;
  const searchParamsString = currentSearchParams.toString();

  if (!searchParamsString) {
    return normalizedPathname;
  }

  return `${normalizedPathname}?${searchParamsString}`;
};


/**
 * Hàm định dạng số tiền theo chuẩn VNĐ.
 * Mục đích: hiển thị số tiền có dấu phân cách dễ đọc.
 */
const formatCurrency = (value: number) => `${value.toLocaleString('vi-VN')} VNĐ`;

/**
 * Hàm format số token theo giá trị VNĐ.
 * Mục đích: đồng bộ hiển thị token nhận được từ số tiền nạp.
 */
const formatToken = (value: number) => `${value.toLocaleString('vi-VN')} Token`;

/**
 * Hàm render nội dung trang Home (Deposit).
 * Mục đích: gom toàn bộ logic client và dùng trong Suspense boundary.
 */
function DepositHomePageContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const returnToPath = buildDepositReturnToPath('/deposit', searchParams);
  const backendBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:4000';

  // Ghi chú: Kiểm tra auth state tại thời điểm render (đồng bộ) — không gây flash nội dung.
  // isLoggedIn được computed từ sessionData đọc từ localStorage ngay tại thời điểm render.
  const { isLoggedIn, syncSessionFromStorage } = useAuthCheck();
  const [isLoginModalVisible, setIsLoginModalVisible] = useState(false);

  // Ghi chú: Xác định trạng thái hiển thị modal ngay từ lần render đầu tiên.
  // Nếu chưa đăng nhập → mở modal, KHÔNG hiển thị nội dung deposit (ngăn flash).
  useEffect(() => {
    if (!isLoggedIn) {
      setIsLoginModalVisible(true);
    }
  }, [isLoggedIn]);

  // Ghi chú: Hook useAuthCheck đọc localStorage tại thời điểm render (không phải useEffect).
  // Khi modal đăng nhập được hiển thị và người dùng đăng nhập thành công:
  // persistAuthSession fire event "dcpAuthSessionUpdated" → useAuthCheck cập nhật isLoggedIn →
  // → component re-render với isLoggedIn = true → effect bên dưới đóng modal mà không đổi route.
  // Khi người dùng chủ động đóng modal mà chưa đăng nhập → redirect về trang login kèm returnTo.
  const handleCloseLoginModal = useCallback(() => {
    if (isLoggedIn) {
      setIsLoginModalVisible(false);
      return;
    }

    setIsLoginModalVisible(false);
    router.push(`/login?returnTo=${encodeURIComponent(returnToPath)}`);
  }, [isLoggedIn, returnToPath, router]);

  /**
   * Hàm đóng modal đăng nhập ngay khi phiên xác thực đã sẵn sàng.
   * Mục đích: tránh LoginModal gọi onClose sau khi đăng nhập thành công rồi làm lệch hướng về trang khác.
   */
  useEffect(() => {
    if (isLoggedIn) {
      setIsLoginModalVisible(false);
    }
  }, [isLoggedIn]);

  // Ghi chú: Sync lại session data nếu có thay đổi từ bên ngoài (ví dụ: tab khác thay đổi auth).
  useEffect(() => {
    const eventName = 'dcpAuthSessionUpdated';
    window.addEventListener(eventName, syncSessionFromStorage);
    return () => window.removeEventListener(eventName, syncSessionFromStorage);
  }, [syncSessionFromStorage]);

  const [amountValue, setAmountValue] = useState(0);
  const [selectedChipId, setSelectedChipId] = useState<number | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isToastOpen, setIsToastOpen] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [isProgressBarRunning, setIsProgressBarRunning] = useState(false);
  const [isConfirmBannerVisible, setIsConfirmBannerVisible] = useState(false);
  const [currentOrderCode, setCurrentOrderCode] = useState('');
  const [currentDepositStatus, setCurrentDepositStatus] = useState<DepositStatusResponse['status'] | ''>('');
  const [depositStatusMessage, setDepositStatusMessage] = useState('Chưa có giao dịch nạp tiền.');
  const [errorMessage, setErrorMessage] = useState('');
  const [paymentExpiredAt, setPaymentExpiredAt] = useState<string | null>(null);
  const [countdownNowTimestamp, setCountdownNowTimestamp] = useState(Date.now());
  const [isSidebarLoading, setIsSidebarLoading] = useState(false);
  const [sidebarErrorMessage, setSidebarErrorMessage] = useState('');
  const [sidebarProfile, setSidebarProfile] = useState<DepositSidebarProfile | null>(null);
  const [sidebarTokenBalance, setSidebarTokenBalance] = useState(0);

  const [sidebarRecentDeposits, setSidebarRecentDeposits] = useState<DepositSidebarRecentDeposit[]>([]);
  const recentTransactionsSectionReference = useRef<HTMLDivElement | null>(null);

  const formattedAmount = useMemo(() => formatCurrency(amountValue), [amountValue]);
  const formattedToken = useMemo(() => formatToken(amountValue), [amountValue]);
  const sidebarTokenBalanceDisplay = useMemo(() => formatToken(sidebarTokenBalance), [sidebarTokenBalance]);
  const sidebarTokenBalanceVndDisplay = useMemo(() => formatCurrency(sidebarTokenBalance), [sidebarTokenBalance]);
  const sidebarUserInitials = useMemo(() => buildUserInitials(sidebarProfile?.fullName || ''), [sidebarProfile?.fullName]);
  const sidebarWalletAddressDisplay = useMemo(() => {
    if (!sidebarProfile?.walletAddress) {
      return 'Chưa có dữ liệu ví';
    }

    return truncateWalletAddress(sidebarProfile.walletAddress);
  }, [sidebarProfile?.walletAddress]);

  /**
   * Hàm tính số giây còn lại đến lúc hết hạn thanh toán.
   * Mục đích: dùng cho UI đếm ngược 15 phút theo mốc backend trả về.
   */
  const paymentCountdownSeconds = useMemo(() => {
    if (!paymentExpiredAt) {
      return 0;
    }

    const expiredAtTimestamp = new Date(paymentExpiredAt).getTime();
    if (Number.isNaN(expiredAtTimestamp)) {
      return 0;
    }

    const remainingSeconds = Math.floor((expiredAtTimestamp - countdownNowTimestamp) / 1000);
    return remainingSeconds > 0 ? remainingSeconds : 0;
  }, [countdownNowTimestamp, paymentExpiredAt]);

  /**
   * Hàm định dạng thời gian đếm ngược về MM:SS.
   * Mục đích: hiển thị thời gian còn lại dễ đọc cho người dùng mới.
   */
  const paymentCountdownDisplay = useMemo(() => {
    const minutes = Math.floor(paymentCountdownSeconds / 60);
    const seconds = paymentCountdownSeconds % 60;
    const paddedMinutes = String(minutes).padStart(2, '0');
    const paddedSeconds = String(seconds).padStart(2, '0');
    return `${paddedMinutes}:${paddedSeconds}`;
  }, [paymentCountdownSeconds]);

  /**
   * Hàm xác định giao dịch thất bại do timeout 15 phút.
   * Mục đích: hiển thị đúng CTA "Tạo mã mới" khi backend đã auto hủy giao dịch.
   */
  const isPaymentTimeoutFailed = useMemo(() => {
    if (currentDepositStatus !== 'FAILED') {
      return false;
    }

    const normalizedErrorMessage = errorMessage.toLowerCase();
    return normalizedErrorMessage.includes('15 phút') || normalizedErrorMessage.includes('quá thời gian thanh toán');
  }, [currentDepositStatus, errorMessage]);

  /**
   * Hàm cập nhật mốc thời gian hiện tại mỗi giây khi đang chờ thanh toán.
   * Mục đích: tạo hiệu ứng đếm ngược realtime cho mã QR PayOS.
   */
  useEffect(() => {
    if (!paymentExpiredAt || currentDepositStatus !== 'PENDING_PAYMENT') {
      return;
    }

    const countdownIntervalIdentifier = window.setInterval(() => {
      setCountdownNowTimestamp(Date.now());
    }, 1000);

    return () => {
      window.clearInterval(countdownIntervalIdentifier);
    };
  }, [currentDepositStatus, paymentExpiredAt]);

  /**
   * Hàm đồng bộ trạng thái cuộn nền khi menu mobile mở.
   * Mục đích: tránh nền phía sau tiếp tục cuộn làm trải nghiệm menu bị lệch.
   */
  useEffect(() => {
    if (!isMobileMenuOpen) {
      document.body.style.overflow = '';
      return;
    }

    document.body.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = '';
    };
  }, [isMobileMenuOpen]);


  const sidebarRecentTransactions = useMemo<TransactionItem[]>(() => {
    return sidebarRecentDeposits.map((deposit, index) => ({
      id: index + 1,
      title: 'Nạp tiền',
      date: formatTransactionDateTime(deposit.updatedAt || deposit.createdAt),
      hash: deposit.onChainTransactionHash ? shortenTransactionHash(deposit.onChainTransactionHash) : `Order ${deposit.orderCode}`,
      rawHash: deposit.onChainTransactionHash,
      explorerUrl: deposit.onChainTransactionHash ? buildTransactionExplorerUrl(deposit.onChainTransactionHash) : '',
      amount: `+${deposit.tokenAmount.toLocaleString('vi-VN')}`,
      status: mapDepositStatusToTransactionStatus(deposit.status)
    }));
  }, [sidebarRecentDeposits]);

  /**
   * Hàm tạo key lưu trạng thái đã hiển thị thông báo thành công.
   * Mục đích: đảm bảo mỗi orderCode chỉ bật toast/banner thành công đúng một lần trong phiên duyệt hiện tại.
   */
  const buildDepositSuccessStorageKey = (orderCode: string): string => {
    return `depositSuccessShown_${orderCode}`;
  };

  /**
   * Hàm xóa orderCode khỏi URL sau khi xử lý xong.
   * Mục đích: tránh lặp polling và tránh hiển thị lại thông báo khi người dùng F5.
   */
  const clearOrderCodeFromUrl = () => {
    const currentUrl = new URL(window.location.href);
    currentUrl.searchParams.delete('orderCode');
    window.history.replaceState({}, '', currentUrl.toString());
  };

  /**
   * Hàm tải dữ liệu sidebar từ backend.
   * Mục đích: tái sử dụng cùng một luồng tải dữ liệu cho lần đầu và sau khi mint thành công.
   */
  const loadSidebarData = useCallback(async () => {
    const authSession = readAuthSession();
    if (!authSession.accessToken) {
      setSidebarErrorMessage('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.');
      return;
    }

    setIsSidebarLoading(true);
    setSidebarErrorMessage('');

    try {
      const response = await fetch(`${backendBaseUrl}/api/deposit/sidebar`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${authSession.accessToken}`
        }
      });

      if (response.status === 401) {
        setSidebarErrorMessage('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.');
        return;
      }

      if (response.status === 403) {
        setSidebarErrorMessage('Bạn không có quyền truy cập dữ liệu sidebar.');
        return;
      }

      if (response.status >= 500) {
        setSidebarErrorMessage('Hệ thống đang bận. Vui lòng thử lại sau.');
        return;
      }

      if (!response.ok) {
        const errorPayload = await response.json().catch(() => ({ message: '' }));
        setSidebarErrorMessage(errorPayload.message || 'Không thể tải dữ liệu sidebar.');
        return;
      }

      const responsePayload: DepositSidebarResponse = await response.json();
      const tokenBalanceOnChain = Number(responsePayload.tokenBalanceOnChain ?? responsePayload.tokenBalance ?? 0);

      setSidebarProfile(responsePayload.profile);
      setSidebarTokenBalance(tokenBalanceOnChain);
      setSidebarRecentDeposits(Array.isArray(responsePayload.recentDeposits) ? responsePayload.recentDeposits : []);
    } catch (_error) {
      setSidebarErrorMessage('Không thể kết nối máy chủ. Vui lòng kiểm tra mạng và thử lại.');
    } finally {
      setIsSidebarLoading(false);
    }
  }, [backendBaseUrl]);

  /**
   * Hàm tải dữ liệu sidebar lần đầu khi vào trang.
   * Mục đích: đảm bảo sidebar luôn có dữ liệu ngay khi người dùng mở trang deposit.
   */
  useEffect(() => {
    void loadSidebarData();
  }, [loadSidebarData]);

  /**
   * Hàm đồng bộ trạng thái sau khi PayOS redirect về trang deposit.
   * Mục đích: tự động gọi API tra cứu giao dịch khi có orderCode trên URL.
   */
  useEffect(() => {
    const orderCodeFromQuery = searchParams.get('orderCode') || '';
    if (!orderCodeFromQuery) {
      return;
    }

    setCurrentOrderCode(orderCodeFromQuery);
    setDepositStatusMessage('Đang kiểm tra trạng thái thanh toán và mint token...');

    const intervalIdentifier = window.setInterval(async () => {
      try {
        const authSession = readAuthSession();
        const response = await fetch(`${backendBaseUrl}/api/deposit/${orderCodeFromQuery}`, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${authSession.accessToken || ''}`
          }
        });

        if (response.status === 401) {
          setErrorMessage('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.');
          window.clearInterval(intervalIdentifier);
          return;
        }

        if (response.status === 403) {
          setErrorMessage('Bạn không có quyền xem giao dịch nạp tiền này.');
          window.clearInterval(intervalIdentifier);
          return;
        }

        if (!response.ok) {
          return;
        }

        const responsePayload = (await response.json()) as DepositStatusResponse;
        setCurrentDepositStatus(responsePayload.status);

        if (responsePayload.paymentExpiredAt) {
          setPaymentExpiredAt(responsePayload.paymentExpiredAt);
        }

        if (responsePayload.status === 'PENDING_PAYMENT') {
          setDepositStatusMessage('Đang chờ bạn hoàn tất thanh toán trên PayOS.');
          return;
        }

        if (responsePayload.status === 'PAYMENT_CONFIRMED') {
          setDepositStatusMessage('Thanh toán thành công, hệ thống đang mint token...');
          setIsProgressBarRunning(true);
          return;
        }

        if (responsePayload.status === 'MINT_COMPLETED') {
          setDepositStatusMessage('Nạp tiền thành công. Token đã được mint vào ví của bạn.');
          setIsProgressBarRunning(false);
          // Đợi tải lại sidebar trước khi mở toast để số dư mới hiển thị đúng ngay lần đầu.
          await loadSidebarData();

          const successStorageKey = buildDepositSuccessStorageKey(orderCodeFromQuery);
          const isSuccessShown = window.sessionStorage.getItem(successStorageKey) === 'true';

          if (!isSuccessShown) {
            setIsConfirmBannerVisible(true);
            setIsToastOpen(true);
            window.sessionStorage.setItem(successStorageKey, 'true');
          }

          clearOrderCodeFromUrl();
          window.clearInterval(intervalIdentifier);
          return;
        }

        if (responsePayload.status === 'FAILED') {
          setIsProgressBarRunning(false);
          setPaymentExpiredAt(null);

          const failedReasonMessage = responsePayload.failureReason || 'Giao dịch thất bại. Vui lòng thử lại.';
          const isTimeoutFailure = failedReasonMessage.toLowerCase().includes('15 phút')
            || failedReasonMessage.toLowerCase().includes('quá thời gian thanh toán');

          if (isTimeoutFailure) {
            setDepositStatusMessage('Mã thanh toán đã hết hạn sau 15 phút. Vui lòng tạo mã mới để tiếp tục.');
          } else {
            setDepositStatusMessage('Giao dịch nạp tiền thất bại.');
          }

          setErrorMessage(failedReasonMessage);
          window.clearInterval(intervalIdentifier);
        }
      } catch (_error) {
        // Giữ polling để tự phục hồi khi có lỗi mạng ngắn hạn.
      }
    }, 3000);

    return () => {
      window.clearInterval(intervalIdentifier);
    };
  }, [backendBaseUrl, loadSidebarData, searchParams]);


  /**
   * Hàm cập nhật số tiền nhập.
   * Mục đích: đồng bộ input với chip nhanh và vùng tổng kết.
   */
  const handleAmountChange = (value: string) => {
    const numericValue = Number(value.replace(/[^0-9]/g, '')) || 0;
    setAmountValue(numericValue);
    setSelectedChipId(null);
  };

  /**
   * Hàm đọc giá trị input số tiền.
   * Mục đích: chuẩn hóa dữ liệu nhập trước khi cập nhật state.
   */
  const handleAmountInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    handleAmountChange(event.target.value);
  };

  /**
   * Hàm mở modal thanh toán.
   * Mục đích: giả lập chuyển hướng PayOS theo trải nghiệm mẫu.
   */
  const handleOpenModal = () => {
    if (amountValue > 0) {
      setIsModalOpen(true);
    }
  };

  /**
   * Hàm đóng modal thanh toán.
   * Mục đích: đưa người dùng trở lại màn hình nạp tiền.
   */
  const handleCloseModal = () => setIsModalOpen(false);

  /**
   * Hàm tạo payment link và chuyển hướng sang PayOS.
   * Mục đích: gọi backend tạo giao dịch nạp tiền thực tế theo FR2.
   */
  const handleConfirmPayment = async () => {
    setIsModalOpen(false);
    setErrorMessage('');
    setIsConfirmBannerVisible(false);
    setIsToastOpen(false);

    try {
      const authSession = readAuthSession();
      setIsProgressBarRunning(true);

      const response = await fetch(`${backendBaseUrl}/api/deposit/create`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authSession.accessToken || ''}`
        },
        body: JSON.stringify({ amountVnd: amountValue })
      });

      const responsePayload = await response.json();
      if (!response.ok) {
        throw new Error(responsePayload.message || 'Không thể tạo giao dịch thanh toán.');
      }

      if (responsePayload.orderCode) {
        setCurrentOrderCode(String(responsePayload.orderCode));
      }
      setCurrentDepositStatus('PENDING_PAYMENT');
      setDepositStatusMessage('Đang chờ bạn hoàn tất thanh toán trên PayOS.');
      setPaymentExpiredAt(new Date(Date.now() + 15 * 60 * 1000).toISOString());
      setCountdownNowTimestamp(Date.now());

      window.location.href = responsePayload.paymentUrl;
    } catch (error) {
      setIsProgressBarRunning(false);
      setErrorMessage((error as Error).message);
    }
  };

  /**
   * Hàm tạo lại mã thanh toán mới khi mã cũ hết hạn.
   * Mục đích: cho phép người dùng tạo payment link mới theo phương án B.
   */
  const handleCreateNewPaymentCode = () => {
    setErrorMessage('');
    setCurrentDepositStatus('');
    setDepositStatusMessage('Đang tạo mã thanh toán mới...');
    setPaymentExpiredAt(null);
    setCountdownNowTimestamp(Date.now());
    void handleConfirmPayment();
  };

  /**
   * Hàm đóng toast.
   * Mục đích: ẩn thông báo nạp tiền.
   */
  const handleCloseToast = () => {
    setIsToastOpen(false);
    setIsConfirmBannerVisible(false);
  };

  /**
   * Hàm mở menu mobile.
   * Mục đích: hiển thị nhóm thông tin sidebar trên điện thoại khi người dùng bấm nút Menu.
   */
  const handleOpenMobileMenu = useCallback(() => {
    setIsMobileMenuOpen(true);
  }, []);

  /**
   * Hàm đóng menu mobile.
   * Mục đích: thu gọn drawer mobile và trả lại không gian thao tác cho màn hình chính.
   */
  const handleCloseMobileMenu = useCallback(() => {
    setIsMobileMenuOpen(false);
  }, []);

  /**
   * Hàm điều hướng về trang tổng quan.
   * Mục đích: đưa người dùng mobile quay về trang chủ từ bottom navigation.
   */
  const handleNavigateToOverview = useCallback(() => {
    router.push('/');
  }, [router]);

  /**
   * Hàm điều hướng sang trang dự án từ thiện.
   * Mục đích: mở danh sách dự án có sẵn mà không thay đổi luồng nghiệp vụ của trang deposit.
   */
  const handleNavigateToProjects = useCallback(() => {
    router.push('/#projects');
  }, [router]);

  /**
   * Hàm cuộn tới khu vực lịch sử giao dịch gần đây.
   * Mục đích: cho phép người dùng mobile xem nhanh lịch sử ngay trong trang hiện tại.
   */
  const handleNavigateToRecentTransactions = useCallback(() => {
    handleCloseMobileMenu();
    recentTransactionsSectionReference.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [handleCloseMobileMenu]);

  /**
   * Hàm xử lý đăng xuất.
   * Mục đích: xóa session, reset auth state, và chuyển hướng về trang chủ.
   */
  const handleLogout = () => {
    clearAuthSession();
    syncSessionFromStorage();
    router.push('/');
  };

  /**
   * Hàm xử lý click chip nhanh.
   * Mục đích: lấy dữ liệu từ dataset để cập nhật số tiền nạp.
   */
  const handleChipButtonClick = (event: MouseEvent<HTMLButtonElement>) => {
    const chipId = Number(event.currentTarget.dataset.chipId);
    const chipValue = Number(event.currentTarget.dataset.chipValue);

    if (!chipId || !chipValue) {
      return;
    }

    setAmountValue(chipValue);
    setSelectedChipId(chipId);
  };



  /**
   * Hàm render chip số tiền nhanh.
   * Mục đích: hiển thị các mức nạp gợi ý với trạng thái chọn.
   */
  const renderQuickChip = (chip: QuickChip) => (
    <button
      key={chip.id}
      type="button"
      data-chip-id={chip.id}
      data-chip-value={chip.value}
      onClick={handleChipButtonClick}
      className={`rounded-lg border px-4 py-2 text-sm font-semibold transition ${selectedChipId === chip.id
        ? 'border-[#0E7C6B] bg-[#E6F7F4] text-[#0E7C6B]'
        : 'border-gray-200 text-gray-500 hover:border-[#0E7C6B] hover:text-[#0E7C6B]'
        }`}
    >
      {chip.label}
    </button>
  );

  /**
   * Hàm render bước quy trình nạp tiền.
   * Mục đích: mô tả các bước chính trong luồng PayOS.
   */
  const renderProcessStep = (step: ProcessStep, stepIndex: number) => {
    const isLastStep = stepIndex === processSteps.length - 1;

    return (
      <div key={step.id} className="relative flex gap-3 pb-4">
        {!isLastStep && (
          <span className="absolute left-[11px] top-7 h-[calc(100%-20px)] border-l border-dashed border-[#E5E7EB]" />
        )}
        <div
          className={`relative z-10 flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${step.status === 'done'
            ? 'bg-emerald-500 text-white'
            : step.status === 'active'
              ? 'bg-[#0E7C6B] text-white shadow-[0_0_0_3px_rgba(14,124,107,0.15)]'
              : 'bg-[#E6F7F4] text-[#0E7C6B]'
            }`}
        >
          {step.id}
        </div>
        <div className={isLastStep ? 'pb-0' : ''}>
          <div className="text-sm font-semibold text-[#0D1117]">{step.title}</div>
          <div className="text-xs text-gray-400">{step.description}</div>
        </div>
      </div>
    );
  };

  /**
   * Hàm render giao dịch gần đây.
   * Mục đích: trình bày lịch sử nạp tiền minh họa.
   */
  const renderRecentTransaction = (transaction: TransactionItem) => {
    const statusStyleByType: Record<TransactionItem['status'], string> = {
      SUCCESS: 'bg-[#D1FAE5] text-[#065F46]',
      FAILED: 'bg-red-100 text-red-600',
      PENDING: 'bg-amber-100 text-amber-700'
    };

    const statusLabelByType: Record<TransactionItem['status'], string> = {
      SUCCESS: '✅ Thành công',
      FAILED: '❌ Thất bại',
      PENDING: '⏳ Đang xử lý'
    };

    return (
      <div
        key={transaction.id}
        className="flex items-start gap-3 rounded-xl border border-transparent bg-[#F8FAFB] px-3 py-3 transition hover:border-[#0E7C6B]/20 hover:bg-white sm:items-center"
      >
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#D1FAE5] text-base">💰</div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-[#0D1117]">{transaction.title}</div>
          <div className="text-[11px] text-gray-400">{transaction.date}</div>
          <div className="break-all text-[10px] text-gray-400">
            {transaction.explorerUrl ? (
              <a
                href={transaction.explorerUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex max-w-full items-center gap-1 text-[#1d4ed8] hover:underline"
                title={transaction.rawHash || transaction.hash}
              >
                <svg className="h-3 w-3 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
                </svg>
                <span>{transaction.hash}</span>
              </a>
            ) : (
              <span title={transaction.hash}>{transaction.hash}</span>
            )}
          </div>
        </div>
        <div className="flex-shrink-0 text-right">
          <div className="text-sm font-semibold text-[#0E7C6B]">{transaction.amount}</div>
          <div className={`mt-1 inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold ${statusStyleByType[transaction.status]}`}>
            {statusLabelByType[transaction.status]}
          </div>
        </div>
      </div>
    );
  };

  /**
   * Hàm render ghi chú hệ thống.
   * Mục đích: nhấn mạnh các lưu ý quan trọng cho người dùng.
   */
  const renderNoteItem = (item: NoteItem) => (
    <div key={item.id} className="flex gap-2">
      <span className={`mt-2 h-2 w-2 rounded-full ${item.highlight ? 'bg-amber-400' : 'bg-[#0E7C6B]'}`} />
      <span
        className="text-sm text-gray-600 [&>strong]:font-semibold [&>strong]:text-[#0D1117]"
        dangerouslySetInnerHTML={{ __html: item.content }}
      />
    </div>
  );

  /**
   * Hàm render danh sách ngân hàng tin cậy.
   * Mục đích: hiển thị các đơn vị hỗ trợ PayOS.
   */
  const renderTrustedBank = (bank: string) => (
    <span
      key={bank}
      className="rounded-md border border-gray-200 bg-white px-3 py-1 text-[10px] font-semibold text-gray-500 shadow-sm"
    >
      {bank}
    </span>
  );

  return (
    <>
      {/* Ghi chú: Kiểm tra auth trước khi render nội dung — ngăn flash bằng cách
          chỉ render nội dung deposit khi đã xác thực, modal đăng nhập hiển thị phủ lên trên. */}
      {isLoginModalVisible && (
        <LoginModal onClose={handleCloseLoginModal} />
      )}

      <main className="min-h-screen overflow-x-hidden bg-[#F8FAFB] text-[#0D1117]">
        <div
          className={`fixed top-0 left-0 right-0 z-50 h-[3px] origin-left bg-gradient-to-r from-[#0E7C6B] to-[#1AAE97] transition-transform duration-700 ${isProgressBarRunning ? 'scale-x-100' : 'scale-x-0'
            }`}
        />

        <div className="flex min-w-0">
          <aside className="hidden h-screen w-[240px] flex-col overflow-y-auto bg-[#0D1117] pb-6 text-white lg:fixed lg:inset-y-0 lg:left-0 lg:z-40 lg:flex">
            <Link href="/" className="flex items-center gap-3 border-b border-white/10 px-6 py-6">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#0E7C6B] shadow-lg">
                ❤
              </span>
              <div>
                <div className="text-lg font-extrabold">DCP</div>
                <div className="text-[10px] text-white/50">Decentralized Charity</div>
              </div>
            </Link>
            <div className="border-b border-white/10 px-6 py-4">
              {isSidebarLoading ? (
                <div className="text-xs text-white/60">Đang tải dữ liệu tài khoản...</div>
              ) : sidebarErrorMessage ? (
                <div className="rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                  {sidebarErrorMessage}
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-3">
                    <div className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-[#0E7C6B] to-[#1AAE97] text-sm font-bold">
                      {sidebarUserInitials}
                    </div>
                    <div>
                      <div className="text-sm font-semibold">{sidebarProfile?.fullName || 'Người dùng'}</div>
                      <div className="text-xs text-white/40">{sidebarWalletAddressDisplay}</div>
                    </div>
                  </div>
                  <div className="mt-3 inline-flex items-center rounded-full border border-amber-400/40 bg-amber-400/10 px-3 py-1 text-xs font-semibold text-amber-400">
                    💛 {sidebarProfile?.role || 'DONOR'}
                  </div>
                  <div className="mt-4 rounded-xl border border-[#0E7C6B]/40 bg-[#0E7C6B]/15 px-4 py-3">
                    <div className="text-[10px] uppercase tracking-[0.2em] text-white/50">Số dư Token</div>
                    <div className="text-xl font-extrabold text-[#1AAE97]">{sidebarTokenBalanceDisplay}</div>
                    <div className="text-xs text-white/50">Charity Token</div>
                    <div className="text-xs text-white/40">≈ {sidebarTokenBalanceVndDisplay}</div>

                  </div>
                </>
              )}
            </div>
            <div className="border-t border-white/10 px-3 pb-5 pt-3 text-sm">
              <button
                type="button"
                onClick={handleLogout}
                className="flex w-full items-center justify-center rounded-xl bg-red-500/15 px-4 py-2.5 text-sm font-semibold text-red-400 ring-1 ring-red-400/40 transition hover:bg-red-500/25 hover:text-red-300"
              >
                Đăng xuất
              </button>
            </div>
          </aside>

          {isMobileMenuOpen && (
            <>
              <button
                type="button"
                aria-label="Đóng menu"
                onClick={handleCloseMobileMenu}
                className="fixed inset-0 z-40 bg-black/45 lg:hidden"
              />
              <aside className="fixed inset-y-0 left-0 z-50 flex w-[88vw] max-w-[320px] flex-col overflow-y-auto bg-[#0D1117] pb-6 text-white shadow-2xl lg:hidden">
                <div className="flex items-center justify-between border-b border-white/10 px-5 py-5">
                  <Link href="/" onClick={handleCloseMobileMenu} className="flex min-w-0 items-center gap-3">
                    <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#0E7C6B] shadow-lg">
                      ❤
                    </span>
                    <div className="min-w-0">
                      <div className="text-lg font-extrabold">DCP</div>
                      <div className="text-[10px] text-white/50">Decentralized Charity</div>
                    </div>
                  </Link>
                  <button
                    type="button"
                    onClick={handleCloseMobileMenu}
                    className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-white/5 text-sm text-white/80"
                  >
                    ✕
                  </button>
                </div>

                <div className="border-b border-white/10 px-5 py-4">
                  {isSidebarLoading ? (
                    <div className="text-xs text-white/60">Đang tải dữ liệu tài khoản...</div>
                  ) : sidebarErrorMessage ? (
                    <div className="rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                      {sidebarErrorMessage}
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center gap-3">
                        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-[#0E7C6B] to-[#1AAE97] text-sm font-bold">
                          {sidebarUserInitials}
                        </div>
                        <div className="min-w-0">
                          <div className="text-sm font-semibold">{sidebarProfile?.fullName || 'Người dùng'}</div>
                          <div className="truncate text-xs text-white/40">{sidebarWalletAddressDisplay}</div>
                        </div>
                      </div>
                      <div className="mt-3 inline-flex items-center rounded-full border border-amber-400/40 bg-amber-400/10 px-3 py-1 text-xs font-semibold text-amber-400">
                        💛 {sidebarProfile?.role || 'DONOR'}
                      </div>
                      <div className="mt-4 rounded-xl border border-[#0E7C6B]/40 bg-[#0E7C6B]/15 px-4 py-3">
                        <div className="text-[10px] uppercase tracking-[0.2em] text-white/50">Số dư Token</div>
                        <div className="text-xl font-extrabold text-[#1AAE97]">{sidebarTokenBalanceDisplay}</div>
                        <div className="text-xs text-white/50">Charity Token</div>
                        <div className="text-xs text-white/40">≈ {sidebarTokenBalanceVndDisplay}</div>
                      </div>
                    </>
                  )}
                </div>

                <div className="px-5 py-4">
                  <div className="mb-3 text-[11px] font-semibold uppercase tracking-[0.2em] text-white/40">Điều hướng nhanh</div>
                  <div className="space-y-2 text-sm">
                    <button
                      type="button"
                      onClick={handleCloseMobileMenu}
                      className="flex w-full items-center justify-between rounded-xl bg-white/5 px-4 py-3 text-left text-white"
                    >
                      <span>Tổng quan nạp tiền</span>
                      <span className="text-[#1AAE97]">Đang mở</span>
                    </button>
                    <Link href="/#projects" onClick={handleCloseMobileMenu} className="flex items-center justify-between rounded-xl bg-white/5 px-4 py-3 text-white/80">
                      <span>Dự án từ thiện</span>
                      <span>↗</span>
                    </Link>
                  </div>
                </div>

                <div className="mt-auto border-t border-white/10 px-5 pb-5 pt-4 text-sm">
                  <button
                    type="button"
                    onClick={handleLogout}
                    className="flex w-full items-center justify-center rounded-xl bg-red-500/15 px-4 py-2.5 text-sm font-semibold text-red-400 ring-1 ring-red-400/40 transition hover:bg-red-500/25 hover:text-red-300"
                  >
                    Đăng xuất
                  </button>
                </div>
              </aside>
            </>
          )}

          <section className="flex-1 px-3 pb-28 pt-5 sm:px-4 sm:pt-8 lg:ml-[240px] lg:px-10 lg:pb-16">
            <div
              className={`mb-6 flex flex-col gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700 shadow-sm transition-all sm:flex-row sm:items-center sm:justify-between ${isConfirmBannerVisible ? 'translate-y-0 opacity-100' : '-translate-y-4 opacity-0'}`}
            >
              <div className="flex items-start gap-2 font-semibold sm:items-center">
                <span className="text-base">✅</span>
                <span>Thanh toán xác nhận · Token đã được mint</span>
              </div>
              <button type="button" onClick={handleCloseToast} className="self-start text-xs font-semibold text-emerald-700 sm:self-auto">
                Đóng
              </button>
            </div>
            <div className="mb-7 min-w-0">
              <div className="flex flex-wrap items-center gap-2 text-xs text-gray-400">
                <span>Tổng quan</span>
                <svg className="h-3 w-3 text-[#E5E7EB]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M9 6l6 6-6 6" />
                </svg>
                <span className="font-medium text-[#0E7C6B]">Nạp tiền</span>
              </div>
              <h1 className="mt-3 text-2xl font-extrabold sm:text-3xl">💰 Nạp tiền</h1>
              <p className="mt-2 text-sm leading-6 text-gray-400">
                Chuyển VNĐ thành Charity Token để bắt đầu quyên góp cho dự án từ thiện
              </p>

              <div className="mt-3 min-w-0 space-y-2">
                <div className="break-words rounded-xl border border-gray-200 bg-white px-4 py-3 text-xs text-gray-600">
                  <span className="font-semibold text-[#0D1117]">Order Code:</span>{' '}
                  {currentOrderCode || 'Chưa có'}
                </div>
                <div className="rounded-xl border border-[#0E7C6B]/20 bg-[#E6F7F4] px-4 py-3 text-xs leading-6 text-[#0E7C6B]">
                  {depositStatusMessage}
                  {currentDepositStatus === 'PENDING_PAYMENT' && paymentExpiredAt && (
                    <div className="mt-2 text-[11px] font-semibold text-amber-700">
                      Thời gian còn lại để thanh toán: {paymentCountdownDisplay}
                    </div>
                  )}
                </div>
                {(currentDepositStatus === 'PENDING_PAYMENT' && paymentCountdownSeconds === 0) || isPaymentTimeoutFailed ? (
                  <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-700">
                    Mã thanh toán đã hết hạn. Vui lòng tạo mã mới để tiếp tục.
                    <button
                      type="button"
                      onClick={handleCreateNewPaymentCode}
                      className="mt-2 inline-flex rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-amber-600"
                    >
                      Tạo mã mới
                    </button>
                  </div>
                ) : null}
                {errorMessage && (
                  <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-600">
                    {errorMessage}
                  </div>
                )}
              </div>
            </div>

            <div className="grid gap-5 lg:grid-cols-[1fr_340px] lg:gap-6">
              <div className="space-y-5">
                <div className="rounded-2xl border border-black/5 bg-white px-4 py-5 shadow-sm sm:px-6 sm:py-6">
                  <div className="mb-4 inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-[#0E7C6B]">
                    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[#0E7C6B] text-white">1</span>
                    Nhập số tiền nạp
                  </div>
                  <div className="overflow-hidden rounded-xl border-2 border-[#E5E7EB] bg-white sm:flex sm:items-center">
                    <div className="flex h-16 w-full flex-col items-center justify-center bg-[#E6F7F4] text-[#0E7C6B] sm:h-[72px] sm:w-24">
                      <div className="text-sm font-bold">VNĐ</div>
                      <div className="text-[10px] opacity-60">Việt Nam Đồng</div>
                    </div>
                    <input
                      className="h-16 w-full bg-transparent px-4 text-2xl font-bold outline-none sm:h-[72px] sm:flex-1 sm:text-3xl"
                      placeholder="0"
                      inputMode="numeric"
                      value={amountValue === 0 ? '' : amountValue.toLocaleString('vi-VN')}
                      onChange={handleAmountInputChange}
                      aria-label="Số tiền nạp"
                    />
                    <div className="flex h-16 w-full flex-col items-center justify-center border-t border-[#E5E7EB] px-4 sm:h-[72px] sm:w-32 sm:border-t-0 sm:border-l sm:border-[#E5E7EB] sm:px-0">
                      <div className={`text-sm font-bold ${amountValue ? 'text-[#0E7C6B]' : 'text-gray-300'}`}>
                        {amountValue ? formattedToken : 'Token'}
                      </div>
                      <div className="text-[10px] text-gray-400">Nhận được</div>
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-gray-400">
                    <span className="text-[#0E7C6B]">✔</span>
                    Tỷ lệ cố định: <span className="font-medium text-[#0E7C6B]">1 VNĐ = 1 Charity Token</span> · Không phí
                    chuyển đổi
                  </div>
                  <div className="mt-4 flex flex-wrap gap-2">
                    {quickChips.map(renderQuickChip)}
                  </div>
                  <div className="mt-4 flex items-center gap-2 text-xs text-amber-500">
                    ⚠ Số tiền tối thiểu: 10,000 VNĐ
                  </div>
                </div>

                <div className="rounded-2xl border border-black/5 bg-white px-4 py-5 shadow-sm sm:px-6 sm:py-6">
                  <div className="mb-4 inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-[#0E7C6B]">
                    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[#0E7C6B] text-white">2</span>
                    Kiểm tra ví nhận
                  </div>
                  <div className="rounded-xl border border-[#0E7C6B]/30 bg-[#E6F7F4] px-5 py-4">
                    <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-[#0E7C6B]">
                      <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-[#0E7C6B] text-[9px] text-white">
                        ⛓
                      </span>
                      Smart Account của bạn
                    </div>
                    <div className="mt-2 break-all font-mono text-sm text-[#0D1117]">
                      {sidebarProfile?.walletAddress || 'Chưa có địa chỉ ví'}
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2 text-xs font-semibold">
                      <span className="rounded-full bg-[#0E7C6B]/10 px-3 py-1 text-[#0E7C6B]">Amoy Testnet</span>
                      <span className="rounded-full bg-[#0E7C6B]/10 px-3 py-1 text-[#0E7C6B]">ERC-4337</span>
                      <span className="rounded-full bg-[#D1FAE5] px-3 py-1 text-[#065F46]">✓ Đã xác thực</span>
                    </div>
                  </div>
                </div>

                <div className="rounded-2xl border border-black/5 bg-white px-4 py-5 shadow-sm sm:px-6 sm:py-6">
                  <div className="mb-4 inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-[#0E7C6B]">
                    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[#0E7C6B] text-white">3</span>
                    Tóm tắt thanh toán
                  </div>
                  <div className="space-y-3 text-sm text-gray-500">
                    <div className="flex items-center justify-between border-b border-gray-100 pb-3">
                      <span className="text-gray-400">Số tiền nạp</span>
                      <span className="font-semibold text-[#0D1117]">{formattedAmount}</span>
                    </div>
                    <div className="flex items-center justify-between border-b border-gray-100 pb-3">
                      <span className="text-gray-400">Phí xử lý PayOS</span>
                      <span className="font-semibold text-emerald-500">Miễn phí</span>
                    </div>
                    <div className="flex items-center justify-between border-b border-gray-100 pb-3">
                      <span className="text-gray-400">Tỷ lệ quy đổi</span>
                      <span className="font-semibold text-[#0D1117]">1 VNĐ = 1 Token</span>
                    </div>
                    <div className="rounded-xl border border-[#0E7C6B]/20 bg-[#E6F7F4] px-4 py-4">
                      <div className="text-sm font-semibold text-[#0E7C6B]">Tổng nhận được</div>
                      <div className="mt-1 text-xl font-extrabold text-[#0E7C6B]">{formattedToken}</div>
                      <div className="text-xs text-gray-400">≈ {formattedAmount}</div>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={handleOpenModal}
                    disabled={amountValue === 0}
                    className="mt-5 flex h-14 w-full flex-col items-center justify-center rounded-xl bg-[#F59E0B] font-bold text-[#0D1117] shadow-lg transition hover:-translate-y-0.5 hover:bg-[#E08E00] disabled:cursor-not-allowed disabled:bg-gray-200"
                  >
                    <span className="text-base">Thanh toán bằng PayOS</span>
                    <span className="text-[11px] font-normal text-black/60">Chuyển khoản an toàn, xác nhận nhanh</span>
                  </button>
                  <div className="mt-3 flex flex-wrap items-center justify-center gap-2 text-center text-xs text-gray-400">
                    <span className="text-emerald-500">✔</span> Thanh toán bảo mật qua PayOS · Hỗ trợ tất cả ngân hàng Việt Nam
                  </div>
                  <div className="bank-logos mt-3 flex flex-wrap justify-center gap-2">
                    {trustedBanks.map(renderTrustedBank)}
                  </div>
                </div>
              </div>

              <aside className="space-y-5">
                <div className="rounded-2xl border border-[#0E7C6B]/10 bg-[#E6F7F4] px-4 py-5 sm:px-5 sm:py-6">
                  <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-[#0E7C6B]">
                    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <circle cx="12" cy="12" r="10" />
                      <line x1="12" y1="16" x2="12" y2="12" />
                      <line x1="12" y1="8" x2="12" y2="8" />
                    </svg>
                    Thông tin quan trọng
                  </div>
                  <div className="space-y-2">
                    {noteItems.map(renderNoteItem)}
                  </div>
                </div>

                <div className="rounded-2xl border border-black/5 bg-white px-4 py-5 shadow-sm sm:px-5 sm:py-6">
                  <div className="mb-4 flex items-center justify-between">
                    <div className="text-sm font-semibold text-[#0D1117]">Quy trình nạp tiền</div>
                    <span className="text-xs text-[#0E7C6B]">Realtime</span>
                  </div>
                  <div className="space-y-4">
                    {processSteps.map((step, index) => renderProcessStep(step, index))}
                  </div>
                </div>

                <div ref={recentTransactionsSectionReference} className="rounded-2xl border border-black/5 bg-white px-4 py-5 shadow-sm sm:px-5 sm:py-6">
                  <div className="mb-4 flex items-center justify-between">
                    <div className="text-sm font-semibold text-[#0D1117]">Giao dịch gần đây</div>
                  </div>
                  <div className="space-y-3">
                    {isSidebarLoading && <div className="text-xs text-gray-400">Đang tải giao dịch...</div>}
                    {!isSidebarLoading && sidebarErrorMessage && (
                      <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600">
                        {sidebarErrorMessage}
                      </div>
                    )}
                    {!isSidebarLoading && !sidebarErrorMessage && sidebarRecentTransactions.length === 0 && (
                      <div className="rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-500">
                        Chưa có giao dịch nạp tiền gần đây.
                      </div>
                    )}
                    {!isSidebarLoading && !sidebarErrorMessage && sidebarRecentTransactions.map(renderRecentTransaction)}
                  </div>
                </div>
              </aside>
            </div>
          </section>
        </div>

        {isModalOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 py-6">
            <div className="max-h-[calc(100vh-3rem)] w-full max-w-md overflow-y-auto rounded-2xl bg-white p-5 text-center shadow-2xl sm:p-8">
              <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full border border-amber-400/40 bg-amber-100 text-3xl">
                💳
              </div>
              <h3 className="text-xl font-extrabold">Chuyển đến PayOS</h3>
              <p className="mt-2 text-sm text-gray-400">
                Bạn sẽ được chuyển đến cổng thanh toán an toàn. Hoàn tất thanh toán và quay lại DCP.
              </p>
              <div className="mt-5 flex flex-col gap-1 rounded-xl bg-[#E6F7F4] px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
                <span className="text-gray-500">Số tiền thanh toán</span>
                <span className="font-semibold text-[#0E7C6B]">{formattedAmount}</span>
              </div>
              <div className="mt-6 space-y-3">
                <button
                  type="button"
                  onClick={handleConfirmPayment}
                  className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-[#F59E0B] font-bold text-[#0D1117] shadow-lg"
                >
                  Mở PayOS ngay
                </button>
                <button
                  type="button"
                  onClick={handleCloseModal}
                  className="w-full text-sm text-gray-400"
                >
                  ← Hủy và quay lại
                </button>
              </div>
            </div>
          </div>
        )}

        {isToastOpen && (
          <div className="fixed bottom-24 left-3 right-3 z-50 rounded-2xl border-l-4 border-emerald-500 bg-white px-4 py-4 shadow-2xl sm:bottom-8 sm:left-auto sm:right-6 sm:w-[360px] sm:px-5">
            <div className="flex items-start justify-between gap-3 sm:items-center">
              <div className="text-sm font-bold">✅ Nạp tiền thành công!</div>
              <button type="button" onClick={handleCloseToast} className="h-6 w-6 rounded-full bg-gray-100 text-xs">
                ✕
              </button>
            </div>
            <p className="mt-2 text-xs text-gray-500">Token đã được mint vào ví của bạn</p>
            <div className="mt-3 text-lg font-extrabold text-[#0E7C6B]">+{formattedToken}</div>
            <div className="text-xs text-gray-400">Số dư mới: {sidebarTokenBalanceDisplay} Token</div>
            <div className="mt-4 flex flex-col gap-2 sm:flex-row">
              <button type="button" className="flex-1 rounded-lg bg-[#0E7C6B] py-2 text-xs font-semibold text-white">
                Quyên góp ngay →
              </button>
              <button type="button" className="rounded-lg bg-gray-100 px-3 py-2 text-xs font-semibold text-gray-500">
                Xem giao dịch ↗
              </button>
            </div>
          </div>
        )}

        <nav className="fixed bottom-0 left-0 right-0 z-40 flex items-center justify-around border-t border-gray-200 bg-white/95 px-2 py-3 text-[10px] text-gray-400 backdrop-blur lg:hidden">
          <button type="button" onClick={handleOpenMobileMenu} className="flex flex-col items-center gap-1 text-gray-400">
            <span className="text-base">☰</span>
            Menu
          </button>
          <button type="button" onClick={handleNavigateToOverview} className="flex flex-col items-center gap-1 text-gray-400">
            <span className="text-base">🏠</span>
            Trang chủ
          </button>
          <button type="button" className="flex flex-col items-center gap-1 text-[#0E7C6B]">
            <span className="text-base">💳</span>
            Nạp tiền
          </button>
          <button type="button" onClick={handleNavigateToProjects} className="flex flex-col items-center gap-1 text-gray-400">
            <span className="text-base">🎁</span>
            Dự án
          </button>
          <button type="button" onClick={handleNavigateToRecentTransactions} className="flex flex-col items-center gap-1 text-gray-400">
            <span className="text-base">🧾</span>
            Lịch sử
          </button>
        </nav>
      </main>
    </>
  );
}
/**
 * Hàm render trang Deposit với Suspense boundary.
 * Mục đích: đáp ứng yêu cầu của Next.js khi dùng useSearchParams trong Client Component.
 */
export default function DepositHomePage() {
  return (
    <Suspense
      fallback={(
        <main className="min-h-screen bg-[#F8FAFB] p-6 text-sm text-gray-500">
          Đang tải trang nạp tiền...
        </main>
      )}
    >
      <DepositHomePageContent />
    </Suspense>
  );
}
