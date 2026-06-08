'use client';

import { useCallback, useEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import { ApiErrorResponse, buildApiUrl, fetchApi } from '../../utils/apiClient';
import { readAuthSession } from '../../utils/authSession';
import { useGuestWallet } from '../../components/GuestWalletProvider';
import {
  initPayosDonation,
  getPayosDonationStatus,
  type PayosDonationStatus,
} from '../../utils/guestPayosClient';
import {
  executeOneClickDonationRequest,
  recordDonationByTransactionHash,
} from './DonationModal.services';
import {
  formatWalletAddress,
  formatTransactionHash,
  mapDonationErrorMessage,
  mapTransactionStatusToVietnamese,
  isCampaignBeforeDeadline,
} from './DonationModal.helpers';
import type {
  DonationCampaignItem,
  DonationHistoryItem,
  TransactionStatus,
  DonationModalProps,
} from './DonationModal.types';
import {
  MIN_AMOUNT_PER_DONATION,
  MAX_AMOUNT_PER_DONATION,
} from '../../constants/guestDonationLimits';

/* ============================================================
 * DONATION MODAL — CONTAINER
 * Route guest vs authenticated → render sub-view tương ứng.
 * Chỉ chứa state và routing logic, không chứa API calls hay render views.
 * ============================================================ */
export default function DonationModal({ campaignItem, onClose, onDonationSuccess }: DonationModalProps) {
  // ============================================================
  // SHARED STATE
  // ============================================================
  const [donationAmountInput, setDonationAmountInput] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isConfirmModalOpen, setIsConfirmModalOpen] = useState(false);
  const [pendingDonationAmount, setPendingDonationAmount] = useState<number | null>(null);
  const [transactionStatus, setTransactionStatus] = useState<TransactionStatus>('idle');
  const [statusMessage, setStatusMessage] = useState('');
  const [successNoticeMessage, setSuccessNoticeMessage] = useState('');
  const [isSuccessNoticeVisible, setIsSuccessNoticeVisible] = useState(false);
  const [historyList, setHistoryList] = useState<DonationHistoryItem[]>([]);

  // PayOS donation state
  const [payosOrderCode, setPayosOrderCode] = useState<string | null>(null);
  const [payosPaymentUrl, setPayosPaymentUrl] = useState<string | null>(null);
  const [payosStatus, setPayosStatus] = useState<PayosDonationStatus | null>(null);
  const [isAwaitingPayment, setIsAwaitingPayment] = useState(false);

  // ============================================================
  // AUTH USER
  // ============================================================
  const { accessToken } = readAuthSession();
  const isAuthenticated = Boolean(accessToken);

  // ============================================================
  // GUEST WALLET
  // ============================================================
  const {
    initState,
    bootstrapGuestWallet,
  } = useGuestWallet();

  const isGuestReady = initState.initStatus === 'READY';

  // ============================================================
  // LOAD HISTORY
  // ============================================================
  const loadDonationHistory = useCallback(async () => {
    try {
      const response = await fetchApi<DonationHistoryItem[]>(
        buildApiUrl(`/donations/campaigns/${campaignItem.projectId}/history?limit=5`),
        { method: 'GET', cache: 'no-store' },
      );
      setHistoryList(response.data);
    } catch (error) {
      const apiError = error as ApiErrorResponse;
      setStatusMessage(apiError.message || 'Không thể tải lịch sử quyên góp.');
    }
  }, [campaignItem.projectId]);

  // Load history khi mount hoặc khi projectId thay đổi
  useEffect(() => {
    void loadDonationHistory();
  }, [loadDonationHistory]);
  // ============================================================
  // AUTO-HIDE SUCCESS NOTICE
  // ============================================================
  useEffect(() => {
    if (!isSuccessNoticeVisible || !successNoticeMessage) return;

    const timerId = window.setTimeout(() => {
      setIsSuccessNoticeVisible(false);
      setSuccessNoticeMessage('');
    }, 5000);

    return () => window.clearTimeout(timerId);
  }, [isSuccessNoticeVisible, successNoticeMessage]);

  // ============================================================
  // PAYOS POLLING — theo dõi trạng thái thanh toán PayOS
  // ============================================================
  useEffect(() => {
    if (!isAwaitingPayment || !payosOrderCode || !initState.guestSessionToken) return;

    const pollIntervalId = window.setInterval(async () => {
      try {
        const status = await getPayosDonationStatus(payosOrderCode, initState.guestSessionToken!);
        setPayosStatus(status.status);

        if (status.status === 'COMPLETED') {
          window.clearInterval(pollIntervalId);
          setIsAwaitingPayment(false);
          setStatusMessage('Quyên góp thành công! Cảm ơn bạn vì tấm lòng sẻ chia.');
          setIsSuccessNoticeVisible(true);
          setSuccessNoticeMessage(
            `Quyên góp thành công! Tx: ${status.relayTxHash ? formatTransactionHash(status.relayTxHash) : 'đang xử lý'}`
          );
          setDonationAmountInput('');
          setPayosOrderCode(null);
          setPayosPaymentUrl(null);
          void loadDonationHistory();
          void onDonationSuccess(campaignItem.projectId);
        } else if (status.status === 'FAILED') {
          window.clearInterval(pollIntervalId);
          setIsAwaitingPayment(false);
          setStatusMessage(status.errorMessage || 'Thanh toán thất bại. Vui lòng thử lại.');
          setPayosOrderCode(null);
          setPayosPaymentUrl(null);
        }
      } catch {
        // Poll lỗi → bỏ qua, tiếp tục poll
      }
    }, 3000);

    return () => window.clearInterval(pollIntervalId);
  }, [isAwaitingPayment, payosOrderCode, initState.guestSessionToken, campaignItem.projectId, onDonationSuccess, loadDonationHistory]);

  // ============================================================
  // VALIDATION
  // ============================================================
  /** Kiểm tra dữ liệu trước khi mở modal xác nhận — dùng chung cho cả 2 path. */
  const validateDonationInput = useCallback((min: number, max: number): number | null => {
    const parsedAmount = Number(donationAmountInput);
    // Reject decimals: Solidity contracts work with integers only.
    if (!Number.isFinite(parsedAmount) || !Number.isInteger(parsedAmount) || parsedAmount < min || parsedAmount > max) {
      setStatusMessage(`Số token quyên góp phải là số nguyên từ ${min.toLocaleString()} đến ${max.toLocaleString()}.`);
      return null;
    }
    if (!campaignItem.projectId) {
      setStatusMessage('projectId không hợp lệ.');
      return null;
    }
    if (campaignItem.status !== 'ACTIVE' || !isCampaignBeforeDeadline(campaignItem.deadline)) {
      setStatusMessage('Dự án hiện không đủ điều kiện nhận quyên góp.');
      return null;
    }
    return parsedAmount;
  }, [donationAmountInput, campaignItem]);

  /** Mở modal xác nhận — đảm bảo người dùng luôn xác nhận trước khi submit. */
  const handleOpenConfirmModal = useCallback((min: number, max: number) => {
    const amount = validateDonationInput(min, max);
    if (amount === null) return;
    setPendingDonationAmount(amount);
    setIsConfirmModalOpen(true);
  }, [validateDonationInput]);

  // ============================================================
  // AUTHENTICATED FLOW — SUBMIT
  // ============================================================

  /** Xử lý hiển thị thành công sau khi blockchain confirm — tách riêng để dễ đọc. */
  const handleAuthDonationSuccess = useCallback((
    transactionHash: string,
    projectId: string,
    accessToken: string,
  ) => {
    const shortenedTransactionHash = formatTransactionHash(transactionHash);
    setTransactionStatus('submitted');
    setStatusMessage(`Đã gửi giao dịch lên blockchain (${shortenedTransactionHash}). Đang ghi nhận vào hệ thống...`);

    recordDonationByTransactionHash(accessToken, projectId, transactionHash).catch(err => {
      console.warn('[DonationModal] recordDonationByTransactionHash thất bại (backend đã ghi nền):', (err as ApiErrorResponse)?.message);
    });

    setTransactionStatus('success');
    setStatusMessage('Giao dịch quyên góp đã được xác nhận thành công trên blockchain.');
    setSuccessNoticeMessage('Quyên góp thành công! Cảm ơn bạn vì tấm lòng sẻ chia.');
    setIsSuccessNoticeVisible(true);

    void Promise.allSettled([
      loadDonationHistory(),
      onDonationSuccess(projectId).catch(err => {
        console.warn('[DonationModal] onDonationSuccess thất bại:', err);
      }),
    ]);
  }, [loadDonationHistory, onDonationSuccess]);

  /** Xử lý hiển thị lỗi khi donation thất bại — tách riêng để dễ đọc. */
  const handleAuthDonationError = useCallback((error: unknown) => {
    const caughtError = error as ApiErrorResponse;
    console.error('[DonationModal] handleConfirmDonationSubmit lỗi:', {
      statusCode: caughtError?.statusCode,
      errorCode: caughtError?.errorCode,
      message: caughtError?.message,
    });
    setTransactionStatus('failed');
    setStatusMessage(mapDonationErrorMessage(error));
  }, []);

  const handleConfirmDonationSubmit = async () => {
    if (isSubmitting) return;

    if (!campaignItem.projectId || pendingDonationAmount === null) {
      setStatusMessage('Không tìm thấy thông tin quyên góp hợp lệ. Vui lòng thử lại.');
      setIsConfirmModalOpen(false);
      setPendingDonationAmount(null);
      return;
    }

    const { accessToken: token } = readAuthSession();
    if (!token) {
      setTransactionStatus('failed');
      setStatusMessage('Bạn chưa đăng nhập hoặc phiên đã hết hạn. Vui lòng đăng nhập lại để quyên góp.');
      setIsConfirmModalOpen(false);
      setPendingDonationAmount(null);
      return;
    }

    try {
      // Force sync render để hiển thị loading state TRƯỚC KHI modal đóng
      flushSync(() => setIsSubmitting(true));
      setIsConfirmModalOpen(false);

      setTransactionStatus('processing');
      setStatusMessage('Hệ thống đang gửi giao dịch quyên góp, vui lòng chờ trong giây lát...');

      const transactionHash = await executeOneClickDonationRequest(
        token,
        campaignItem.projectId,
        pendingDonationAmount,
        false,
      );

      void handleAuthDonationSuccess(transactionHash, campaignItem.projectId, token);
    } catch (error) {
      void handleAuthDonationError(error);
    } finally {
      setIsSubmitting(false);
    }
  };

  // ============================================================
  // GUEST FLOW — SUBMIT (PayOS flow)
  // ============================================================
  const handleGuestDonationSubmit = async () => {
    if (isSubmitting) return;

    if (!campaignItem.projectId) {
      setStatusMessage('projectId không hợp lệ.');
      return;
    }
    if (campaignItem.status !== 'ACTIVE' || !isCampaignBeforeDeadline(campaignItem.deadline)) {
      setStatusMessage('Dự án hiện không đủ điều kiện nhận quyên góp.');
      return;
    }

    if (pendingDonationAmount === null) return;
    const amount = pendingDonationAmount;

    if (!initState.guestSessionToken) {
      setStatusMessage('Guest session chưa sẵn sàng. Vui lòng thử lại.');
      return;
    }

    setIsConfirmModalOpen(false);
    setIsSubmitting(true);
    setStatusMessage('Đang tạo mã thanh toán QR...');

    try {
      const payosResult = await initPayosDonation(
        { projectId: campaignItem.projectId, amount },
        initState.guestSessionToken
      );
      setPayosOrderCode(payosResult.orderCode);
      setPayosPaymentUrl(payosResult.paymentUrl);
      setPayosStatus('PENDING_PAYMENT');
      setIsAwaitingPayment(true);
      setStatusMessage('Đang chờ thanh toán...');
    } catch (error) {
      setStatusMessage(
        error instanceof Error
          ? error.message
          : 'Không thể tạo mã thanh toán. Vui lòng thử lại.'
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  // ============================================================
  // BOOTSTRAP
  // ============================================================
  const handleBootstrapGuestWallet = async () => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    try {
      await bootstrapGuestWallet();
    } finally {
      setIsSubmitting(false);
    }
  };

  // ============================================================
  // MODAL CONTROLS
  // ============================================================
  const handleCloseConfirmModal = () => {
    setIsConfirmModalOpen(false);
    setPendingDonationAmount(null);
  };

  const handleBackdropClick = () => {
    if (isSubmitting || isSuccessNoticeVisible) return;
    onClose();
  };

  // ============================================================
  // ROUTE TO SUB-VIEWS
  // ============================================================
  if (isAuthenticated) {
    return (
      <AuthenticatedDonationView
        campaignItem={campaignItem}
        donationAmountInput={donationAmountInput}
        setDonationAmountInput={setDonationAmountInput}
        isSubmitting={isSubmitting}
        isConfirmModalOpen={isConfirmModalOpen}
        pendingDonationAmount={pendingDonationAmount}
        transactionStatus={transactionStatus}
        statusMessage={statusMessage}
        successNoticeMessage={successNoticeMessage}
        isSuccessNoticeVisible={isSuccessNoticeVisible}
        historyList={historyList}
        onOpenConfirmModal={() => handleOpenConfirmModal(
          campaignItem.minDonation,
          campaignItem.maxDonation,
        )}
        onCloseConfirmModal={handleCloseConfirmModal}
        onConfirmSubmit={handleConfirmDonationSubmit}
        onClose={handleBackdropClick}
      />
    );
  }

  if (!isGuestReady) {
    return (
      <GuestNoWalletView
        campaignItem={campaignItem}
        initState={initState}
        isSubmitting={isSubmitting}
        onBootstrap={handleBootstrapGuestWallet}
        onClose={handleBackdropClick}
      />
    );
  }

  return (
      <GuestReadyView
      campaignItem={campaignItem}
      initState={initState}
      donationAmountInput={donationAmountInput}
      setDonationAmountInput={setDonationAmountInput}
      isSubmitting={isSubmitting}
      isConfirmModalOpen={isConfirmModalOpen}
      pendingDonationAmount={pendingDonationAmount}
      statusMessage={statusMessage}
      successNoticeMessage={successNoticeMessage}
      isSuccessNoticeVisible={isSuccessNoticeVisible}
      onOpenConfirmModal={() => handleOpenConfirmModal(MIN_AMOUNT_PER_DONATION, MAX_AMOUNT_PER_DONATION)}
      onCloseConfirmModal={handleCloseConfirmModal}
      onGuestSubmit={handleGuestDonationSubmit}
      onClose={handleBackdropClick}
      payosOrderCode={payosOrderCode}
      payosPaymentUrl={payosPaymentUrl}
      payosStatus={payosStatus}
      isAwaitingPayment={isAwaitingPayment}
    />
  );
}

/* ============================================================
 * SUB-VIEW: AUTHENTICATED DONATION
 * ============================================================ */

interface AuthenticatedDonationViewProps {
  campaignItem: DonationCampaignItem;
  donationAmountInput: string;
  setDonationAmountInput: (value: string) => void;
  isSubmitting: boolean;
  isConfirmModalOpen: boolean;
  pendingDonationAmount: number | null;
  transactionStatus: TransactionStatus;
  statusMessage: string;
  successNoticeMessage: string;
  isSuccessNoticeVisible: boolean;
  historyList: DonationHistoryItem[];
  onOpenConfirmModal: () => void;
  onCloseConfirmModal: () => void;
  onConfirmSubmit: () => void;
  onClose: () => void;
}

function AuthenticatedDonationView({
  campaignItem,
  donationAmountInput,
  setDonationAmountInput,
  isSubmitting,
  isConfirmModalOpen,
  pendingDonationAmount,
  transactionStatus,
  statusMessage,
  successNoticeMessage,
  isSuccessNoticeVisible,
  historyList,
  onOpenConfirmModal,
  onCloseConfirmModal,
  onConfirmSubmit,
  onClose,
}: AuthenticatedDonationViewProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#111827]/60 p-4" onClick={onClose}>
      <div className="w-full max-w-2xl rounded-xl bg-white p-5" onClick={(e) => e.stopPropagation()}>
        {isSuccessNoticeVisible && successNoticeMessage && (
          <div className="mt-4 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-3 text-sm font-semibold text-emerald-700 shadow-sm">
            {successNoticeMessage}
            <div className="mt-1 text-xs font-normal text-emerald-600">Thông báo sẽ tự ẩn sau 5 giây.</div>
          </div>
        )}

        <h3 className="text-lg font-semibold text-[#111827]">Quyên góp cho dự án</h3>
        <p className="mt-1 text-sm text-[#374151]">
          {campaignItem.name} · #{campaignItem.projectId} · {campaignItem.status}
        </p>

        <input
          type="number"
          min={campaignItem.minDonation}
          max={campaignItem.maxDonation}
          value={donationAmountInput}
          onChange={e => setDonationAmountInput(e.target.value)}
          placeholder="Nhập số token muốn quyên góp"
          disabled={isSubmitting}
          className="mt-4 w-full rounded-md border border-[#d1d5db] p-2 disabled:cursor-not-allowed disabled:bg-gray-100 disabled:text-gray-400"
        />
        <p className="mt-1 text-xs text-[#9ca3af]">
          Tối đa {campaignItem.maxDonation.toLocaleString()} token/lần
        </p>

        <div className="mt-4 flex gap-2">
          <button
            type="button"
            disabled={isSubmitting}
            onClick={onOpenConfirmModal}
            className="rounded-md bg-[#0e7c6b] px-4 py-2 text-white disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isSubmitting ? 'Đang quyên góp...' : 'Quyên góp'}
          </button>
          <button
            type="button"
            disabled={isSubmitting || isSuccessNoticeVisible}
            onClick={onClose}
            className="rounded-md border border-[#d1d5db] px-4 py-2 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Hủy
          </button>
        </div>

        {isSubmitting && (
          <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-700">
            Hệ thống đang xử lý giao dịch quyên góp, vui lòng chờ trong giây lát...
          </div>
        )}

        <p className="mt-3 text-sm text-[#374151]">
          Trạng thái: {mapTransactionStatusToVietnamese(transactionStatus)}
        </p>
        <p className="mt-1 text-sm text-[#374151]">{statusMessage}</p>

        <div className="mt-4 space-y-2">
          {historyList.length === 0 && (
            <div className="rounded-md border border-[#e5e7eb] p-2 text-sm">Chưa có lịch sử quyên góp.</div>
          )}
          {historyList.map(item => (
            <div key={item.transactionHash} className="rounded-md border border-[#e5e7eb] p-2 text-sm">
              <div>Giao dịch: {formatTransactionHash(item.transactionHash)}</div>
              <div>Người quyên góp: {item.isAnonymous ? 'Nhà hảo tâm ẩn danh' : formatWalletAddress(item.donorAddress)}</div>
              <div>Số token: {item.amount.toLocaleString('vi-VN')}</div>
            </div>
          ))}
        </div>

        {isConfirmModalOpen && pendingDonationAmount !== null && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/45 p-4">
            <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl">
              <h3 className="text-lg font-semibold text-[#111827]">Xác nhận quyên góp</h3>
              <p className="mt-3 text-sm text-[#374151]">
                Bạn muốn quyên góp <strong>{pendingDonationAmount.toLocaleString('vi-VN')} token</strong> cho dự án này?
              </p>
              <div className="mt-5 flex justify-end gap-2">
                {!isSubmitting && (
                  <button type="button" onClick={onCloseConfirmModal} className="rounded-md border border-[#d1d5db] px-4 py-2 text-sm text-[#374151]">
                    Hủy
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void onConfirmSubmit()}
                  disabled={isSubmitting}
                  className="rounded-md bg-[#0e7c6b] px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isSubmitting ? 'Đang ghi nhận vào hệ thống...' : 'Xác nhận'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ============================================================
 * SUB-VIEW: GUEST — NO WALLET YET
 * ============================================================ */

interface GuestNoWalletViewProps {
  campaignItem: DonationCampaignItem;
  initState: ReturnType<typeof useGuestWallet>['initState'];
  isSubmitting: boolean;
  onBootstrap: () => void;
  onClose: () => void;
}

function GuestNoWalletView({ campaignItem, initState, isSubmitting, onBootstrap, onClose }: GuestNoWalletViewProps) {
  const isBootstrapping = initState.initStatus === 'BOOTSTRAPPING_NEW';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#111827]/60 p-4" onClick={onClose}>
      <div className="w-full max-w-2xl rounded-xl bg-white p-5" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-lg font-semibold text-[#111827]">Quyên góp cho dự án</h3>
        <p className="mt-1 text-sm text-[#374151]">
          {campaignItem.name} · #{campaignItem.projectId} · {campaignItem.status}
        </p>

        <div className="mt-6 rounded-md border border-amber-200 bg-amber-50 px-4 py-4 text-center">
          <p className="text-sm font-semibold text-amber-900">Quyên góp ngay mà không cần đăng nhập</p>
          <p className="mt-2 text-xs text-amber-700">
            Hệ thống sẽ tạo ví tạm thời cho bạn. Bạn có thể quyên góp tối đa <strong>3 lần</strong> với tổng số token lên đến <strong>600,000</strong>.
          </p>
          <p className="mt-1 text-xs text-amber-600">Khóa ví được mã hóa và chỉ lưu trong trình duyệt của bạn.</p>

          {initState.initStatus === 'BOOTSTRAPPING_NEW' && (
            <p className="mt-2 text-xs font-medium text-amber-800">Đang khởi tạo ví...</p>
          )}
          {initState.initStatus === 'ERROR' && (
            <p className="mt-2 text-xs font-medium text-red-600">
              Lỗi: {initState.initError || 'Không thể khởi tạo ví. Vui lòng thử lại.'}
            </p>
          )}
          {initState.initStatus === 'BROWSER_INCOMPATIBLE' && (
            <p className="mt-2 text-xs font-medium text-red-600">
              Trình duyệt không hỗ trợ. Vui lòng sử dụng Chrome, Firefox, hoặc Edge.
            </p>
          )}

          <button
            type="button"
            disabled={isBootstrapping || initState.initStatus === 'BROWSER_INCOMPATIBLE' || initState.initStatus === 'ERROR'}
            onClick={() => void onBootstrap()}
            className="mt-4 rounded-md bg-amber-500 px-6 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-amber-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isBootstrapping ? 'Đang khởi tạo...' : 'Bắt đầu quyên góp ngay'}
          </button>
        </div>

        <div className="mt-4 flex justify-end">
          <button type="button" onClick={onClose} className="rounded-md border border-[#d1d5db] px-4 py-2 text-sm text-[#374151]">
            Đóng
          </button>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
 * SUB-VIEW: GUEST — READY TO DONATE
 * ============================================================ */

interface GuestReadyViewProps {
  campaignItem: DonationCampaignItem;
  initState: ReturnType<typeof useGuestWallet>['initState'];
  donationState: ReturnType<typeof useGuestWallet>['donationState'];
  donationAmountInput: string;
  setDonationAmountInput: (value: string) => void;
  isSubmitting: boolean;
  isConfirmModalOpen: boolean;
  pendingDonationAmount: number | null;
  isGuestDonationInProgress: boolean;
  guestDonationSuccess: boolean;
  guestDisplayStatusValue: string;
  statusMessage: string;
  onOpenConfirmModal: () => void;
  onCloseConfirmModal: () => void;
  onGuestSubmit: () => void;
  onClose: () => void;
  /** PayOS state */
  payosOrderCode: string | null;
  payosPaymentUrl: string | null;
  payosStatus: PayosDonationStatus | null;
  isAwaitingPayment: boolean;
}

function GuestReadyView({
  campaignItem,
  initState,
  donationState,
  donationAmountInput,
  setDonationAmountInput,
  isSubmitting,
  isConfirmModalOpen,
  pendingDonationAmount,
  isGuestDonationInProgress,
  guestDonationSuccess,
  guestDisplayStatusValue,
  statusMessage,
  onOpenConfirmModal,
  onCloseConfirmModal,
  onGuestSubmit,
  onClose,
  payosOrderCode,
  payosPaymentUrl,
  payosStatus,
  isAwaitingPayment,
}: GuestReadyViewProps) {
  const displayError = donationState.donationError;
  const isDonating = isSubmitting || guestDonationSuccess || isGuestDonationInProgress || isAwaitingPayment;

  // PayOS QR overlay — hiển thị khi đang chờ thanh toán
  const showPayosQR = isAwaitingPayment && payosPaymentUrl;

  // Map PayOS status → display text
  const payosStatusText =
    payosStatus === 'PENDING_PAYMENT' ? 'Chờ thanh toán' :
    payosStatus === 'PAYMENT_CONFIRMED' ? 'Đã nhận thanh toán' :
    payosStatus === 'MINTING' ? 'Đang mint token...' :
    payosStatus === 'RELAYING' ? 'Đang quyên góp...' :
    payosStatus === 'COMPLETED' ? 'Hoàn thành' :
    payosStatus === 'FAILED' ? 'Thất bại' :
    '';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#111827]/60 p-4" onClick={onClose}>
      <div className="w-full max-w-2xl rounded-xl bg-white p-5" onClick={(e) => e.stopPropagation()}>
        {/* Success notice */}
        {guestDonationSuccess && (
          <div className="mt-4 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-3 text-sm font-semibold text-emerald-700 shadow-sm">
            Quyên góp thành công! Cảm ơn bạn vì tấm lòng sẻ chia.
            <div className="mt-1 text-xs font-normal text-emerald-600">
              {donationState.lastTxHash
                ? `Tx: ${formatTransactionHash(donationState.lastTxHash)}`
                : donationState.lastUserOpHash
                  ? `UserOp: ${formatTransactionHash(donationState.lastUserOpHash)}`
                  : null}
            </div>
          </div>
        )}

        <h3 className="text-lg font-semibold text-[#111827]">Quyên góp cho dự án</h3>
        <p className="mt-1 text-sm text-[#374151]">
          {campaignItem.name} · #{campaignItem.projectId} · {campaignItem.status}
        </p>

        {/* Wallet info bar */}
        <div className="mt-3 flex items-center gap-2 rounded-md border border-[#e5e7eb] bg-gray-50 px-3 py-2">
          <span className="text-xs text-[#374151]">
            Ví: <span className="font-mono font-medium">{formatWalletAddress(initState.walletAddress ?? '')}</span>
          </span>
          <span className="text-xs text-[#9ca3af]">|</span>
          <span className="text-xs text-[#374151]">
            Còn lại: <span className="font-semibold text-[#0e7c6b]">{initState.remainingDonations}</span>/3 lần
          </span>
          {initState.donationCount > 0 && (
            <>
              <span className="text-xs text-[#9ca3af]">|</span>
              <span className="text-xs text-[#374151]">
                Đã quyên góp: <span className="font-medium">{initState.donationCount}</span> lần
              </span>
            </>
          )}
        </div>

        {/* Pending donation alert */}
        {initState.hasPendingDonation && (
          <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            Hệ thống phát hiện giao dịch đang chờ xử lý. Vui lòng đợi hoặc thử lại sau vài phút.
          </div>
        )}

        {/* Input */}
        <input
          type="number"
          min={MIN_AMOUNT_PER_DONATION}
          max={MAX_AMOUNT_PER_DONATION}
          value={donationAmountInput}
          onChange={e => setDonationAmountInput(e.target.value)}
          placeholder={`Từ ${MIN_AMOUNT_PER_DONATION} đến ${MAX_AMOUNT_PER_DONATION.toLocaleString()} token`}
          disabled={isDonating}
          className="mt-4 w-full rounded-md border border-[#d1d5db] p-2 disabled:cursor-not-allowed disabled:bg-gray-100 disabled:text-gray-400"
        />
        <p className="mt-1 text-xs text-[#9ca3af]">
          Giới hạn: tối thiểu {MIN_AMOUNT_PER_DONATION} token, tối đa {MAX_AMOUNT_PER_DONATION.toLocaleString()} token/lần
        </p>

        {/* Buttons */}
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            disabled={isDonating || initState.remainingDonations <= 0}
            onClick={onOpenConfirmModal}
            className="rounded-md bg-[#0e7c6b] px-4 py-2 text-white disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isAwaitingPayment ? payosStatusText || 'Đang xử lý...' : isDonating ? guestDisplayStatusValue : 'Quyên góp ngay'}
          </button>
          <button
            type="button"
            disabled={isDonating}
            onClick={onClose}
            className="rounded-md border border-[#d1d5db] px-4 py-2 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Hủy
          </button>
        </div>

        {/* PayOS QR Panel — hiển thị khi đang chờ thanh toán */}
        {showPayosQR && payosPaymentUrl && (
          <div className="mt-4 rounded-lg border-2 border-blue-200 bg-blue-50 p-4">
            <h4 className="mb-2 text-sm font-semibold text-blue-900">Mã QR thanh toán</h4>
            {payosStatus === 'PENDING_PAYMENT' && (
              <p className="mb-2 text-xs text-blue-700">
                Quét mã QR bên dưới bằng ứng dụng ngân hàng để thanh toán.
              </p>
            )}
            {payosStatus !== 'PENDING_PAYMENT' && payosStatus && (
              <p className="mb-2 text-xs text-blue-700">
                Trạng thái: <span className="font-medium">{payosStatusText}</span>
              </p>
            )}
            {payosOrderCode && (
              <p className="mb-2 text-xs text-blue-600">Mã đơn: {payosOrderCode}</p>
            )}
            {/* PayOS checkout URL — chuyển hướng trong cùng tab để polling hoạt động */}
            <a
              href={payosPaymentUrl}
              className="mt-2 inline-block rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
            >
              Mở trang thanh toán
            </a>
            <p className="mt-2 text-xs text-blue-600">
              Sau khi thanh toán, hệ thống sẽ tự động quyên góp cho bạn.
            </p>
          </div>
        )}

        {/* Status */}
        <p className="mt-3 text-sm text-[#374151]">
          Trạng thái: <span className={guestDisplayStatusValue === 'failed' ? 'font-semibold text-red-600' : guestDisplayStatusValue === 'success' ? 'font-semibold text-emerald-600' : ''}>
            {isAwaitingPayment && payosStatusText ? payosStatusText : mapGuestTransactionStatusToVietnamese(guestDisplayStatusValue as Parameters<typeof mapGuestTransactionStatusToVietnamese>[0])}
          </span>
        </p>
        {displayError && <p className="mt-1 text-sm text-red-600">{displayError}</p>}
        {statusMessage && !displayError && !showPayosQR && <p className="mt-1 text-sm text-[#374151]">{statusMessage}</p>}

        {/* Quota exceeded */}
        {initState.remainingDonations <= 0 && !isAwaitingPayment && (
          <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
            Bạn đã đạt giới hạn 3 lần quyên góp. Hãy đăng nhập để tiếp tục quyên góp không giới hạn.
          </div>
        )}

        {/* Confirm sub-modal */}
        {isConfirmModalOpen && pendingDonationAmount !== null && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/45 p-4">
            <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl">
              <h3 className="text-lg font-semibold text-[#111827]">Xác nhận quyên góp</h3>
              <p className="mt-3 text-sm text-[#374151]">
                Bạn muốn quyên góp <strong>{pendingDonationAmount.toLocaleString('vi-VN')} token</strong> cho dự án này?
              </p>
              <div className="mt-1 rounded-md border border-amber-100 bg-amber-50 px-3 py-2 text-xs text-amber-700">
                Thanh toán qua QR PayOS. Sau khi thanh toán, hệ thống tự động quyên góp.
              </div>
              <div className="mt-5 flex justify-end gap-2">
                {!isDonating && (
                  <button type="button" onClick={onCloseConfirmModal} className="rounded-md border border-[#d1d5db] px-4 py-2 text-sm text-[#374151]">
                    Hủy
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void onGuestSubmit()}
                  disabled={isDonating}
                  className="rounded-md bg-[#0e7c6b] px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isDonating ? 'Đang xử lý...' : 'Xác nhận'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
