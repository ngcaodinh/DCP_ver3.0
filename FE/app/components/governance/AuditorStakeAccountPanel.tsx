'use client';

import { type FormEvent, type ReactElement, useCallback, useEffect, useRef, useState } from 'react';
import { readAuthSession } from '@/app/utils/authSession';
import { AUDITOR_PAYOUT_SUPPORTED_BANKS, formatDctAmount, normalizeAuditorAccountHolderName } from '@/app/constants/auditorRegistration';
import { AUDITOR_PAYOUT_STATUS_LABEL, AUDITOR_WALLET_LOCK_LABEL, formatAuditorDateTime, formatVndAmount } from '@/app/constants/auditorPortal';
import { executeAuditorStake, requestAuditorUnstake, withdrawAuditorStake } from '@/app/utils/auditorOnboarding';
import { createAuditorPortalDeposit, getAuditorEarnings, getAuditorPortalDepositStatus, getAuditorWalletTokenBalance, updateAuditorPayoutAccount, type AuditorEarnings, type AuditorStakeOverview } from '@/app/utils/auditorPortalApi';

interface AuditorStakeAccountPanelProps {
  isActive: boolean;
  fetchAuditorResource: <T>(pathname: string) => Promise<T | null>;
}

const MINIMUM_AUDITOR_DEPOSIT_AMOUNT = 10_000n;
const MAX_SAFE_AUDITOR_DEPOSIT_AMOUNT = BigInt(Number.MAX_SAFE_INTEGER);
const AUDITOR_STAKE_DEPOSIT_STORAGE_PREFIX = 'auditorStakeDeposit:';
const AUTOMATIC_STAKE_REFRESH_ATTEMPTS = 15;
const AUTOMATIC_STAKE_REFRESH_INTERVAL_MS = 1_000;
const PAYOUT_STATUS_POLL_INTERVAL_MS = 5_000;

type AuditorPayoutHistoryItem = AuditorEarnings['payouts'][number];

/** Xác định payout đã chuyển tiền và đốt DCT thành công để số cọc on-chain có thể được làm mới an toàn. */
function isPayoutFullySettled(status: AuditorPayoutHistoryItem['status']): boolean {
  return status === 'BURNED';
}

/** Xác định PayOS đã chuyển tiền nhưng giao dịch đốt DCT vẫn đang được xác nhận trên blockchain. */
function isPayoutTokenBurnPending(status: AuditorPayoutHistoryItem['status']): boolean {
  return status === 'TRANSFERRED';
}

/** Xác định payout không thể tiếp tục tự động để popup hiển thị hướng xử lý rõ ràng cho Auditor. */
function isPayoutTransferTerminalFailure(status: AuditorPayoutHistoryItem['status']): boolean {
  return status === 'FAILED' || status === 'MANUAL_REVIEW' || status === 'CANCELLED';
}

/** Xác định payout đã có trạng thái cuối để dừng polling và không gây vượt giới hạn API. */
function isPayoutTrackingTerminal(status: AuditorPayoutHistoryItem['status']): boolean {
  return isPayoutFullySettled(status) || isPayoutTransferTerminalFailure(status);
}

/** Chuẩn hóa số tiền người dùng chọn nạp PayOS theo mức nạp tối thiểu. */
function calculateAuditorDepositAmount(requestedAmount: bigint): bigint {
  if (requestedAmount <= 0n) return 0n;
  return requestedAmount < MINIMUM_AUDITOR_DEPOSIT_AMOUNT
    ? MINIMUM_AUDITOR_DEPOSIT_AMOUNT
    : requestedAmount;
}

/** Tạo khóa localStorage theo orderCode để cửa sổ PayOS trả về vẫn biết chính xác số DCT cần cọc. */
function buildAuditorStakeDepositStorageKey(orderCode: string): string {
  return `${AUDITOR_STAKE_DEPOSIT_STORAGE_PREFIX}${orderCode}`;
}

/** Đọc số DCT cần cọc đã lưu trước khi chuyển sang PayOS và chỉ chấp nhận số nguyên dương an toàn. */
function getPendingAuditorStakeAmount(orderCode: string): bigint | null {
  const storedAmount = window.localStorage.getItem(buildAuditorStakeDepositStorageKey(orderCode));
  return storedAmount && /^\d+$/.test(storedAmount) && BigInt(storedAmount) > 0n
    ? BigInt(storedAmount)
    : null;
}

/** Xóa ý định cọc sau khi UserOperation đã được backend chấp nhận để tránh gửi giao dịch trùng khi tải lại trang. */
function clearPendingAuditorStakeAmount(orderCode: string): void {
  window.localStorage.removeItem(buildAuditorStakeDepositStorageKey(orderCode));
}

/** Chỉ mở link thanh toán HTTPS được backend trả về để tránh điều hướng không an toàn. */
function getSafePaymentUrl(value: string): string | null {
  try {
    const paymentUrl = new URL(value);
    return paymentUrl.protocol === 'https:' ? paymentUrl.toString() : null;
  } catch {
    return null;
  }
}

