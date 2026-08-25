'use client';

import { type FormEvent, type ReactElement, useEffect, useState } from 'react';
import {
  executeAuditorStake,
  getAuditorOnboardingStatus,
  registerAuditorIntent,
  requestAuditorUnstake,
  withdrawAuditorStake,
  type AuditorOnboardingStatus
} from '@/app/utils/auditorOnboarding';
import { persistAuthSession, readAuthSession } from '@/app/utils/authSession';
import type { ApiErrorResponse } from '@/app/utils/apiClient';

interface GoogleIdentityClient {
  initialize: (options: { client_id: string; callback: (response: { credential?: string }) => void }) => void;
  renderButton: (container: HTMLElement, options: Record<string, string>) => void;
}

const GOOGLE_IDENTITY_SCRIPT_URL = 'https://accounts.google.com/gsi/client';
const AUDITOR_INTENT_STORAGE_KEY = 'dcpAuditorOnboardingIntentId';

/** Chuyển lỗi API không tin cậy thành thông báo ngắn, không lộ chi tiết hệ thống cho người dùng. */
function getErrorMessage(error: unknown, fallbackMessage: string): string {
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as ApiErrorResponse).message;
    if (typeof message === 'string' && message.trim()) return message;
  }
  return fallbackMessage;
}

/** Đọc Google Identity từ window cục bộ để không xung đột khai báo global của các màn hình đăng nhập sẵn có. */
function getGoogleIdentityClient(): GoogleIdentityClient | undefined {
  return (window as Window & { google?: { accounts?: { id?: GoogleIdentityClient } } }).google?.accounts?.id;
}

