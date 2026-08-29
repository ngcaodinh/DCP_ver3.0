'use client';

import type { ReactElement } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { buildApiUrl, fetchApi, getApiErrorMessage } from '@/app/utils/apiClient';
import { readAuthSession } from '@/app/utils/authSession';
import { EvidenceDeviationBadge } from './EvidenceDeviationBadge';
import { GeofenceMapLazy } from '../oracle/GeofenceMapLazy';
import { signCommitteeGovernanceVote, type CommitteeVoteSignaturePayload } from '@/app/utils/committeeGovernanceSigner';

type DeviationLevel = 'INSIDE' | 'WITHIN_ACCURACY' | 'DEVIATED' | 'CRITICAL' | 'NO_GEOFENCE';
type CommitteeCase = { requestId: string; votes: Array<{ voterRole: string; decision: 'APPROVE' | 'REJECT' }> };
type PendingDisbursementCase = {
  committeeCase: CommitteeCase;
  disbursement: { requestId: string; amount: number; usagePurpose: string; requestMode: string; timeoutDeadline: string | null };
  monitoring: {
    projectId: string;
    highestDeviationLevel: DeviationLevel;
    evidencePhotos: Array<{ cid: string; gps: { lat: number; lng: number } | null; deviationLevel: DeviationLevel; distanceMeters: number | null; accuracyMeters: number; capturedAt: string | null; isLowAccuracyOverride: boolean; lowAccuracyReason: string | null }>;
  };
};
type PendingDisbursementResponse = {
  items: PendingDisbursementCase[];
  nextCursor: string | null;
};

/** Đọc token tại thời điểm request để vote luôn đi cùng phiên chưa bị thu hồi. */
function getVotingHeaders(): HeadersInit {
  const token = readAuthSession().accessToken;
  return token ? { Authorization: 'Bearer ' + token } : {};
}

/** Đồng bộ UI với GPS gate backend để chỉ cảnh báo rủi ro thực sự cần xác nhận. */
function requiresRiskAcknowledgement(deviationLevel: DeviationLevel): boolean {
  return deviationLevel === 'DEVIATED' || deviationLevel === 'CRITICAL';
}

