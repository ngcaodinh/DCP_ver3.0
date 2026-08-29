'use client';

import { useState, type ReactElement } from 'react';
import { parseCommitteeSeatChangeDraft, signCommitteeSeatChangeDraft } from '@/app/utils/committeeSeatChange';

/** Cho từng Chair/Member ký cùng draft thay ghế trong portal họ được phép truy cập, không cần cấp quyền System Admin. */
export function CommitteeSeatChangeSigningPanel(): ReactElement {
  const [draftText, setDraftText] = useState('');
  const [notice, setNotice] = useState('');
  const [isSigning, setIsSigning] = useState(false);
  const contractAddress = process.env.NEXT_PUBLIC_COMMITTEE_GOVERNANCE_ADDRESS || '';

  const signDraft = async (): Promise<void> => {
    setIsSigning(true);
    try {
      const draft = parseCommitteeSeatChangeDraft(draftText);
      const signature = await signCommitteeSeatChangeDraft({ contractAddress, draft });
      setDraftText(JSON.stringify({ ...draft, signatures: [...draft.signatures, signature] }, null, 2));
      setNotice('Đã thêm chữ ký của bạn. Chia sẻ lại nguyên văn JSON cho các ghế còn lại hoặc người relay proposal.');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Không thể ký draft thay ghế.');
    } finally {
      setIsSigning(false);
    }
  };

  return <section className="mt-4 rounded-2xl border border-violet-200 bg-violet-50 p-4"><h3 className="font-bold text-violet-950">Ký đề xuất thay ghế</h3><p className="mt-1 text-sm leading-6 text-violet-900">Dán JSON draft EIP-712 do người điều phối tạo. Ví chỉ ký khi draft còn hạn, đúng chain và đúng epoch roster hiện tại.</p>{notice ? <p role="status" className="mt-3 rounded-xl bg-white p-3 text-sm text-slate-800">{notice}</p> : null}<textarea aria-label="Draft thay ghế để ký" value={draftText} onChange={event => setDraftText(event.target.value)} placeholder="Dán JSON draft thay ghế" className="mt-3 min-h-36 w-full rounded-xl border border-violet-200 bg-white p-3 font-mono text-xs" /><button type="button" disabled={isSigning || !draftText.trim()} onClick={() => void signDraft()} className="mt-3 min-h-10 rounded-xl bg-violet-700 px-3 py-2 text-sm font-bold text-white disabled:opacity-50">{isSigning ? 'Đang chờ chữ ký…' : 'Ký draft thay ghế'}</button></section>;
}
