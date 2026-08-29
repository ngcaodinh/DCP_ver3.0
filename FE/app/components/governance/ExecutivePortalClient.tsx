'use client';

import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react';
import { buildApiUrl, fetchApi, type ApiErrorResponse } from '@/app/utils/apiClient';
import { readAuthSession } from '@/app/utils/authSession';
import { ChallengeEvidenceGallery } from './ChallengeEvidenceGallery';
import { EvidenceDeviationBadge } from './EvidenceDeviationBadge';
import { GeofenceMapLazy } from '../oracle/GeofenceMapLazy';
import { signCommitteeGovernanceVote, type CommitteeVoteSignaturePayload } from '@/app/utils/committeeGovernanceSigner';
import { CommitteeSeatChangeSigningPanel } from './CommitteeSeatChangeSigningPanel';

interface ArbitrationCase { arbitrationId: string; projectId: string; projectName: string; organizationName: string; deadlineAt: string; challengeCount: number; upholdVoteCount: number; rejectVoteCount: number; chairVoted?: boolean; requiredMemberVotes?: number; totalMemberSeats?: number; hasCurrentUserVoted: boolean; }
interface CaseDetail { arbitrationId: string; activationState?: string; geofence: { polygon: Array<{ lat: number; lng: number }> } | null; committeeSnapshot: Array<{ userId: string; role: string }>; votes: Array<{ voterUserId: string; voterName: string; voterRole: string; decision: string; reason: string }>; challenges: Array<{ challengerName: string; reason: string; evidencePhotos: Array<{ cid: string; capturedAt: string; gps: { latitude: number; longitude: number }; accuracyMeters: number; distanceMeters: number | null; deviationLevel: 'INSIDE' | 'WITHIN_ACCURACY' | 'DEVIATED' | 'CRITICAL' | 'NO_GEOFENCE'; isLowAccuracyOverride: boolean; lowAccuracyReason: string | null }> }>; project: { projectId: string; name: string; description: string; organizationName: string; status: string; totalDonationAmount: number } | null; }

/** Lấy header phiên hiện tại mà không lưu dữ liệu server vào client store. */
function getAuthorizationHeaders(): HeadersInit {
  const token = readAuthSession().accessToken;
  return token ? { Authorization: 'Bearer ' + token } : {};
}