/** Hiển thị phiếu 3/5 theo bố cục co giãn và giữ GPS evidence cạnh thao tác quyết định trên mọi màn hình. */
export function DisbursementVotingPanel(): ReactElement {
  const [cases, setCases] = useState<PendingDisbursementCase[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [reasonByRequestId, setReasonByRequestId] = useState<Record<string, string>>({});
  const [acknowledgedRiskByRequestId, setAcknowledgedRiskByRequestId] = useState<Record<string, boolean>>({});
  const [notice, setNotice] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [submittingRequestId, setSubmittingRequestId] = useState<string | null>(null);

  /** Tải hàng chờ vote thuộc snapshot của người đang đăng nhập. */
  const loadCases = useCallback(async (cursor: string | null = null, append = false): Promise<void> => {
    setIsLoading(true);
    try {
      const searchParameters = new URLSearchParams({ limit: '20' });
      if (cursor) searchParameters.set('cursor', cursor);
      const response = await fetchApi<PendingDisbursementResponse>(
        buildApiUrl(`/api/disbursement/executive/pending?${searchParameters.toString()}`),
        { headers: getVotingHeaders() }
      );
      // Giữ tương thích dữ liệu hàng chờ cũ trong lúc client/API được rollout lệch phiên bản.
      const page = Array.isArray(response.data)
        ? { items: response.data, nextCursor: null }
        : { items: response.data?.items || [], nextCursor: response.data?.nextCursor || null };
      setCases(currentCases => append ? [...currentCases, ...page.items] : page.items);
      setNextCursor(page.nextCursor);
    } catch (error) {
      setNotice(getApiErrorMessage(error, 'Không thể tải hàng chờ giải ngân.'));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { void loadCases(); }, [loadCases]);

  /** Kiểm tra lý do và acknowledgement trước khi gửi quyết định bất biến tới API. */
  const vote = async (requestId: string, decision: 'APPROVE' | 'REJECT'): Promise<void> => {
    const reason = (reasonByRequestId[requestId] || '').trim();
    if (reason.length < 10) {
      setNotice('Lý do biểu quyết phải có ít nhất 10 ký tự.');
      return;
    }
    const currentCase = cases.find(item => item.disbursement.requestId === requestId);
    if (currentCase && requiresRiskAcknowledgement(currentCase.monitoring.highestDeviationLevel) && !acknowledgedRiskByRequestId[requestId]) {
      setNotice('Bạn phải xác nhận đã xem cảnh báo GPS trước khi biểu quyết.');
      return;
    }
    setSubmittingRequestId(requestId);
    try {
      const signingPayloadResponse = await fetchApi<CommitteeVoteSignaturePayload | null>(
        buildApiUrl('/api/disbursement/executive/' + encodeURIComponent(requestId) + '/signing-payload'),
        { method: 'POST', headers: getVotingHeaders(), body: JSON.stringify({ decision, reason }) }
      );
      const eip712Signature = signingPayloadResponse.data
        ? await signCommitteeGovernanceVote(signingPayloadResponse.data)
        : undefined;
      await fetchApi(buildApiUrl('/api/disbursement/executive/' + encodeURIComponent(requestId) + '/vote'), {
        method: 'POST',
        headers: getVotingHeaders(),
        body: JSON.stringify({ decision, reason, gpsRiskAcknowledged: Boolean(acknowledgedRiskByRequestId[requestId]), eip712Signature })
      });
      setNotice('Đã ghi nhận phiếu. Worker chỉ chấp hành khi Chủ tịch và ít nhất hai Ủy viên cùng phía.');
      await loadCases();
    } catch (error) {
      setNotice(getApiErrorMessage(error, 'Không thể ghi nhận phiếu giải ngân.'));
    } finally {
      setSubmittingRequestId(null);
    }
  };

  return <section aria-labelledby="disbursement-title" className="min-w-0 rounded-3xl border border-slate-200/80 bg-white/90 p-4 shadow-[0_16px_35px_-28px_rgba(15,23,42,0.45)] backdrop-blur sm:p-6">
    <header className="flex flex-col gap-4 border-b border-slate-100 pb-4 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-violet-700">Hàng chờ quyết định</p>
        <h2 id="disbursement-title" className="mt-1 text-2xl font-bold tracking-tight text-slate-950">Duyệt giải ngân</h2>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">Đánh giá mục đích sử dụng, bằng chứng GPS và lý do trước khi gửi phiếu không thể sửa.</p>
      </div>
      <span className="inline-flex w-fit items-center gap-2 rounded-full bg-violet-50 px-3 py-1.5 text-sm font-semibold text-violet-800"><span className="h-2 w-2 rounded-full bg-violet-500" />{isLoading ? 'Đang đồng bộ' : cases.length + ' yêu cầu chờ'}</span>
    </header>

    <p className="mt-4 rounded-2xl border border-violet-100 bg-violet-50 p-3 text-sm leading-6 text-violet-950 sm:p-4"><span className="font-bold">Quy tắc cố định:</span> Chủ tịch bắt buộc + ít nhất 2/4 Ủy viên cùng một quyết định. Bốn Ủy viên không có Chủ tịch vẫn chưa đạt.</p>
    {notice ? <p role="status" className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm leading-6 text-amber-950">{notice}</p> : null}

    {isLoading ? <div aria-label="Đang tải hàng chờ giải ngân" className="mt-5 space-y-4">
      {Array.from({ length: 2 }).map((_, index) => <div key={index} className="animate-pulse rounded-2xl border border-slate-100 p-4"><div className="flex justify-between gap-4"><div className="h-5 w-36 rounded bg-slate-200" /><div className="h-8 w-28 rounded-full bg-violet-100" /></div><div className="mt-3 h-4 w-2/3 rounded bg-slate-200" /><div className="mt-5 h-44 rounded-xl bg-slate-100" /><div className="mt-4 h-24 rounded-xl bg-slate-100" /></div>)}
    </div> : null}

    {!isLoading && cases.length === 0 ? <div className="mt-5 rounded-2xl border border-dashed border-violet-200 bg-violet-50/60 px-5 py-10 text-center">
      <div aria-hidden="true" className="mx-auto grid h-11 w-11 place-items-center rounded-2xl bg-white text-xl text-violet-700 shadow-sm">✓</div>
      <h3 className="mt-3 font-semibold text-slate-900">Không có yêu cầu cần biểu quyết</h3>
      <p className="mx-auto mt-1 max-w-md text-sm leading-6 text-slate-600">Các yêu cầu thuộc snapshot của bạn sẽ xuất hiện tại đây để được xem xét an toàn.</p>
    </div> : null}

    {!isLoading ? <div className="mt-5 space-y-4">{cases.map(item => {
      const chairVotes = item.committeeCase.votes.filter(voteRecord => voteRecord.voterRole === 'executive_chair');
      const memberVotes = item.committeeCase.votes.filter(voteRecord => voteRecord.voterRole === 'executive_member');
      const approveVotes = item.committeeCase.votes.filter(voteRecord => voteRecord.decision === 'APPROVE').length;
      const rejectVotes = item.committeeCase.votes.filter(voteRecord => voteRecord.decision === 'REJECT').length;
      const requiresAcknowledgement = requiresRiskAcknowledgement(item.monitoring.highestDeviationLevel);
      const isSubmitting = submittingRequestId === item.disbursement.requestId;
      const markerList = item.monitoring.evidencePhotos.map((photo, index) => ({
        id: photo.cid + '-' + index,
        coordinate: photo.gps,
        status: photo.deviationLevel === 'DEVIATED' || photo.deviationLevel === 'CRITICAL' ? 'INVALID' as const : photo.gps ? 'VALID' as const : 'NO_GPS' as const,
        evidenceCid: photo.cid,
        distanceMeters: photo.distanceMeters,
        capturedAt: photo.capturedAt || undefined
      }));
      return <article key={item.disbursement.requestId} className="min-w-0 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
        <div className="flex flex-col gap-4 border-b border-slate-100 pb-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2"><span className="rounded-full bg-violet-100 px-2.5 py-1 text-xs font-bold text-violet-800">Yêu cầu chờ duyệt</span><span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600">{item.disbursement.requestMode}</span></div>
            <h3 className="mt-3 break-all text-base font-bold text-slate-950 sm:break-words">Yêu cầu {item.disbursement.requestId}</h3>
            <p className="mt-1 break-words text-sm leading-6 text-slate-600">{item.disbursement.usagePurpose}</p>
            {item.disbursement.timeoutDeadline ? <p className="mt-2 text-xs font-medium text-amber-800">Hạn xử lý: {new Date(item.disbursement.timeoutDeadline).toLocaleString('vi-VN')}</p> : null}
          </div>
          <div className="w-fit shrink-0 rounded-2xl bg-gradient-to-br from-violet-700 to-indigo-700 px-4 py-3 text-white shadow-[0_12px_24px_-16px_rgba(79,70,229,1)]">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-violet-200">Số tiền đề nghị</p>
            <p className="mt-1 text-lg font-bold">{item.disbursement.amount.toLocaleString('vi-VN')} <span className="text-sm text-violet-100">token</span></p>
          </div>
        </div>

        <dl className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <div className="rounded-xl bg-slate-50 p-2.5"><dt className="text-[11px] text-slate-500">Phiếu Chủ tịch</dt><dd className="mt-1 font-bold text-slate-900">{chairVotes.length}/1</dd></div>
          <div className="rounded-xl bg-slate-50 p-2.5"><dt className="text-[11px] text-slate-500">Phiếu Ủy viên</dt><dd className="mt-1 font-bold text-slate-900">{memberVotes.length}/4</dd></div>
          <div className="rounded-xl bg-emerald-50 p-2.5"><dt className="text-[11px] text-emerald-700">Đồng ý</dt><dd className="mt-1 font-bold text-emerald-900">{approveVotes}</dd></div>
          <div className="rounded-xl bg-rose-50 p-2.5"><dt className="text-[11px] text-rose-700">Từ chối</dt><dd className="mt-1 font-bold text-rose-900">{rejectVotes}</dd></div>
        </dl>

        <div className="mt-4 min-w-0 overflow-hidden rounded-2xl border border-slate-100 bg-slate-50 p-3 sm:p-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"><p className="text-sm font-bold text-slate-900">Bằng chứng và đối chiếu GPS</p><EvidenceDeviationBadge deviationLevel={item.monitoring.highestDeviationLevel} distanceMeters={null} accuracyMeters={0} /></div>
          <div className="mt-3 min-w-0"><GeofenceMapLazy projectId={item.monitoring.projectId} markers={markerList} /></div>
        </div>

        {item.monitoring.evidencePhotos.some(photo => photo.isLowAccuracyOverride) ? <p className="mt-4 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm leading-6 text-amber-950"><strong>Có ảnh chụp qua van thoát GPS.</strong> {item.monitoring.evidencePhotos.filter(photo => photo.isLowAccuracyOverride).map(photo => photo.lowAccuracyReason || 'Không nêu lý do').join(' · ')}</p> : null}

        {requiresAcknowledgement ? <label className="mt-4 flex items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm leading-5 text-amber-950"><input type="checkbox" checked={Boolean(acknowledgedRiskByRequestId[item.disbursement.requestId])} onChange={event => setAcknowledgedRiskByRequestId(current => ({ ...current, [item.disbursement.requestId]: event.target.checked }))} className="mt-0.5 h-4 w-4 shrink-0 accent-amber-700" /><span><strong>Xác nhận rủi ro GPS.</strong> Tôi đã xem cảnh báo và bản đồ đối chiếu trước khi biểu quyết.</span></label> : null}

        {memberVotes.length >= 2 && chairVotes.length === 0 ? <p className="mt-4 rounded-xl bg-amber-50 px-3 py-2 text-sm font-medium text-amber-900">Đã có đủ phiếu Ủy viên nhưng vẫn cần chữ ký Chủ tịch DAO.</p> : null}
        <label className="mt-4 block text-sm font-bold text-slate-800">Lý do biểu quyết
          <textarea aria-label={'Lý do cho ' + item.disbursement.requestId} value={reasonByRequestId[item.disbursement.requestId] || ''} onChange={event => setReasonByRequestId(current => ({ ...current, [item.disbursement.requestId]: event.target.value }))} className="mt-2 min-h-28 w-full rounded-xl border border-slate-200 bg-white p-3 text-base font-normal leading-6 outline-none transition-colors placeholder:text-slate-400 focus:border-violet-500 focus:ring-2 focus:ring-violet-100" placeholder="Nêu căn cứ biểu quyết (ít nhất 10 ký tự)" maxLength={500} />
        </label>
        <div className="mt-4 grid grid-cols-1 gap-2 sm:flex">
          <button type="button" disabled={isSubmitting || (requiresAcknowledgement && !acknowledgedRiskByRequestId[item.disbursement.requestId])} onClick={() => void vote(item.disbursement.requestId, 'APPROVE')} className="min-h-11 rounded-xl bg-emerald-700 px-4 py-2 text-sm font-bold text-white transition-colors hover:bg-emerald-800 disabled:cursor-wait disabled:opacity-60">{isSubmitting ? 'Đang gửi phiếu…' : 'Đồng ý giải ngân'}</button>
          <button type="button" disabled={isSubmitting || (requiresAcknowledgement && !acknowledgedRiskByRequestId[item.disbursement.requestId])} onClick={() => void vote(item.disbursement.requestId, 'REJECT')} className="min-h-11 rounded-xl bg-rose-700 px-4 py-2 text-sm font-bold text-white transition-colors hover:bg-rose-800 disabled:cursor-wait disabled:opacity-60">{isSubmitting ? 'Đang gửi phiếu…' : 'Từ chối giải ngân'}</button>
        </div>
      </article>;
    })}</div> : null}
    {!isLoading && nextCursor ? <div className="mt-5 flex justify-center"><button type="button" onClick={() => void loadCases(nextCursor, true)} className="min-h-11 rounded-xl border border-violet-200 bg-violet-50 px-4 py-2 text-sm font-bold text-violet-800 transition-colors hover:bg-violet-100">Tải thêm yêu cầu</button></div> : null}
  </section>;
}