/** Hiển thị luồng self-onboarding Auditor: xác thực Google, đặt cọc và các thao tác stake sau kích hoạt. */
export default function AuditorOnboardingClient(): ReactElement {
  const [accessToken, setAccessToken] = useState('');
  const [googleCredential, setGoogleCredential] = useState('');
  const [intentId, setIntentId] = useState('');
  const [intentStatus, setIntentStatus] = useState<AuditorOnboardingStatus | null>(null);
  const [bankName, setBankName] = useState('');
  const [bankAccountNumber, setBankAccountNumber] = useState('');
  const [accountHolderName, setAccountHolderName] = useState('');
  const [branchName, setBranchName] = useState('');
  const [unstakeAmount, setUnstakeAmount] = useState('');
  const [notice, setNotice] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    setAccessToken(readAuthSession().accessToken || '');
    setIntentId(window.localStorage.getItem(AUDITOR_INTENT_STORAGE_KEY) || '');

    const googleClientId = (process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || '').trim();
    if (!googleClientId) {
      setNotice('Thiếu cấu hình Google Client ID; chưa thể tạo hồ sơ Kiểm toán viên.');
      return;
    }

    const script = document.createElement('script');
    script.src = GOOGLE_IDENTITY_SCRIPT_URL;
    script.async = true;
    script.onload = () => {
      const googleIdentity = getGoogleIdentityClient();
      const container = document.getElementById('auditor-google-identity-button');
      if (!googleIdentity || !container) {
        setNotice('Không thể khởi tạo Google Identity. Vui lòng tải lại trang.');
        return;
      }
      googleIdentity.initialize({
        client_id: googleClientId,
        callback: response => {
          if (!response.credential) {
            setNotice('Google không trả về thông tin xác thực. Vui lòng thử lại.');
            return;
          }
          setGoogleCredential(response.credential);
          setNotice('Đã xác thực Google. Hoàn tất thông tin tài khoản để tạo hồ sơ.');
        }
      });
      googleIdentity.renderButton(container, {
        type: 'standard',
        theme: 'outline',
        text: 'continue_with',
        width: '320'
      });
    };
    script.onerror = () => setNotice('Không thể tải Google Identity. Vui lòng kiểm tra kết nối và thử lại.');
    document.head.appendChild(script);

    return () => script.remove();
  }, []);

  /** Lưu intent, session và token vừa được backend phát hành sau khi Google identity đã được kiểm chứng. */
  const completeRegistration = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!googleCredential) {
      setNotice('Vui lòng xác thực với Google trước khi tạo hồ sơ.');
      return;
    }
    setIsSubmitting(true);
    try {
      const result = await registerAuditorIntent({
        identityToken: googleCredential,
        payoutAccount: { bankName, bankAccountNumber, accountHolderName, branchName: branchName || undefined }
      });
      persistAuthSession({
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        csrfToken: result.csrfToken,
        refreshSessionId: result.refreshSessionId,
        refreshTokenExpiresAt: result.expiresAt
      });
      window.localStorage.setItem(AUDITOR_INTENT_STORAGE_KEY, result.intentId);
      setAccessToken(result.accessToken);
      setIntentId(result.intentId);
      setIntentStatus('PENDING_TX');
      setNotice(`Hồ sơ đã tạo. Mức đặt cọc tối thiểu là ${result.minimumStakeThreshold} DCT.`);
    } catch (error) {
      setNotice(getErrorMessage(error, 'Không thể tạo hồ sơ Kiểm toán viên.'));
    } finally {
      setIsSubmitting(false);
    }
  };

  /** Gửi UserOperation đặt cọc sau khi intent và session Auditor đã tồn tại bền vững. */
  const submitStake = async (): Promise<void> => {
    if (!accessToken) return;
    setIsSubmitting(true);
    try {
      const result = await executeAuditorStake(accessToken);
      setIntentStatus(result.status);
      setNotice(`Đã gửi giao dịch đặt cọc: ${result.txHash}`);
    } catch (error) {
      setNotice(getErrorMessage(error, 'Không thể gửi giao dịch đặt cọc.'));
    } finally {
      setIsSubmitting(false);
    }
  };

  /** Đọc trạng thái intent theo yêu cầu người dùng để tránh polling không cần thiết trên API blockchain. */
  const refreshIntentStatus = async (): Promise<void> => {
    if (!accessToken || !intentId) return;
    setIsSubmitting(true);
    try {
      const result = await getAuditorOnboardingStatus(accessToken, intentId);
      setIntentStatus(result.status);
      setNotice(result.failureReason || `Trạng thái hồ sơ: ${result.status}.`);
    } catch (error) {
      setNotice(getErrorMessage(error, 'Không thể cập nhật trạng thái hồ sơ.'));
    } finally {
      setIsSubmitting(false);
    }
  };

  /** Gửi yêu cầu unbonding và cảnh báo khi mốc rút cũ bị thay thế bởi yêu cầu mới. */
  const submitUnstake = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!accessToken) return;
    setIsSubmitting(true);
    try {
      const result = await requestAuditorUnstake(accessToken, unstakeAmount);
      const previousReleaseWarning = result.previousReleaseAt
        ? ` Mốc rút cũ ${new Date(result.previousReleaseAt).toLocaleString('vi-VN')} đã được thay thế.`
        : '';
      setNotice(`Đã gửi yêu cầu unbonding. Có thể rút từ ${new Date(result.releaseAt).toLocaleString('vi-VN')}.${previousReleaseWarning}`);
    } catch (error) {
      setNotice(getErrorMessage(error, 'Không thể gửi yêu cầu unbonding.'));
    } finally {
      setIsSubmitting(false);
    }
  };

  /** Rút khoản stake đã hết unbonding và hiển thị định danh payout để người dùng theo dõi hỗ trợ khi cần. */
  const submitWithdrawal = async (): Promise<void> => {
    if (!accessToken) return;
    setIsSubmitting(true);
    try {
      const result = await withdrawAuditorStake(accessToken);
      setNotice(`Đã gửi lệnh rút stake ${result.txHash}. Mã payout: ${result.payoutId}.`);
    } catch (error) {
      setNotice(getErrorMessage(error, 'Không thể rút stake.'));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <main className="mx-auto max-w-3xl space-y-6 px-4 py-10">
      <header className="space-y-2">
        <p className="text-sm font-semibold text-teal-700">AUDITOR STAKING</p>
        <h1 className="text-3xl font-bold text-slate-900">Đăng ký Kiểm toán viên</h1>
        <p className="text-slate-600">Xác thực Google, đăng ký tài khoản nhận payout và đặt cọc DCT trong một luồng có thể theo dõi.</p>
      </header>

      {notice && <p role="status" className="rounded-md bg-slate-100 p-3 text-sm text-slate-800">{notice}</p>}

      <section className="rounded-lg border bg-white p-5 shadow-sm" aria-labelledby="auditor-register-heading">
        <h2 id="auditor-register-heading" className="text-xl font-semibold">1. Tạo hồ sơ và tài khoản nhận tiền</h2>
        <div id="auditor-google-identity-button" className="mt-4 min-h-10" />
        <form onSubmit={event => void completeRegistration(event)} className="mt-5 grid gap-4 sm:grid-cols-2">
          <label className="grid gap-1 text-sm font-medium">Ngân hàng
            <input required value={bankName} onChange={event => setBankName(event.target.value)} className="rounded border p-2" />
          </label>
          <label className="grid gap-1 text-sm font-medium">Số tài khoản
            <input required inputMode="numeric" value={bankAccountNumber} onChange={event => setBankAccountNumber(event.target.value)} className="rounded border p-2" />
          </label>
          <label className="grid gap-1 text-sm font-medium">Chủ tài khoản
            <input required value={accountHolderName} onChange={event => setAccountHolderName(event.target.value)} className="rounded border p-2" />
          </label>
          <label className="grid gap-1 text-sm font-medium">Chi nhánh (không bắt buộc)
            <input value={branchName} onChange={event => setBranchName(event.target.value)} className="rounded border p-2" />
          </label>
          <button type="submit" disabled={isSubmitting || !googleCredential} className="rounded bg-teal-700 px-4 py-2 font-semibold text-white disabled:opacity-50 sm:col-span-2">
            Tạo hồ sơ Auditor
          </button>
        </form>
      </section>

      <section className="rounded-lg border bg-white p-5 shadow-sm" aria-labelledby="auditor-stake-heading">
        <h2 id="auditor-stake-heading" className="text-xl font-semibold">2. Đặt cọc và xác minh</h2>
        <p className="mt-2 text-sm text-slate-600">Intent: <span className="font-mono">{intentId || 'chưa tạo'}</span>{intentStatus ? ` · ${intentStatus}` : ''}</p>
        <div className="mt-4 flex flex-wrap gap-3">
          <button type="button" onClick={() => void submitStake()} disabled={isSubmitting || !accessToken || !intentId} className="rounded bg-violet-700 px-4 py-2 font-semibold text-white disabled:opacity-50">Đặt cọc DCT</button>
          <button type="button" onClick={() => void refreshIntentStatus()} disabled={isSubmitting || !accessToken || !intentId} className="rounded border border-slate-300 px-4 py-2 font-semibold disabled:opacity-50">Cập nhật trạng thái</button>
        </div>
      </section>

      <section className="rounded-lg border bg-white p-5 shadow-sm" aria-labelledby="auditor-withdraw-heading">
        <h2 id="auditor-withdraw-heading" className="text-xl font-semibold">3. Unbond và rút stake</h2>
        <form onSubmit={event => void submitUnstake(event)} className="mt-4 flex flex-wrap gap-3">
          <label className="grid gap-1 text-sm font-medium">Số DCT muốn unbond
            <input required inputMode="numeric" min="1" value={unstakeAmount} onChange={event => setUnstakeAmount(event.target.value)} className="rounded border p-2" />
          </label>
          <button type="submit" disabled={isSubmitting || !accessToken || !unstakeAmount} className="self-end rounded border border-violet-700 px-4 py-2 font-semibold text-violet-700 disabled:opacity-50">Yêu cầu unbond</button>
          <button type="button" onClick={() => void submitWithdrawal()} disabled={isSubmitting || !accessToken} className="self-end rounded bg-slate-900 px-4 py-2 font-semibold text-white disabled:opacity-50">Rút stake đã hết hạn</button>
        </form>
      </section>
    </main>
  );
}