/** Hiển thị hồ sơ xét xử với sidebar chuyển thành danh sách card trên màn hình nhỏ. */
export default function ExecutivePortalClient(): ReactElement {
  const [cases, setCases] = useState<ArbitrationCase[]>([]);
  const [detail, setDetail] = useState<CaseDetail | null>(null);
  const [reason, setReason] = useState('');
  const [markedAbusive, setMarkedAbusive] = useState(false);
  const [notice, setNotice] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [isLoadingCases, setIsLoadingCases] = useState(true);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const [isRejectConfirmationOpen, setIsRejectConfirmationOpen] = useState(false);
  const [isDonationLockRiskAcknowledged, setIsDonationLockRiskAcknowledged] = useState(false);
  const [selectedArbitrationId, setSelectedArbitrationId] = useState<string | null>(null);
  const detailRequestVersionRef = useRef(0);

  /** Tải danh sách vụ việc để phản ánh phiếu mới sau mỗi hành động. */
  const loadCases = useCallback(async (): Promise<void> => {
    setIsLoadingCases(true);
    try {
      const response = await fetchApi<ArbitrationCase[]>(buildApiUrl('/api/project-governance/executive/cases'), { headers: getAuthorizationHeaders() });
      setCases(response.data);
    } catch (error) {
      setNotice((error as ApiErrorResponse).message || 'Không thể tải hồ sơ xét xử.');
    } finally {
      setIsLoadingCases(false);
    }
  }, []);

  useEffect(() => { void loadCases(); }, [loadCases]);

  /** Lấy hồ sơ chi tiết khi Ủy ban chọn card và đặt lại form của case trước đó. */
  const selectCase = async (arbitrationId: string): Promise<void> => {
    const requestVersion = detailRequestVersionRef.current + 1;
    detailRequestVersionRef.current = requestVersion;
    setSelectedArbitrationId(arbitrationId);
    setDetail(null);
    setReason('');
    setMarkedAbusive(false);
    setIsRejectConfirmationOpen(false);
    setIsDonationLockRiskAcknowledged(false);
    setIsLoadingDetail(true);
    try {
      const response = await fetchApi<CaseDetail>(buildApiUrl('/api/project-governance/executive/cases/' + encodeURIComponent(arbitrationId)), { headers: getAuthorizationHeaders() });
      // Bỏ qua response cũ khi ủy viên đã chuyển sang một hồ sơ khác.
      if (requestVersion !== detailRequestVersionRef.current) return;
      setDetail(response.data);
    } catch (error) {
      if (requestVersion !== detailRequestVersionRef.current) return;
      setNotice((error as ApiErrorResponse).message || 'Không thể tải chi tiết hồ sơ.');
    } finally {
      if (requestVersion === detailRequestVersionRef.current) setIsLoadingDetail(false);
    }
  };

  /** Ghi nhận phiếu có lý do, rồi mới đồng bộ lại cả card và phần chi tiết để tránh UI cũ. */
  const vote = async (decision: 'UPHOLD_PROJECT' | 'REJECT_PROJECT'): Promise<void> => {
    if (!detail || reason.trim().length < 10) {
      setNotice('Lý do phán quyết phải có ít nhất 10 ký tự.');
      return;
    }
    setIsSaving(true);
    try {
      const signingPayloadResponse = await fetchApi<CommitteeVoteSignaturePayload | null>(buildApiUrl('/api/project-governance/executive/signing-payload'), {
        method: 'POST',
        headers: getAuthorizationHeaders(),
        body: JSON.stringify({ arbitrationId: detail.arbitrationId, decision, reason: reason.trim() })
      });
      const eip712Signature = signingPayloadResponse.data
        ? await signCommitteeGovernanceVote(signingPayloadResponse.data)
        : undefined;
      await fetchApi(buildApiUrl('/api/project-governance/executive/vote'), {
        method: 'POST',
        headers: getAuthorizationHeaders(),
        body: JSON.stringify({ arbitrationId: detail.arbitrationId, decision, reason: reason.trim(), markedAbusive: decision === 'UPHOLD_PROJECT' && markedAbusive, donationLockRiskAcknowledged: decision === 'REJECT_PROJECT' && isDonationLockRiskAcknowledged, eip712Signature })
      });
      setNotice('Đã ghi nhận phiếu xét xử và đang đồng bộ lại hồ sơ.');
      await Promise.all([loadCases(), selectCase(detail.arbitrationId)]);
    } catch (error) {
      setNotice((error as ApiErrorResponse).message || 'Không thể ghi nhận phiếu xét xử.');
    } finally {
      setIsSaving(false);
    }
  };

  const selectedCase = cases.find(item => item.arbitrationId === detail?.arbitrationId);
  const chairVoteCount = detail?.votes.filter(voteRecord => voteRecord.voterRole === 'executive_chair').length || 0;
  const memberVoteCount = detail?.votes.filter(voteRecord => voteRecord.voterRole === 'executive_member').length || 0;
  const requiredMemberVotes = selectedCase?.requiredMemberVotes || 2;
  const requiresDonationLockRiskAcknowledgement = detail?.project?.status === 'ACTIVE' && (detail.project.totalDonationAmount || 0) > 0;
  const formattedDonationAmount = new Intl.NumberFormat('vi-VN').format(detail?.project?.totalDonationAmount || 0);
  const evidenceMarkers = detail?.challenges.flatMap((challenge, challengeIndex) => challenge.evidencePhotos.map((photo, photoIndex) => ({
    id: `${challengeIndex}-${photoIndex}-${photo.cid}`,
    coordinate: { lat: photo.gps.latitude, lng: photo.gps.longitude },
    status: photo.deviationLevel === 'DEVIATED' || photo.deviationLevel === 'CRITICAL' ? 'INVALID' as const : 'VALID' as const,
    evidenceCid: photo.cid,
    distanceMeters: photo.distanceMeters,
    capturedAt: photo.capturedAt
  }))) || [];

  return <section aria-labelledby="project-verdict-title" className="min-w-0 rounded-3xl border border-slate-200/80 bg-white/90 p-4 shadow-[0_16px_35px_-28px_rgba(15,23,42,0.45)] backdrop-blur sm:p-6">
    <header className="flex flex-col gap-4 border-b border-slate-100 pb-4 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-violet-700">Hội đồng phán quyết</p>
        <h2 id="project-verdict-title" className="mt-1 text-2xl font-bold tracking-tight text-slate-950">Xét xử khiếu nại dự án</h2>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">Xem toàn bộ lập luận, chứng cứ hiện trường và lịch sử phiếu trước khi đưa ra quyết định cuối cùng.</p>
      </div>
      <span className="inline-flex w-fit items-center gap-2 rounded-full bg-violet-50 px-3 py-1.5 text-sm font-semibold text-violet-800"><span className="h-2 w-2 rounded-full bg-violet-500" />{isLoadingCases ? 'Đang đồng bộ' : cases.length + ' hồ sơ'}</span>
    </header>

    <p className="mt-4 rounded-2xl border border-violet-100 bg-violet-50 p-3 text-sm leading-6 text-violet-950 sm:p-4">Phán quyết cần phiếu Chủ tịch DAO và tối thiểu 2/4 Ủy viên cùng phía. Hết hạn mà không đủ phiếu, dự án bị từ chối theo nguyên tắc an toàn.</p>
    {notice ? <p role="status" className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm leading-6 text-amber-950">{notice}</p> : null}
    <CommitteeSeatChangeSigningPanel />

    <div className="mt-5 grid min-w-0 gap-4 lg:grid-cols-[21rem_minmax(0,1fr)] lg:gap-5">
      <aside aria-label="Danh sách hồ sơ xét xử" className="min-w-0">
        <div className="mb-3 flex items-center justify-between"><h3 className="text-sm font-bold text-slate-900">Hồ sơ cần xem xét</h3><span className="text-xs text-slate-500">Ưu tiên theo hạn</span></div>
        {isLoadingCases ? <div aria-label="Đang tải danh sách hồ sơ" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">{Array.from({ length: 3 }).map((_, index) => <div key={index} className="h-36 animate-pulse rounded-2xl border border-slate-100 bg-slate-50 p-4"><div className="h-4 w-3/4 rounded bg-slate-200" /><div className="mt-3 h-3 w-1/2 rounded bg-slate-200" /><div className="mt-7 h-8 rounded-xl bg-slate-200" /></div>)}</div> : null}
        {!isLoadingCases && cases.length === 0 ? <div className="rounded-2xl border border-dashed border-violet-200 bg-violet-50/60 px-4 py-8 text-center"><div aria-hidden="true" className="mx-auto grid h-10 w-10 place-items-center rounded-xl bg-white text-lg text-violet-700 shadow-sm">✓</div><p className="mt-3 text-sm font-semibold text-slate-900">Không có hồ sơ chờ xét xử</p><p className="mt-1 text-xs leading-5 text-slate-600">Các khiếu nại đủ điều kiện sẽ xuất hiện tại đây.</p></div> : null}
        {!isLoadingCases && cases.length > 0 ? <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">{cases.map(item => {
          const isSelected = selectedArbitrationId === item.arbitrationId;
          return <button type="button" key={item.arbitrationId} onClick={() => void selectCase(item.arbitrationId)} aria-pressed={isSelected} className={'min-w-0 rounded-2xl border p-4 text-left transition-all focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-700 ' + (isSelected ? 'border-violet-500 bg-violet-50 shadow-[0_14px_25px_-20px_rgba(109,40,217,0.9)] ring-2 ring-violet-100' : 'border-slate-200 bg-white hover:-translate-y-0.5 hover:border-violet-300 hover:shadow-sm')}>
            <div className="flex items-start justify-between gap-2"><span className="rounded-full bg-slate-100 px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-slate-600">{item.hasCurrentUserVoted ? 'Đã bỏ phiếu' : 'Chờ phiếu của bạn'}</span><span className="shrink-0 text-xs font-semibold text-rose-700">Hạn: {new Date(item.deadlineAt).toLocaleDateString('vi-VN')}</span></div>
            <span className="mt-3 block break-words text-base font-bold text-slate-950">{item.projectName}</span>
            <span className="mt-1 block break-words text-sm text-slate-600">{item.organizationName}</span>
            <dl className="mt-4 grid grid-cols-3 gap-1.5 text-center">
              <div className="rounded-lg bg-slate-50 py-2"><dt className="text-[10px] text-slate-500">Giữ</dt><dd className="mt-0.5 text-sm font-bold text-emerald-800">{item.upholdVoteCount}</dd></div>
              <div className="rounded-lg bg-slate-50 py-2"><dt className="text-[10px] text-slate-500">Hủy</dt><dd className="mt-0.5 text-sm font-bold text-rose-800">{item.rejectVoteCount}</dd></div>
              <div className="rounded-lg bg-slate-50 py-2"><dt className="text-[10px] text-slate-500">Khiếu nại</dt><dd className="mt-0.5 text-sm font-bold text-slate-900">{item.challengeCount}</dd></div>
            </dl>
          </button>;
        })}</div> : null}
      </aside>

      <section aria-live="polite" className="min-w-0">
        {isLoadingDetail ? <div aria-label="Đang tải chi tiết hồ sơ" className="animate-pulse rounded-2xl border border-violet-100 bg-violet-50/60 p-4 sm:p-5"><div className="h-3 w-28 rounded bg-violet-200" /><div className="mt-3 h-7 w-2/3 rounded bg-violet-200" /><div className="mt-3 h-4 w-full rounded bg-violet-100" /><div className="mt-5 h-44 rounded-2xl bg-white" /><div className="mt-4 h-40 rounded-2xl bg-white" /></div> : null}
        {detail ? <div className="space-y-5">
          <header className="rounded-2xl bg-gradient-to-br from-slate-950 to-slate-800 p-4 text-white sm:p-5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><div className="min-w-0"><p className="text-xs font-bold uppercase tracking-[0.14em] text-violet-200">Hồ sơ phán quyết</p><h3 className="mt-2 break-words text-xl font-bold">{detail.project?.name || 'Dự án không còn tồn tại'}</h3><p className="mt-1 break-words text-sm text-slate-300">{detail.project?.organizationName}</p></div>{detail.activationState ? <span className="w-fit rounded-full bg-white/10 px-3 py-1.5 text-xs font-semibold text-violet-100">{detail.activationState}</span> : null}</div>
            <p className="mt-4 break-words text-sm leading-6 text-slate-200">{detail.project?.description || 'Không còn mô tả dự án.'}</p>
          </header>

          <section className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-2xl border border-violet-200 bg-violet-50 p-4"><p className="text-xs font-bold uppercase tracking-[0.14em] text-violet-700">Tiến độ đồng thuận</p><div className="mt-3 grid grid-cols-2 gap-2"><div className="rounded-xl bg-white p-3"><p className="text-xs text-slate-500">Phiếu Chủ tịch</p><p className="mt-1 text-xl font-bold text-slate-950">{chairVoteCount}/1</p></div><div className="rounded-xl bg-white p-3"><p className="text-xs text-slate-500">Phiếu Ủy viên</p><p className="mt-1 text-xl font-bold text-slate-950">{memberVoteCount}/{requiredMemberVotes}</p></div></div>{memberVoteCount >= requiredMemberVotes && chairVoteCount === 0 ? <p className="mt-3 rounded-xl bg-amber-100 px-3 py-2 text-sm font-semibold text-amber-950">Đã đủ phiếu Ủy viên nhưng vẫn cần chữ ký Chủ tịch DAO.</p> : <p className="mt-3 text-sm text-violet-950">Cần Chủ tịch DAO và tối thiểu {requiredMemberVotes} Ủy viên cùng một phán quyết.</p>}</div>
            <div className="rounded-2xl border border-slate-200 bg-white p-4"><p className="text-xs font-bold uppercase tracking-[0.14em] text-violet-700">Cảnh báo GPS</p><div className="mt-3 flex flex-wrap gap-2">{detail.challenges.flatMap(challenge => challenge.evidencePhotos).map((photo, index) => photo.deviationLevel ? <EvidenceDeviationBadge key={`${photo.cid}-${index}`} deviationLevel={photo.deviationLevel} distanceMeters={photo.distanceMeters} accuracyMeters={photo.accuracyMeters} /> : null)}</div>{evidenceMarkers.length === 0 ? <p className="mt-3 text-sm text-slate-600">Chưa có ảnh định vị để hiển thị trên bản đồ.</p> : null}</div>
          </section>

          {detail.project ? <section className="min-w-0 overflow-hidden rounded-2xl border border-slate-200 bg-white p-3 sm:p-4"><div className="flex flex-wrap items-center justify-between gap-2"><div><p className="text-xs font-bold uppercase tracking-[0.14em] text-violet-700">Bản đồ đối chiếu</p><h4 className="mt-1 font-bold text-slate-950">Vùng dự án và ảnh khiếu nại</h4></div><span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700">{evidenceMarkers.length} điểm chứng cứ</span></div><div className="mt-3"><GeofenceMapLazy projectId={detail.project.projectId} markers={evidenceMarkers} /></div></section> : null}

          <section><div className="flex flex-wrap items-center justify-between gap-2"><div><p className="text-xs font-bold uppercase tracking-[0.14em] text-violet-700">Nội dung khiếu nại</p><h4 className="mt-1 font-bold text-slate-950">Lập luận và bằng chứng</h4></div><span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">{detail.challenges.length} khiếu nại</span></div>
            {detail.challenges.length > 0 ? <div className="mt-3 space-y-3">{detail.challenges.map((challenge, index) => <article key={challenge.challengerName + '-' + index} className="min-w-0 rounded-2xl border border-slate-200 bg-white p-4">
              <div className="flex flex-wrap items-center justify-between gap-2"><p className="break-words font-bold text-slate-900">{challenge.challengerName}</p><span className="rounded-full bg-rose-50 px-2.5 py-1 text-xs font-semibold text-rose-800">Khiếu nại #{index + 1}</span></div>
              <p className="my-3 break-words text-sm leading-6 text-slate-700">{challenge.reason}</p>
              <ChallengeEvidenceGallery photos={challenge.evidencePhotos || []} />
            </article>)}</div> : <p className="mt-3 rounded-xl border border-dashed border-slate-200 p-4 text-sm text-slate-600">Hồ sơ này không còn dữ liệu khiếu nại để hiển thị.</p>}
          </section>

          <section><div><p className="text-xs font-bold uppercase tracking-[0.14em] text-violet-700">Sổ phiếu snapshot</p><h4 className="mt-1 font-bold text-slate-950">Trạng thái biểu quyết của Ủy ban</h4></div>
            <ul className="mt-3 grid gap-2 sm:grid-cols-2">{detail.committeeSnapshot.map(member => {
              const voteRecord = detail.votes.find(voteRecordItem => voteRecordItem.voterUserId === member.userId);
              const roleLabel = member.role === 'executive_chair' ? 'Chủ tịch DAO' : 'Ủy viên Điều hành';
              return <li key={member.userId} className="min-w-0 rounded-xl border border-slate-100 bg-slate-50 p-3"><div className="flex flex-wrap items-center justify-between gap-2"><span className="break-all text-sm font-bold text-slate-900">{voteRecord?.voterName || member.userId}</span><span className={'rounded-full px-2 py-1 text-[10px] font-bold ' + (voteRecord ? voteRecord.decision === 'UPHOLD_PROJECT' ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800' : 'bg-slate-200 text-slate-600')}>{voteRecord ? voteRecord.decision === 'UPHOLD_PROJECT' ? 'GIỮ DỰ ÁN' : 'TỪ CHỐI DỰ ÁN' : 'CHƯA BỎ PHIẾU'}</span></div><p className="mt-1 text-xs text-slate-500">{roleLabel}</p>{voteRecord ? <p className="mt-2 break-words text-xs leading-5 text-slate-600">{voteRecord.reason}</p> : null}</li>;
            })}</ul>
          </section>

          <section className="rounded-2xl border border-violet-200 bg-gradient-to-br from-violet-50 to-white p-4 sm:p-5"><div><p className="text-xs font-bold uppercase tracking-[0.14em] text-violet-700">Phiếu của bạn</p><h4 className="mt-1 font-bold text-slate-950">Đưa ra phán quyết có căn cứ</h4></div>
            <label className="mt-4 block text-sm font-bold text-slate-800">Lý do phán quyết
              <textarea aria-label="Lý do phán quyết" className="mt-2 min-h-28 w-full rounded-xl border border-violet-200 bg-white p-3 text-base font-normal leading-6 outline-none transition-colors placeholder:text-slate-400 focus:border-violet-500 focus:ring-2 focus:ring-violet-100" value={reason} onChange={event => setReason(event.target.value)} minLength={10} maxLength={500} placeholder="Nêu căn cứ phán quyết (ít nhất 10 ký tự)" />
            </label>
            <label className="mt-3 flex items-start gap-3 rounded-xl border border-violet-100 bg-white/70 p-3 text-sm leading-5 text-slate-700"><input type="checkbox" checked={markedAbusive} onChange={event => setMarkedAbusive(event.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 accent-violet-700" /><span>Đánh dấu khiếu nại này là quấy rối nếu quyết định bác khiếu nại.</span></label>
            <div className="mt-4 grid grid-cols-1 gap-2 sm:flex"><button type="button" disabled={isSaving} onClick={() => void vote('UPHOLD_PROJECT')} className="min-h-11 rounded-xl bg-emerald-700 px-4 py-2 text-sm font-bold text-white transition-colors hover:bg-emerald-800 disabled:cursor-wait disabled:opacity-50">{isSaving ? 'Đang gửi phiếu…' : 'Bác khiếu nại'}</button><button type="button" disabled={isSaving} onClick={() => setIsRejectConfirmationOpen(true)} className="min-h-11 rounded-xl bg-rose-700 px-4 py-2 text-sm font-bold text-white transition-colors hover:bg-rose-800 disabled:cursor-wait disabled:opacity-50">Hủy dự án</button></div>
            {isRejectConfirmationOpen ? <div role="dialog" aria-modal="true" aria-label="Xác nhận hủy dự án" className="mt-4 rounded-2xl border border-rose-300 bg-rose-50 p-4"><p className="font-bold text-rose-950">Xác nhận phán quyết không thể đảo ngược</p><p className="mt-1 text-sm leading-6 text-rose-900">Phiếu hủy dự án sẽ góp phần khóa vĩnh viễn hồ sơ khi đạt đồng thuận. Hãy xác nhận bạn đã kiểm tra chứng cứ và bản đồ GPS.</p>{requiresDonationLockRiskAcknowledgement ? <label className="mt-3 flex items-start gap-3 rounded-xl border border-rose-200 bg-white p-3 text-sm leading-5 text-rose-950"><input type="checkbox" checked={isDonationLockRiskAcknowledged} onChange={event => setIsDonationLockRiskAcknowledged(event.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 accent-rose-700" /><span>Dự án này đã nhận <strong>{formattedDonationAmount} VND</strong>. Tôi hiểu rằng hủy dự án sẽ khóa vĩnh viễn khoản tiền này trong hợp đồng; không giải ngân được và không có cơ chế hoàn tiền tự động.</span></label> : null}<div className="mt-4 flex flex-wrap gap-2"><button type="button" onClick={() => setIsRejectConfirmationOpen(false)} className="min-h-10 rounded-xl border border-rose-200 bg-white px-3 py-2 text-sm font-bold text-rose-900">Quay lại</button><button type="button" disabled={isSaving || (requiresDonationLockRiskAcknowledgement && !isDonationLockRiskAcknowledged)} onClick={() => { setIsRejectConfirmationOpen(false); void vote('REJECT_PROJECT'); }} className="min-h-10 rounded-xl bg-rose-700 px-3 py-2 text-sm font-bold text-white disabled:opacity-50">Xác nhận hủy vĩnh viễn</button></div></div> : null}
          </section>
        </div> : null}
        {!isLoadingDetail && !detail ? <div className="grid min-h-72 place-items-center rounded-2xl border border-dashed border-violet-200 bg-violet-50/40 p-6 text-center"><div><div aria-hidden="true" className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-white text-xl text-violet-700 shadow-sm">↗</div><h3 className="mt-4 font-bold text-slate-900">Chọn một hồ sơ để bắt đầu</h3><p className="mx-auto mt-1 max-w-sm text-sm leading-6 text-slate-600">Toàn bộ khiếu nại, chứng cứ và lịch sử phiếu sẽ được hiển thị tại đây.</p></div></div> : null}
      </section>
    </div>
  </section>;
}