/** Quản lý cọc và tài khoản nhận tiền của Auditor trong một tab có trạng thái khóa ví rõ ràng. */
export default function AuditorStakeAccountPanel({ isActive, fetchAuditorResource }: AuditorStakeAccountPanelProps): ReactElement {
  const [data, setData] = useState<AuditorStakeOverview | null>(null);
  const [message, setMessage] = useState('');
  const [additionalStakeAmount, setAdditionalStakeAmount] = useState('');
  const [unstakeAmount, setUnstakeAmount] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isCheckingFullExit, setIsCheckingFullExit] = useState(false);
  const [bankName, setBankName] = useState('');
  const [bankAccountNumber, setBankAccountNumber] = useState('');
  const [accountHolderName, setAccountHolderName] = useState('');
  const [branchName, setBranchName] = useState('');
  const [isEditingPayoutAccount, setIsEditingPayoutAccount] = useState(false);
  const [walletTokenBalance, setWalletTokenBalance] = useState<string | null>(null);
  const [depositOrderCode, setDepositOrderCode] = useState('');
  const [depositPaymentUrl, setDepositPaymentUrl] = useState('');
  const [depositExpiresAt, setDepositExpiresAt] = useState('');
  const [isDepositProcessing, setIsDepositProcessing] = useState(false);
  const [pendingStakeOverviewRefreshes, setPendingStakeOverviewRefreshes] = useState(0);
  const [trackedPayoutId, setTrackedPayoutId] = useState<string | null>(null);
  const [trackedPayout, setTrackedPayout] = useState<AuditorPayoutHistoryItem | null>(null);
  const handledPaymentReturnOrderCodeRef = useRef<string | null>(null);
  const refreshedSettledPayoutIdRef = useRef<string | null>(null);

  const loadOverview = useCallback(async (withExitEligibility = false): Promise<void> => {
    if (withExitEligibility) setIsCheckingFullExit(true);
    try {
      const pathname = withExitEligibility
        ? '/api/auditor-onboarding/stake-overview?withExitEligibility=1'
        : '/api/auditor-onboarding/stake-overview';
      const overview = await fetchAuditorResource<AuditorStakeOverview>(pathname);
      if (overview) setData(overview);
    } catch {
      setMessage('Không đọc được thông tin cọc. Vui lòng thử lại.');
    } finally {
      if (withExitEligibility) setIsCheckingFullExit(false);
    }
  }, [fetchAuditorResource]);

  useEffect(() => {
    if (isActive && !data) void loadOverview();
  }, [data, isActive, loadOverview]);

  /** Đọc lại số cọc on-chain sau khi UserOperation được gửi để giao diện tự đồng bộ khi transaction được xác nhận. */
  useEffect(() => {
    if (!isActive || pendingStakeOverviewRefreshes <= 0) return;

    const timeoutId = window.setTimeout(() => {
      void loadOverview().finally(() => {
        setPendingStakeOverviewRefreshes(currentAttemptCount => currentAttemptCount - 1);
      });
    }, AUTOMATIC_STAKE_REFRESH_INTERVAL_MS);
    return () => window.clearTimeout(timeoutId);
  }, [isActive, loadOverview, pendingStakeOverviewRefreshes]);

  /** Theo dõi payout đã khởi tạo cho đến khi PayOS hoàn tất hoặc trả về trạng thái cần can thiệp. */
  useEffect(() => {
    if (!trackedPayoutId) return;
    let isDisposed = false;
    let intervalId: number | undefined;

    const refreshTrackedPayout = async (): Promise<void> => {
      const accessToken = readAuthSession().accessToken;
      if (!accessToken) return;
      try {
        const earnings = await getAuditorEarnings(accessToken);
        const payout = earnings.payouts.find(item => item.payoutId === trackedPayoutId) ?? null;
        if (!isDisposed && payout) {
          setTrackedPayout(payout);
          if (isPayoutFullySettled(payout.status) && refreshedSettledPayoutIdRef.current !== payout.payoutId) {
            refreshedSettledPayoutIdRef.current = payout.payoutId;
            // Chỉ làm mới sau BURNED để UI không hiển thị số cọc mới trước khi token được trừ trên chain.
            setPendingStakeOverviewRefreshes(AUTOMATIC_STAKE_REFRESH_ATTEMPTS);
            await loadOverview();
          }
          if (isPayoutTrackingTerminal(payout.status) && intervalId !== undefined) {
            window.clearInterval(intervalId);
          }
        }
      } catch {
        // Không đóng popup khi lỗi mạng tạm thời để người dùng không hiểu nhầm tiền đã ngừng được xử lý.
      }
    };

    void refreshTrackedPayout();
    intervalId = window.setInterval(() => void refreshTrackedPayout(), PAYOUT_STATUS_POLL_INTERVAL_MS);
    return () => {
      isDisposed = true;
      if (intervalId !== undefined) window.clearInterval(intervalId);
    };
  }, [loadOverview, trackedPayoutId]);

  const loadWalletTokenBalance = useCallback(async (): Promise<void> => {
    const accessToken = readAuthSession().accessToken;
    if (!accessToken) return;
    try {
      const tokenBalance = await getAuditorWalletTokenBalance(accessToken);
      if (/^\d+$/.test(tokenBalance)) setWalletTokenBalance(tokenBalance);
      else setMessage('Không đọc được số dư VND trong Smart Account. Vui lòng thử lại.');
    } catch (error) {
      setMessage((error as { message?: string }).message || 'Không đọc được số dư VND trong Smart Account. Vui lòng thử lại.');
    }
  }, []);

  useEffect(() => {
    if (isActive && data?.onchain) void loadWalletTokenBalance();
  }, [data?.onchain, isActive, loadWalletTokenBalance]);

  const createStakeTopUpDeposit = useCallback(async (): Promise<void> => {
    const accessToken = readAuthSession().accessToken;
    if (!accessToken || !walletTokenBalance) return;
    const requestedAmount = /^\d+$/.test(additionalStakeAmount) ? BigInt(additionalStakeAmount) : 0n;
    const availableBalance = BigInt(walletTokenBalance);
    if (requestedAmount <= 0n || requestedAmount <= availableBalance) {
      setMessage('Nhập số VND muốn đặt cọc thêm lớn hơn số dư hiện có trong Smart Account.');
      return;
    }
    const depositAmount = calculateAuditorDepositAmount(requestedAmount);
    if (depositAmount > MAX_SAFE_AUDITOR_DEPOSIT_AMOUNT) {
      setMessage('Số VND cần nạp vượt giới hạn thanh toán. Vui lòng liên hệ hỗ trợ.');
      return;
    }

    setIsDepositProcessing(true);
    try {
      const result = await createAuditorPortalDeposit(accessToken, Number(depositAmount));
      const paymentUrl = getSafePaymentUrl(result.paymentUrl);
      if (!paymentUrl || result.status !== 'PENDING_PAYMENT' || !/^\d{1,20}$/.test(result.orderCode)) {
        setMessage('Phiếu nạp trả về không hợp lệ. Vui lòng tạo phiếu mới.');
        return;
      }
      window.localStorage.setItem(buildAuditorStakeDepositStorageKey(result.orderCode), requestedAmount.toString());
      setDepositOrderCode(result.orderCode);
      setDepositPaymentUrl(paymentUrl);
      setMessage('Đã tạo phiếu nạp VND. Hoàn tất thanh toán rồi quay lại kiểm tra trạng thái.');
      window.open(paymentUrl, '_blank', 'noopener,noreferrer');
    } catch (error) {
      setMessage((error as { message?: string }).message || 'Không thể tạo phiếu nạp VND. Vui lòng thử lại.');
    } finally {
      setIsDepositProcessing(false);
    }
  }, [additionalStakeAmount, walletTokenBalance]);

  const checkStakeTopUpDeposit = useCallback(async (orderCode = depositOrderCode): Promise<void> => {
    const accessToken = readAuthSession().accessToken;
    if (!accessToken || !/^\d{1,20}$/.test(orderCode)) return;
    setIsDepositProcessing(true);
    try {
      const result = await getAuditorPortalDepositStatus(accessToken, orderCode);
      if (result.status === 'PENDING_PAYMENT') {
        const paymentUrl = result.paymentUrl ? getSafePaymentUrl(result.paymentUrl) : null;
        if (paymentUrl) setDepositPaymentUrl(paymentUrl);
        if (result.paymentExpiredAt) setDepositExpiresAt(result.paymentExpiredAt);
        setMessage('Chưa nhận được thanh toán. Nếu bạn vừa chuyển khoản, hãy đợi khoảng 1 phút rồi kiểm tra lại.');
        return;
      }
      if (result.status === 'PAYMENT_CONFIRMED') {
        setMessage('Đã nhận thanh toán, đang phát VND vào Smart Account. Vui lòng kiểm tra lại sau khoảng 1 phút.');
        return;
      }
      if (result.status === 'MINT_COMPLETED') {
        setDepositOrderCode('');
        setDepositPaymentUrl('');
        setDepositExpiresAt('');
        const pendingStakeAmount = getPendingAuditorStakeAmount(orderCode);
        await loadWalletTokenBalance();

        if (pendingStakeAmount && !data?.guard.walletLock) {
          // Chỉ gửi stake sau khi API deposit xác nhận mint hoàn tất để contract đọc được số dư mới nhất.
          const isStakeSubmitted = await submitStake(pendingStakeAmount);
          if (isStakeSubmitted) {
            clearPendingAuditorStakeAmount(orderCode);
            setPendingStakeOverviewRefreshes(AUTOMATIC_STAKE_REFRESH_ATTEMPTS);
            setMessage('VND đã được nạp và giao dịch cọc đã gửi. Số tiền đang cọc sẽ tự cập nhật sau khi blockchain xác nhận.');
          }
          return;
        }

        await loadOverview();
        setMessage(data?.guard.walletLock
          ? 'VND đã được nạp vào Smart Account nhưng ví đang bị khóa nên chưa thể cọc tự động.'
          : 'VND đã được nạp vào Smart Account. Bạn có thể gửi giao dịch đặt cọc thêm.');
        return;
      }
      setDepositOrderCode('');
      setDepositPaymentUrl('');
      setDepositExpiresAt('');
      setMessage(result.isPaymentConfirmedButMintFailed
        ? 'Thanh toán đã được xác nhận nhưng chưa thể phát VND. Vui lòng liên hệ hỗ trợ và không tạo phiếu mới.'
        : `${result.failureReason || 'Phiếu nạp không thành công.'} Vui lòng tạo phiếu mới.`);
    } catch (error) {
      setMessage((error as { message?: string }).message || 'Không thể kiểm tra phiếu nạp VND. Vui lòng thử lại.');
    } finally {
      setIsDepositProcessing(false);
    }
  }, [data?.guard.walletLock, depositOrderCode, loadOverview, loadWalletTokenBalance]);

  useEffect(() => {
    if (!isActive || !data) return;
    const searchParams = new URLSearchParams(window.location.search);
    const orderCode = searchParams.get('orderCode') || '';
    if (searchParams.get('paymentFlow') !== 'auditor_portal' || !/^\d{1,20}$/.test(orderCode) || handledPaymentReturnOrderCodeRef.current === orderCode) return;
    handledPaymentReturnOrderCodeRef.current = orderCode;
    setDepositOrderCode(orderCode);
    void checkStakeTopUpDeposit(orderCode);
  }, [checkStakeTopUpDeposit, data, isActive]);

  /** Gửi UserOperation cọc DCT và trả kết quả để callback PayOS biết khi nào được dọn ý định cọc đã lưu. */
  async function submitStake(requestedAmount: bigint): Promise<boolean> {
    const accessToken = readAuthSession().accessToken;
    if (!accessToken || requestedAmount <= 0n) {
      setMessage('Nhập số VND muốn đặt cọc thêm.');
      return false;
    }
    setIsSubmitting(true);
    try {
      await executeAuditorStake(accessToken, requestedAmount.toString());
      setAdditionalStakeAmount('');
      setMessage('Giao dịch đặt cọc đang được xác minh.');
      await loadOverview();
      return true;
    } catch (error) {
      const apiError = error as { errorCode?: string; message?: string };
      setMessage(apiError.errorCode === 'INSUFFICIENT_TOKEN_BALANCE'
        ? 'Số dư token cọc không đủ. Hãy nạp thêm VND rồi thử lại.'
        : apiError.message || 'Không thể đặt cọc thêm.');
      return false;
    } finally {
      setIsSubmitting(false);
    }
  }

  function handleUnstakeAmountChange(rawValue: string): void {
    const nextAmount = rawValue.replace(/\D/g, '');
    setUnstakeAmount(nextAmount);
    if (data?.onchain && nextAmount && BigInt(nextAmount) === BigInt(data.onchain.stakedBalance)) {
      void loadOverview(true);
    }
  }

  async function submitUnstake(): Promise<void> {
    const accessToken = readAuthSession().accessToken;
    const amount = /^\d+$/.test(unstakeAmount) ? BigInt(unstakeAmount) : 0n;
    if (!accessToken || amount <= 0n || !onchain || amount > stakedBalance || isWalletLocked) {
      setMessage('Nhập số VND muốn rút và kiểm tra khoản cọc hiện tại.');
      return;
    }
    setIsSubmitting(true);
    try {
      await requestAuditorUnstake(accessToken, amount.toString());
      setUnstakeAmount('');
      setMessage('Đã gửi yêu cầu nhận lại cọc. Khoản cọc sẽ mở khóa theo lịch blockchain.');
      await loadOverview();
    } catch (error) {
      setMessage((error as { message?: string }).message || 'Không thể gửi yêu cầu nhận lại cọc.');
    } finally {
      setIsSubmitting(false);
    }
  }

  /** Rút khoản cọc đã mở khóa, tạo payout PayOS và mở popup theo dõi cho đúng payout vừa tạo. */
  async function submitWithdraw(): Promise<void> {
    const accessToken = readAuthSession().accessToken;
    if (!accessToken || isWalletLocked) {
      setMessage('Thao tác rút cọc đang bị khóa.');
      return;
    }
    setIsSubmitting(true);
    try {
      const result = await withdrawAuditorStake(accessToken);
      setTrackedPayout(null);
      refreshedSettledPayoutIdRef.current = null;
      setTrackedPayoutId(result.payoutId);
      setMessage('Đã tạo lệnh rút tiền. Hệ thống đang xác nhận giao dịch và chuyển tiền qua PayOS.');
      await loadOverview();
    } catch (error) {
      setMessage((error as { message?: string }).message || 'Không thể nhận lại khoản cọc đã đến hạn.');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function submitPayoutAccount(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const accessToken = readAuthSession().accessToken;
    if (!accessToken || !/^\d{8,20}$/.test(bankAccountNumber) || !/^[A-Z\s]+$/.test(accountHolderName)) {
      setMessage('Thông tin tài khoản ngân hàng không hợp lệ.');
      return;
    }
    setIsSubmitting(true);
    try {
      await updateAuditorPayoutAccount(accessToken, { bankName, bankAccountNumber, accountHolderName, branchName: branchName.trim() || undefined });
      setBankAccountNumber('');
      setIsEditingPayoutAccount(false);
      setMessage('Đã cập nhật tài khoản nhận tiền.');
      await loadOverview();
    } catch (error) {
      setMessage((error as { message?: string }).message || 'Không thể cập nhật tài khoản nhận tiền.');
    } finally {
      setIsSubmitting(false);
    }
  }

  function startPayoutAccountEdit(): void {
    if (!data?.payoutAccount) return;
    setBankName(data.payoutAccount.bankName);
    setAccountHolderName(data.payoutAccount.accountHolderName);
    setBranchName(data.payoutAccount.branchName || '');
    setBankAccountNumber('');
    setIsEditingPayoutAccount(true);
  }

  const onchain = data?.onchain;
  const isWalletLocked = Boolean(data?.guard.walletLock);
  const stakedBalance = onchain ? BigInt(onchain.stakedBalance) : 0n;
  const minimumStakeThreshold = onchain ? BigInt(onchain.minimumStakeThreshold) : 0n;
  const stakeShortfall = minimumStakeThreshold > stakedBalance ? minimumStakeThreshold - stakedBalance : 0n;
  const parsedWalletTokenBalance = walletTokenBalance && /^\d+$/.test(walletTokenBalance) ? BigInt(walletTokenBalance) : null;
  const parsedAdditionalStakeAmount = /^\d+$/.test(additionalStakeAmount) ? BigInt(additionalStakeAmount) : null;
  const depositAmount = parsedAdditionalStakeAmount !== null && parsedWalletTokenBalance !== null && parsedAdditionalStakeAmount > parsedWalletTokenBalance
    ? calculateAuditorDepositAmount(parsedAdditionalStakeAmount)
    : 0n;
  const canCreateDeposit = parsedAdditionalStakeAmount !== null && parsedAdditionalStakeAmount > 0n && depositAmount > 0n && depositAmount <= MAX_SAFE_AUDITOR_DEPOSIT_AMOUNT;
  const canSubmitStakeTopUp = parsedAdditionalStakeAmount !== null && parsedAdditionalStakeAmount > 0n && parsedWalletTokenBalance !== null && parsedWalletTokenBalance >= parsedAdditionalStakeAmount;
  const parsedUnstakeAmount = /^\d+$/.test(unstakeAmount) ? BigInt(unstakeAmount) : null;
  const remainingAfterUnstake = parsedUnstakeAmount !== null && parsedUnstakeAmount <= stakedBalance ? stakedBalance - parsedUnstakeAmount : null;
  const isFullExitAmount = parsedUnstakeAmount !== null && parsedUnstakeAmount === stakedBalance && stakedBalance > 0n;
  const isPartialBelowFloor = parsedUnstakeAmount !== null && parsedUnstakeAmount > 0n && remainingAfterUnstake !== null && remainingAfterUnstake > 0n && remainingAfterUnstake < minimumStakeThreshold;
  const exitEligibility = data?.exitEligibility;
  const canSubmitUnstake = Boolean(onchain && !isWalletLocked && parsedUnstakeAmount !== null && parsedUnstakeAmount > 0n && parsedUnstakeAmount <= stakedBalance && !isPartialBelowFloor && (!isFullExitAmount || (exitEligibility?.eligible === true && !isCheckingFullExit)));
  const maxPartialWithdrawable = stakedBalance > minimumStakeThreshold ? stakedBalance - minimumStakeThreshold : 0n;
  const releaseAt = onchain?.unbondingReleaseAt ? new Date(onchain.unbondingReleaseAt) : null;
  const canWithdraw = Boolean(onchain && !isWalletLocked && BigInt(onchain.pendingWithdrawAmount) > 0n && releaseAt && releaseAt.getTime() <= Date.now());
  const payoutNeedsSupport = data?.guard.walletLock === 'PAYOUT_IN_FLIGHT' && data.guard.lockedAt && Date.now() - new Date(data.guard.lockedAt).getTime() > 86_400_000;

  if (!data) return <section id="auditor-stake-panel" role="tabpanel" aria-labelledby="auditor-stake-tab" className="min-w-0 rounded-3xl border border-emerald-900/10 bg-white p-5 sm:p-7">Đang tải thông tin cọc…</section>;

  const summaryBoxes: Array<[string, string]> = onchain
    ? [['Số tiền đang cọc', `${formatDctAmount(onchain.stakedBalance)} VNĐ`], ['Mức cọc tối thiểu', `${formatDctAmount(onchain.minimumStakeThreshold)} VNĐ`], ['Số tiền chờ nhận lại', `${formatDctAmount(onchain.pendingWithdrawAmount)} VNĐ`], ['Thời điểm mở khóa', releaseAt ? formatAuditorDateTime(releaseAt) : 'Chưa có lịch mở khóa']]
    : [['Số tiền đang cọc', 'Không đọc được từ hệ thống'], ['Mức cọc tối thiểu', 'Không đọc được từ hệ thống'], ['Số tiền chờ nhận lại', 'Không đọc được từ hệ thống'], ['Thời điểm mở khóa', 'Không đọc được từ hệ thống']];

  return (
    <section id="auditor-stake-panel" role="tabpanel" aria-labelledby="auditor-stake-tab" className="min-w-0 rounded-3xl border border-emerald-900/10 bg-white p-4 shadow-[0_12px_36px_rgba(15,23,42,0.06)] sm:p-7">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-emerald-700">Quản lý tài chính</p>
          <h2 className="mt-1 text-2xl font-bold text-slate-950">Cọc &amp; Tài khoản nhận tiền</h2>
        </div>
        <button type="button" onClick={() => { void loadOverview(); if (onchain) void loadWalletTokenBalance(); }} disabled={isSubmitting || isDepositProcessing} className="min-h-10 rounded-xl border border-slate-200 px-3 text-sm font-semibold text-slate-600 transition hover:border-emerald-300 hover:text-emerald-700 disabled:opacity-50">Làm mới</button>
      </header>

      <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {summaryBoxes.map(([label, value]) => <div key={label} className="rounded-2xl border border-slate-100 bg-slate-50 p-4"><p className="text-xs font-semibold text-slate-500">{label}</p><p className="mt-1 text-sm font-bold text-slate-900">{value}</p></div>)}
      </div>

      {stakeShortfall > 0n && <p className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">Khoản cọc còn thiếu {formatDctAmount(stakeShortfall.toString())} VNĐ để đạt mức tối thiểu.</p>}

      <div className="mt-5 rounded-2xl border border-slate-200 bg-white p-4 text-sm shadow-sm">
        {data.guard.walletLock ? <><p className="font-semibold text-slate-800">{AUDITOR_WALLET_LOCK_LABEL[data.guard.walletLock]}</p><p className="mt-1 text-slate-600">Các thao tác ghi cọc và tài khoản nhận tiền đang tạm khóa{data.guard.lockedAt ? ` từ ${new Date(data.guard.lockedAt).toLocaleString('vi-VN')}` : ''}.</p>{payoutNeedsSupport && <p className="mt-2 text-amber-800">Payout đã khóa quá 24 giờ. Vui lòng liên hệ bộ phận hỗ trợ.</p>}</> : <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-slate-600"><p>Tài khoản: <span className="font-semibold text-slate-900">{data.accountStatus === 'ACTIVE' ? 'Đang hoạt động' : data.accountStatus || 'Chưa có trạng thái'}</span></p><p>Ví sẵn sàng</p><p>Nợ phạt: <span className="font-semibold text-slate-900">{formatVndAmount(data.guard.penaltyDebtVnd)}</span></p><p>Vụ việc mở: <span className="font-semibold text-slate-900">{data.guard.openCaseCount}</span></p></div>}
      </div>

      {message && <p role="status" className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">{message}</p>}

      {trackedPayoutId && <div role="dialog" aria-modal="true" aria-labelledby="auditor-payout-dialog-title" className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 p-4">
        <section className="w-full max-w-md rounded-2xl bg-white p-5 shadow-2xl" aria-live="polite">
          <p className="text-xs font-bold uppercase tracking-[0.14em] text-emerald-700">PayOS payout</p>
          <h3 id="auditor-payout-dialog-title" className="mt-1 text-xl font-bold text-slate-950">
            {trackedPayout && isPayoutFullySettled(trackedPayout.status) ? 'Chuyển tiền thành công' : trackedPayout && isPayoutTokenBurnPending(trackedPayout.status) ? 'Đang cập nhật số dư' : trackedPayout && isPayoutTransferTerminalFailure(trackedPayout.status) ? 'Chuyển tiền cần xử lý thêm' : 'Đang thực hiện chuyển tiền'}
          </h3>
          <p className="mt-2 text-sm text-slate-600">
            {trackedPayout && isPayoutFullySettled(trackedPayout.status)
              ? 'PayOS đã chuyển tiền, token đã được trừ khỏi ví và số tiền đang cọc đã được cập nhật.'
              : trackedPayout && isPayoutTokenBurnPending(trackedPayout.status)
                ? 'PayOS đã chuyển tiền. Hệ thống đang xác nhận giao dịch trừ token trên blockchain trước khi hoàn tất.'
              : trackedPayout && isPayoutTransferTerminalFailure(trackedPayout.status)
                ? trackedPayout.errorMessage || 'Giao dịch chưa thể hoàn tất tự động. Vui lòng kiểm tra lại sau.'
                : 'Hệ thống đang xác nhận khoản rút trên blockchain và gửi lệnh chuyển tiền qua PayOS. Vui lòng không tạo thêm yêu cầu rút.'}
          </p>
          <div className="mt-4 rounded-xl bg-slate-50 p-3 text-sm text-slate-700">
            <p>Mã payout: <code className="font-mono text-xs">{trackedPayoutId}</code></p>
            {trackedPayout && <>
              <p className="mt-2">Trạng thái: <strong>{AUDITOR_PAYOUT_STATUS_LABEL[trackedPayout.status]}</strong></p>
              <p className="mt-1">Số tiền chuyển: <strong>{formatVndAmount(trackedPayout.netAmountVnd)}</strong></p>
              <p className="mt-1">Ngân hàng nhận: {trackedPayout.bankSnapshot.bankName} · {trackedPayout.bankSnapshot.bankAccountNumberMasked}</p>
            </>}
          </div>
          {(trackedPayout && (isPayoutFullySettled(trackedPayout.status) || isPayoutTransferTerminalFailure(trackedPayout.status))) && <button type="button" onClick={() => { setTrackedPayoutId(null); setTrackedPayout(null); }} className="mt-5 min-h-11 w-full rounded-xl bg-emerald-700 px-4 text-sm font-bold text-white transition hover:bg-emerald-800">Đóng</button>}
        </section>
      </div>}

      {onchain && <div className="mt-6 grid gap-5 lg:grid-cols-[minmax(0,1.2fr)_minmax(280px,0.8fr)]">
        <section aria-label="Đặt cọc thêm" className="rounded-2xl border border-emerald-100 bg-emerald-50/50 p-4 sm:p-5">
          <div className="flex items-start justify-between gap-3"><div><h3 className="text-lg font-bold text-slate-950">Đặt cọc thêm</h3><p className="mt-1 text-sm text-slate-600">Cộng thêm token vào khoản cọc hiện tại.</p></div><span className="rounded-full bg-white px-2.5 py-1 text-xs font-bold text-emerald-700">Cộng thêm sau 3.000.000 VNĐ</span></div>
          <label htmlFor="auditor-additional-stake-amount" className="mt-4 block text-sm font-bold text-slate-800">Số tiền muốn cọc thêm <span className="font-normal text-slate-500">(VNĐ)</span></label>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row"><input id="auditor-additional-stake-amount" inputMode="numeric" pattern="[0-9]*" value={additionalStakeAmount} onChange={event => setAdditionalStakeAmount(event.target.value.replace(/\D/g, ''))} placeholder="Ví dụ: 500.000" className="min-h-11 min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 text-base outline-none transition focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100 sm:text-sm" />{canSubmitStakeTopUp && parsedAdditionalStakeAmount !== null && <button type="button" disabled={isWalletLocked || isSubmitting || isDepositProcessing} onClick={() => void submitStake(parsedAdditionalStakeAmount)} className="min-h-11 rounded-xl bg-emerald-700 px-4 text-sm font-bold text-white transition hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-50">Đặt cọc thêm {formatDctAmount(parsedAdditionalStakeAmount.toString())} VNĐ</button>}</div>
          <p className="mt-2 text-xs text-slate-500">Có thể cọc thêm dù đã đạt mức tối thiểu. Số tiền nạp tối thiểu là 10.000 VNĐ.</p>
          {parsedAdditionalStakeAmount !== null && parsedAdditionalStakeAmount > 0n && parsedWalletTokenBalance !== null && !canSubmitStakeTopUp && <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-white px-3 py-3"><p className="text-sm text-slate-700">Cần nạp thêm <strong>{formatDctAmount(depositAmount.toString())} VNĐ</strong></p>{canCreateDeposit ? <button type="button" disabled={isWalletLocked || isDepositProcessing} onClick={() => void createStakeTopUpDeposit()} className="min-h-10 rounded-lg bg-amber-500 px-3 text-sm font-bold text-slate-950 transition hover:bg-amber-600 disabled:opacity-50">Nạp {formatDctAmount(depositAmount.toString())} VNĐ</button> : <p className="text-xs font-semibold text-red-700">Vượt giới hạn thanh toán</p>}</div>}
          {depositOrderCode && <div className="mt-3 rounded-xl border border-sky-200 bg-sky-50 p-3 text-sm text-sky-950"><div className="flex flex-wrap items-center justify-between gap-2"><p className="font-bold">Đang chờ thanh toán</p><code className="font-mono text-xs font-semibold">#{depositOrderCode}</code></div>{depositExpiresAt && <p className="mt-1 text-xs">Hết hạn lúc: {new Date(depositExpiresAt).toLocaleString('vi-VN')}</p>}<div className="mt-2 flex flex-wrap gap-3 text-sm font-bold"><a href={depositPaymentUrl} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">Mở lại trang thanh toán</a><button type="button" disabled={isDepositProcessing} onClick={() => void checkStakeTopUpDeposit()} className="underline underline-offset-2 disabled:opacity-50">Kiểm tra thanh toán</button></div></div>}
        </section>

        <section aria-label="Rút cọc" className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5">
          <div><h3 className="text-lg font-bold text-slate-950">Rút tiền về tài khoản</h3><p className="mt-1 text-sm text-slate-600">Khoản rút được mở khóa trên blockchain trước khi PayOS tự động chuyển về ngân hàng.</p></div>
          <label htmlFor="auditor-unstake-amount" className="mt-4 block text-sm font-bold text-slate-800">Số tiền muốn rút <span className="font-normal text-slate-500">(VNĐ)</span></label>
          <input id="auditor-unstake-amount" inputMode="numeric" pattern="[0-9]*" value={unstakeAmount} onChange={event => handleUnstakeAmountChange(event.target.value)} placeholder="Ví dụ: 500.000" className="mt-2 min-h-11 w-full rounded-xl border border-slate-200 px-3 text-base outline-none transition focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100 sm:text-sm" />
          <div className="mt-2 flex flex-wrap gap-2"><button type="button" disabled={isWalletLocked || maxPartialWithdrawable <= 0n} onClick={() => setUnstakeAmount(maxPartialWithdrawable.toString())} className="min-h-9 rounded-lg border border-slate-200 px-2.5 text-xs font-semibold text-slate-600 disabled:opacity-50">Rút tối đa, giữ mức tối thiểu</button><button type="button" disabled={isWalletLocked || stakedBalance <= 0n} onClick={() => handleUnstakeAmountChange(stakedBalance.toString())} className="min-h-9 rounded-lg border border-slate-200 px-2.5 text-xs font-semibold text-slate-600 disabled:opacity-50">Rút toàn bộ</button></div>
          <div className="mt-3 min-h-10 text-xs text-slate-500">{parsedUnstakeAmount !== null && parsedUnstakeAmount > stakedBalance ? <p className="text-red-700">Số tiền rút vượt quá số cọc hiện có.</p> : isPartialBelowFloor ? <p className="text-red-700">Khoản cọc còn lại phải bằng 0 hoặc từ {formatDctAmount(minimumStakeThreshold.toString())} VNĐ.</p> : isFullExitAmount && isCheckingFullExit ? <p>Đang kiểm tra điều kiện rút toàn bộ…</p> : isFullExitAmount && exitEligibility && !exitEligibility.eligible ? <p className="text-red-700">Chưa đủ điều kiện rút toàn bộ khoản cọc.</p> : <p>Rút toàn bộ sẽ kết thúc vai trò Kiểm toán viên.</p>}</div>
          <button type="button" disabled={!canSubmitUnstake || isSubmitting || isCheckingFullExit} onClick={() => void submitUnstake()} className="mt-2 min-h-11 w-full rounded-xl bg-slate-900 px-4 text-sm font-bold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-45">Yêu cầu rút tiền</button>
          <button type="button" disabled={!canWithdraw || isSubmitting} onClick={() => void submitWithdraw()} className="mt-2 min-h-11 w-full rounded-xl border border-emerald-300 px-4 text-sm font-bold text-emerald-800 transition hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-45">Rút tiền ngay về ngân hàng</button>
          {onchain.pendingWithdrawAmount !== '0' && <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">Đang chờ nhận lại: {formatDctAmount(onchain.pendingWithdrawAmount)} VNĐ{releaseAt ? ` · ${canWithdraw ? 'Đã đến hạn' : `mở khóa ${formatAuditorDateTime(releaseAt)}`}` : ''}</p>}
        </section>
      </div>}

      <form onSubmit={event => void submitPayoutAccount(event)} className="mt-7 min-w-0 border-t border-slate-100 pt-6">
        <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="text-lg font-bold text-slate-950">Tài khoản nhận tiền</h3><p className="mt-1 text-sm text-slate-600">Tiền thưởng và tiền rút cọc sẽ được chuyển vào tài khoản này.</p></div>{data.payoutAccount && !isEditingPayoutAccount && <button type="button" onClick={startPayoutAccountEdit} className="min-h-10 rounded-xl border border-emerald-300 px-3 text-sm font-bold text-emerald-800">Cập nhật</button>}</div>
        <div className="mt-3 break-words rounded-xl bg-slate-50 p-3 text-sm text-slate-700">{data.payoutAccount ? <><span className="font-semibold">Tài khoản đang dùng: </span>{data.payoutAccount.bankName} · {data.payoutAccount.bankAccountNumberMasked}<br /><span className="font-semibold">Tên chủ tài khoản: </span>{data.payoutAccount.accountHolderName}{data.payoutAccount.branchName ? ` · Chi nhánh: ${data.payoutAccount.branchName}` : ''}</> : 'Bạn chưa đăng ký tài khoản nhận tiền.'}</div>
        {(!data.payoutAccount || isEditingPayoutAccount) && <><p className="mt-3 text-sm text-slate-600">Chọn ngân hàng và nhập đầy đủ thông tin tài khoản mới.</p><div className="mt-4 grid gap-3 sm:grid-cols-2"><select value={bankName} onChange={event => setBankName(event.target.value)} required className="min-h-11 min-w-0 rounded-xl border px-3 text-base sm:text-sm"><option value="">Chọn ngân hàng nhận tiền</option>{AUDITOR_PAYOUT_SUPPORTED_BANKS.map(bank => <option key={bank.value} value={bank.value}>{bank.label}</option>)}</select><input value={bankAccountNumber} onChange={event => setBankAccountNumber(event.target.value.replace(/\D/g, ''))} placeholder="Nhập đầy đủ số tài khoản mới" required className="min-h-11 min-w-0 rounded-xl border px-3 text-base sm:text-sm" /><input value={accountHolderName} onChange={event => setAccountHolderName(normalizeAuditorAccountHolderName(event.target.value))} placeholder="Tên chủ tài khoản (không dấu)" required className="min-h-11 min-w-0 rounded-xl border px-3 text-base sm:text-sm" /><input value={branchName} onChange={event => setBranchName(event.target.value)} placeholder="Chi nhánh (không bắt buộc)" className="min-h-11 min-w-0 rounded-xl border px-3 text-base sm:text-sm" /></div><div className="mt-4 flex flex-wrap gap-2"><button type="submit" disabled={isSubmitting || isWalletLocked} className="min-h-11 rounded-xl bg-emerald-700 px-4 py-2 text-sm font-bold text-white disabled:opacity-50">Lưu tài khoản nhận tiền</button>{data.payoutAccount && <button type="button" onClick={() => setIsEditingPayoutAccount(false)} className="min-h-11 rounded-xl border border-slate-300 px-4 py-2 text-sm font-bold text-slate-700">Hủy cập nhật</button>}</div></>}
      </form>
    </section>
  );
}
