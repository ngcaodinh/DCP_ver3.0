'use client';

import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import { buildApiUrl, fetchApi, getApiErrorMessage } from '@/app/utils/apiClient';

type PublicEventType = 'SEATS_BOOTSTRAPPED' | 'SEAT_CHANGE_PROPOSED' | 'SEAT_CHANGE_EXECUTED' | 'DECISION_RECORDED';
type PublicGovernanceEvent = { transactionHash: string; occurredAt: string; eventType: PublicEventType; eventData: Record<string, unknown> };
type PublicDecision = {
  requestId: string;
  decisionKind?: 'DISBURSEMENT' | 'ARBITRATION';
  approved: boolean;
  onChainDecisionTxHash: string | null;
  recordedAt: string;
  votes: Array<{ voterName: string; voterRole: string; decision: string; votedAt: string; signature: string | null; signedPayloadHash: string | null; reasonCommitment: string | null; nonce: string | null; deadline: string | null; committeeEpoch: string | null }>;
  supersededVoteRounds?: Array<{ verdict: string | null; supersededAt: string; reason: string; votes: Array<{ voterName: string; voterRole: string; decision: string; votedAt: string }> }>;
};

/** Diễn giải event đã project thành nhãn ngắn để người xem không cần biết ABI contract. */
function getEventLabel(event: PublicGovernanceEvent): string {
  if (event.eventType === 'SEATS_BOOTSTRAPPED') return 'Đã nạp 5 ghế Ủy ban';
  if (event.eventType === 'SEAT_CHANGE_PROPOSED') return 'Đã đề xuất đổi ghế (chờ 3 ngày)';
  if (event.eventType === 'SEAT_CHANGE_EXECUTED') return 'Đã thực thi đổi ghế';
  return 'Đã ghi quyết định Ủy ban';
}

