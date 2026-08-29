'use client';

import { type ReactElement, useCallback, useEffect, useState } from 'react';
import { readAuthSession } from '@/app/utils/authSession';
import { AUDITOR_PAYOUT_STATUS_LABEL, formatVndAmount } from '@/app/constants/auditorPortal';
import { withdrawAuditorReward } from '@/app/utils/auditorOnboarding';
import type { AuditorEarnings } from '@/app/utils/auditorPortalApi';

interface AuditorEarningsPanelProps {
  isActive: boolean;
  fetchAuditorResource: <T>(pathname: string) => Promise<T | null>;
}

/** Hiển thị sổ thưởng phạt và cho Auditor rút phần DCT thưởng đã sẵn sàng về tài khoản ngân hàng. */
export default function AuditorEarningsPanel({ isActive, fetchAuditorResource }: AuditorEarningsPanelProps): ReactElement {
  const [data, setData] = useState<AuditorEarnings | null>(null);
  const [message, setMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  /** Nạp lại sổ thưởng để số dư thay đổi ngay sau khi tạo payout. */
  const loadEarnings = useCallback(async (): Promise<void> => {
    try {
      const earnings = await fetchAuditorResource<AuditorEarnings>('/api/auditor-onboarding/earnings?limit=50');
      setData(earnings || { claimableRewardVnd: 0, ledgerEntries: [], payouts: [] });
      setMessage('');
    } catch {
      setMessage('Không đọc được sổ thưởng phạt. Vui lòng thử lại.');
    }
  }, [fetchAuditorResource]);

  /** Chỉ nạp lần đầu khi tab thù lao được mở. */
  useEffect(() => {
    if (isActive && !data) void loadEarnings();
  }, [data, isActive, loadEarnings]);

  /** Tạo payout cho toàn bộ phần thưởng đã credit on-chain còn có thể rút. */
  async function submitWithdrawReward(): Promise<void> {
    const accessToken = readAuthSession().accessToken;
    if (!accessToken || !data || data.claimableRewardVnd <= 0) return;
    setIsSubmitting(true);
    try {
      const payout = await withdrawAuditorReward(accessToken, data.claimableRewardVnd);
      setMessage(`Đã tạo payout ${payout.payoutId}; xem trạng thái trong lịch sử chuyển tiền.`);
      await loadEarnings();
    } catch (error) {
      setMessage((error as { message?: string }).message || 'Không thể rút tiền thưởng.');
    } finally {
      setIsSubmitting(false);
    }
  }

  if (!data) return <section id="auditor-earnings-panel" role="tabpanel" aria-labelledby="auditor-earnings-tab" className="min-w-0 rounded-3xl border border-emerald-900/10 bg-white p-5 shadow-[0_12px_36px_rgba(15,23,42,0.06)] sm:p-7">{message ? <><p>{message}</p><button type="button" onClick={() => void loadEarnings()} className="mt-3 min-h-11 rounded-xl border border-emerald-300 px-4 py-2 text-sm font-bold text-emerald-800">Thử lại</button></> : 'Đang tải sổ thưởng phạt…'}</section>;

  return <section id="auditor-earnings-panel" role="tabpanel" aria-labelledby="auditor-earnings-tab" className="min-w-0 rounded-3xl border border-emerald-900/10 bg-white p-5 shadow-[0_12px_36px_rgba(15,23,42,0.06)] sm:p-7">
    <h2 className="text-2xl font-bold text-slate-950">Thù lao &amp; Phạt</h2>
    <p className="mt-3 rounded-xl bg-emerald-50 p-4 text-sm leading-6 text-emerald-950">0,50% mỗi đợt giải ngân được trích vào Quỹ Bounty để chi trả cho Kiểm toán viên.</p>
    <div className="mt-3 rounded-xl bg-slate-50 p-4 text-sm text-slate-700">{data.claimableRewardVnd > 0 ? <><p>Bạn có {formatVndAmount(data.claimableRewardVnd)} tiền thưởng đã sẵn sàng rút.</p><button type="button" disabled={isSubmitting} onClick={() => void submitWithdrawReward()} className="mt-3 min-h-11 rounded-xl bg-[#0e7c6b] px-4 py-2 text-sm font-bold text-white disabled:opacity-50">Rút tiền thưởng</button></> : 'Chưa có khoản thưởng nào sẵn sàng rút. Thưởng mới sẽ hiện ở đây sau khi được ghi nhận và cộng vào ví (7 ngày sau khi phát sinh).'}</div>
    {message && <p role="status" className="mt-4 rounded-xl bg-slate-50 p-3 text-sm text-slate-700">{message}</p>}
    <h3 className="mt-6 font-bold">Sổ thù lao &amp; phạt</h3>
    {data.ledgerEntries.length ? <div className="mt-3 space-y-2">{data.ledgerEntries.map(entry => <article key={entry.ledgerId} className="rounded-xl border border-slate-200 p-3 text-sm"><b>{entry.entryType === 'REWARD' ? 'Thù lao' : 'Phạt'}</b> · {formatVndAmount(Number(entry.amount))} · {entry.status}<br />Lý do: {entry.reasonCode}<br /><span className="text-slate-500">{new Date(entry.createdAt).toLocaleString('vi-VN')}</span></article>)}</div> : <p className="mt-2 text-sm text-slate-600">Chưa phát sinh khoản thù lao hoặc phạt nào.</p>}
    <h3 className="mt-6 font-bold">Lịch sử chuyển tiền</h3>
    {data.payouts.length ? <div className="mt-3 space-y-2">{data.payouts.map(payout => <article key={payout.payoutId} className="rounded-xl border border-slate-200 p-3 text-sm"><b>{payout.payoutType === 'REWARD' ? 'Thù lao' : 'Rút cọc'}</b> · {AUDITOR_PAYOUT_STATUS_LABEL[payout.status]}<br />{formatVndAmount(payout.amountVnd)} − phí bị trừ {formatVndAmount(payout.feeVnd)} = {formatVndAmount(payout.netAmountVnd)}<br />{payout.bankSnapshot.bankName} · {payout.bankSnapshot.bankAccountNumberMasked}{(payout.status === 'FAILED' || payout.status === 'MANUAL_REVIEW') && payout.errorMessage && <p className="mt-2 text-red-700">{payout.errorMessage}</p>}{payout.status === 'MANUAL_REVIEW' && <p className="mt-2 text-amber-800">Khoản này cần đối soát thủ công, bộ phận vận hành đang xử lý.</p>}</article>)}</div> : <p className="mt-2 text-sm text-slate-600">Bạn chưa có khoản chuyển tiền nào.</p>}
  </section>;
}
