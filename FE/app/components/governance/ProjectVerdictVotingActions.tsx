'use client';

import { type ReactElement, useState } from 'react';
import { getApiErrorMessage } from '@/app/utils/apiClient';
import { submitExecutiveArbitrationVote } from '@/app/utils/executiveArbitrationVote';

function formatVnd(amount: number): string {
  return `${new Intl.NumberFormat('vi-VN').format(Math.max(0, amount || 0))} VND`;
}

/** Action biểu quyết dùng chung cho case cũ và dự án DISPUTED trong hàng đợi công bố. */
export function ProjectVerdictVotingActions(props: {
  arbitrationId: string;
  canVote: boolean;
  project: { status: string; totalDonationAmount: number };
  onVoted: () => Promise<void>;
  upholdLabel?: string;
}): ReactElement {
  const [reason, setReason] = useState('');
  const [markedAbusive, setMarkedAbusive] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [isRejectConfirmationOpen, setIsRejectConfirmationOpen] = useState(false);
  const [isDonationLockRiskAcknowledged, setIsDonationLockRiskAcknowledged] = useState(false);
  // Arbitration có thể bắt đầu khi dự án đang DISPUTED hoặc sau khi đã ACTIVE; cả hai đều phải xác nhận trước khi khóa donation đã INDEXED.
  const requiresDonationLockRiskAcknowledgement = props.project.totalDonationAmount > 0;

  /** Chỉ mở MetaMask cho payload đã qua validation phía client. */
  const submitVote = async (decision: 'UPHOLD_PROJECT' | 'REJECT_PROJECT'): Promise<void> => {
    const normalizedReason = reason.trim();
    if (normalizedReason.length < 10) {
      setNotice('Lý do phán quyết phải có ít nhất 10 ký tự.');
      return;
    }
    setIsSaving(true);
    setNotice('');
    try {
      await submitExecutiveArbitrationVote({
        arbitrationId: props.arbitrationId,
        decision,
        reason: normalizedReason,
        markedAbusive: decision === 'UPHOLD_PROJECT' && markedAbusive,
        donationLockRiskAcknowledged: decision === 'REJECT_PROJECT' && isDonationLockRiskAcknowledged
      });
      setNotice('Đã ghi nhận chữ ký biểu quyết và đang đồng bộ lại hồ sơ.');
      await props.onVoted();
    } catch (error) {
      setNotice(getApiErrorMessage(error, 'Không thể ghi nhận phiếu xét xử.'));
    } finally {
      setIsSaving(false);
    }
  };

  if (!props.canVote) return <p className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm leading-6 text-slate-600">Bạn chỉ có quyền xem case này vì đã biểu quyết, case đã hết hạn hoặc bạn không thuộc snapshot Ủy ban.</p>;

  return <section aria-label="Biểu quyết dự án" className="rounded-2xl border border-emerald-200 bg-emerald-50/70 p-4">
    <p className="text-xs font-bold uppercase tracking-[0.14em] text-[#0E7C6B]">Biểu quyết on-chain</p>
    <p className="mt-1 text-sm leading-6 text-slate-700">Tiếp tục cần <strong>Chủ tịch + 2 Ủy viên</strong>; hủy vĩnh viễn chỉ có hiệu lực khi <strong>đủ 5/5 ghế</strong> ký EIP-712.</p>
    {notice ? <p role="status" className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">{notice}</p> : null}
    <label className="mt-4 block text-sm font-semibold text-slate-800">Lý do phán quyết<textarea aria-label="Lý do phán quyết" value={reason} onChange={event => setReason(event.target.value)} minLength={10} maxLength={500} placeholder="Nêu căn cứ phán quyết (ít nhất 10 ký tự)" className="mt-2 min-h-24 w-full rounded-xl border border-slate-300 bg-white p-3 text-sm font-normal outline-none transition-colors focus:border-[#0E7C6B] focus:ring-2 focus:ring-emerald-100" /></label>
    <label className="mt-3 flex items-start gap-3 rounded-xl border border-emerald-100 bg-white/70 p-3 text-sm leading-5 text-slate-700"><input type="checkbox" checked={markedAbusive} onChange={event => setMarkedAbusive(event.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 accent-[#0E7C6B]" /><span>Đánh dấu khiếu nại này là quấy rối nếu lựa chọn tiếp tục dự án.</span></label>
    <div className="mt-4 grid gap-2 sm:flex"><button type="button" disabled={isSaving} onClick={() => void submitVote('UPHOLD_PROJECT')} className="min-h-11 rounded-xl bg-emerald-700 px-4 py-2 text-sm font-bold text-white transition-colors hover:bg-emerald-800 disabled:cursor-wait disabled:opacity-50">{isSaving ? 'Đang gửi phiếu…' : props.upholdLabel || 'Tiếp tục dự án'}</button><button type="button" disabled={isSaving} onClick={() => setIsRejectConfirmationOpen(true)} className="min-h-11 rounded-xl bg-rose-700 px-4 py-2 text-sm font-bold text-white transition-colors hover:bg-rose-800 disabled:cursor-wait disabled:opacity-50">Hủy dự án</button></div>
    {isRejectConfirmationOpen ? <div role="dialog" aria-modal="true" aria-label="Xác nhận hủy dự án" className="mt-4 rounded-2xl border border-rose-300 bg-rose-50 p-4"><p className="font-bold text-rose-950">Xác nhận phán quyết không thể đảo ngược</p><p className="mt-1 text-sm leading-6 text-rose-900">Phiếu hủy dự án sẽ góp phần khóa vĩnh viễn hồ sơ khi đủ 5/5 ghế snapshot cùng ký. Hãy kiểm tra đầy đủ evidence trước khi tiếp tục.</p>{requiresDonationLockRiskAcknowledgement ? <label className="mt-3 flex items-start gap-3 rounded-xl border border-rose-200 bg-white p-3 text-sm leading-5 text-rose-950"><input type="checkbox" checked={isDonationLockRiskAcknowledged} onChange={event => setIsDonationLockRiskAcknowledged(event.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 accent-rose-700" /><span>Dự án này đã nhận <strong>{formatVnd(props.project.totalDonationAmount)}</strong>. Tôi hiểu rằng hủy dự án sẽ khóa vĩnh viễn khoản tiền này trong hợp đồng; không giải ngân được và không có cơ chế hoàn tiền tự động.</span></label> : null}<div className="mt-4 flex flex-wrap gap-2"><button type="button" onClick={() => setIsRejectConfirmationOpen(false)} className="min-h-10 rounded-xl border border-rose-200 bg-white px-3 py-2 text-sm font-bold text-rose-900">Quay lại</button><button type="button" disabled={isSaving || (requiresDonationLockRiskAcknowledgement && !isDonationLockRiskAcknowledged)} onClick={() => { setIsRejectConfirmationOpen(false); void submitVote('REJECT_PROJECT'); }} className="min-h-10 rounded-xl bg-rose-700 px-3 py-2 text-sm font-bold text-white disabled:opacity-50">Xác nhận hủy vĩnh viễn</button></div></div> : null}
  </section>;
}