/** Tải bundle chữ ký đúng dữ liệu backend đã xác minh để người dân có thể tự kiểm chứng độc lập. */
function downloadSignatureBundle(decision: PublicDecision): void {
  const blob = new Blob([JSON.stringify(decision, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `committee-decision-${decision.requestId}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

/** Hiển thị mốc ghế đã được projector backend đọc từ chain, không phát sinh RPC trực tiếp trong trình duyệt. */
export function PublicCommitteeGovernanceFeed(): ReactElement {
  const [events, setEvents] = useState<PublicGovernanceEvent[]>([]);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let isActive = true;
    void (async (): Promise<void> => {
      try {
        const response = await fetchApi<{ items: PublicGovernanceEvent[] }>(buildApiUrl('/api/governance/public/events?limit=8'));
        if (isActive) setEvents(response.data.items || []);
      } catch (error) {
        if (isActive) setNotice(getApiErrorMessage(error, 'Chưa thể tải nhật ký quản trị công khai. Vui lòng thử lại sau.'));
      }
    })();
    return () => { isActive = false; };
  }, []);

  return <section className="mx-auto max-w-6xl px-4 py-8" aria-label="Bảng tin quản trị on-chain">
    <div className="rounded-2xl border border-violet-200 bg-violet-50 p-6">
      <p className="text-sm font-semibold text-violet-700">MINH BẠCH QUẢN TRỊ</p>
      <h2 className="mt-1 text-2xl font-bold text-violet-950">Nhật ký ghế Ủy ban trên blockchain</h2>
      <p className="mt-2 text-sm text-violet-900">Backend project event theo checkpoint block/log; mỗi lượt xem chỉ đọc một trang dữ liệu đã kiểm chứng.</p>
      {notice ? <p role="status" className="mt-3 text-sm text-amber-800">{notice}</p> : null}
      {events.length > 0 ? <ul className="mt-4 divide-y divide-violet-200 rounded-lg bg-white px-4">{events.map(event => <li key={`${event.transactionHash}-${event.eventType}`} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm"><span className="font-medium text-slate-900">{getEventLabel(event)}</span><span className="text-slate-600">{new Date(event.occurredAt).toLocaleString('vi-VN')}</span><a className="font-mono text-xs text-violet-700 underline" href={`https://amoy.polygonscan.com/tx/${event.transactionHash}`} target="_blank" rel="noreferrer">{event.transactionHash.slice(0, 10)}…{event.transactionHash.slice(-8)}</a></li>)}</ul> : !notice ? <p className="mt-4 text-sm text-slate-600">Chưa có mốc quản trị được projector ghi nhận.</p> : null}
    </div>
  </section>;
}

/** Công khai quyết định giải ngân, vai trò và commitment lý do từ read model backend đã đối soát chain. */
export function PublicCommitteeDecisionFeed(): ReactElement {
  const [decisions, setDecisions] = useState<PublicDecision[]>([]);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let isActive = true;
    void (async (): Promise<void> => {
      try {
        const response = await fetchApi<{ items: PublicDecision[] }>(buildApiUrl('/api/governance/public/decisions?limit=12'));
        if (isActive) setDecisions(response.data.items || []);
      } catch (error) {
        if (isActive) setNotice(getApiErrorMessage(error, 'Chưa thể tải quyết định Ủy ban công khai. Vui lòng thử lại sau.'));
      }
    })();
    return () => { isActive = false; };
  }, []);

  return <section className="mx-auto mt-8 max-w-6xl px-4" aria-label="Quyết định Ủy ban">
    <h2 className="text-2xl font-bold text-slate-900">Quyết định của Ủy ban</h2>
    <p className="mt-1 text-sm text-slate-600">Mỗi quyết định kèm vai trò người bỏ phiếu, cam kết lý do, giao dịch on-chain và bộ chữ ký có thể tải về.</p>
    {notice ? <p role="status" className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">{notice}</p> : decisions.length ? <div className="mt-4 space-y-3">{decisions.map(decision => <article key={decision.requestId} className="rounded-xl border bg-white p-4"><div className="flex flex-wrap justify-between gap-2"><strong>{decision.decisionKind === 'ARBITRATION' ? 'Phán quyết xét xử' : 'Quyết định giải ngân'}: {decision.approved ? 'Đồng ý' : 'Từ chối'}</strong><span className="text-sm text-slate-500">{new Date(decision.recordedAt).toLocaleString('vi-VN')}</span></div><p className="mt-2 break-all font-mono text-xs text-slate-600">Hồ sơ: {decision.requestId}</p>{decision.decisionKind === 'ARBITRATION' && decision.supersededVoteRounds?.length ? <details className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3"><summary className="cursor-pointer text-sm font-semibold text-amber-950">Lịch sử {decision.supersededVoteRounds.length + 1} vòng biểu quyết</summary>{decision.supersededVoteRounds.map((round, index) => <div key={`${round.supersededAt}-${index}`} className="mt-3 border-t border-amber-200 pt-3 text-sm text-amber-950"><p>Vòng {index + 1}: {round.verdict === 'UPHOLD_PROJECT' ? 'Giữ dự án' : round.verdict === 'REJECT_PROJECT' ? 'Hủy dự án' : 'Chưa có phán quyết'}.</p><p className="mt-1">Ký lại vì: {round.reason}</p></div>)}</details> : null}<ul className="mt-3 space-y-2">{decision.votes.map(vote => <li key={`${vote.voterName}-${vote.votedAt}`} className="rounded-lg bg-slate-50 p-3 text-sm"><strong>{vote.voterName}</strong> · {vote.voterRole === 'executive_chair' ? 'Chủ tịch' : 'Ủy viên'} · {vote.decision === 'APPROVE' || vote.decision === 'UPHOLD_PROJECT' ? 'Đồng ý' : 'Từ chối'}<p className="mt-1 break-all text-slate-600">Cam kết lý do: <span className="font-mono text-xs">{vote.reasonCommitment || 'Không có'}</span></p></li>)}</ul><div className="mt-3 flex flex-wrap gap-3"><button type="button" onClick={() => downloadSignatureBundle(decision)} className="text-sm font-semibold text-violet-700 underline">Tải bộ chữ ký</button>{decision.onChainDecisionTxHash ? <a className="text-sm font-semibold text-violet-700 underline" href={`https://amoy.polygonscan.com/tx/${decision.onChainDecisionTxHash}`} target="_blank" rel="noreferrer">Mở giao dịch on-chain</a> : null}</div></article>)}</div> : <p className="mt-4 rounded-xl border border-dashed p-4 text-sm text-slate-500">Chưa có quyết định Ủy ban được ghi nhận trên chain.</p>}
  </section>;
}
