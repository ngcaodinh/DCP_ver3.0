'use client';

import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react';
import { buildSameOriginApiUrl, fetchApi, getApiErrorMessage } from '@/app/utils/apiClient';
import { readAuthSession } from '@/app/utils/authSession';
import { ChallengeEvidenceGallery } from './ChallengeEvidenceGallery';
import { CommitteeSeatChangeSigningPanel } from './CommitteeSeatChangeSigningPanel';
import { EvidenceDeviationBadge } from './EvidenceDeviationBadge';
import { ProjectVerdictVotingActions } from './ProjectVerdictVotingActions';
import { GeofenceMapLazy } from '../oracle/GeofenceMapLazy';

interface ArbitrationCase {
  arbitrationId: string;
  projectId: string;
  projectName: string;
  organizationName: string;
  deadlineAt: string;
  challengeCount: number;
  upholdVoteCount: number;
  rejectVoteCount: number;
  requiredMemberVotes?: number;
  hasCurrentUserVoted: boolean;
}

interface CaseDetail {
  arbitrationId: string;
  activationState?: string;
  geofence: { polygon: Array<{ lat: number; lng: number }> } | null;
  committeeSnapshot: Array<{ userId: string; role: string }>;
  votes: Array<{ voterUserId: string; voterName: string; voterRole: string; decision: string; reason: string }>;
  challenges: Array<{
    challengerName: string;
    reason: string;
    evidencePhotos: Array<{
      cid: string;
      capturedAt: string;
      gps: { latitude: number; longitude: number };
      accuracyMeters: number;
      distanceMeters: number | null;
      deviationLevel: 'INSIDE' | 'WITHIN_ACCURACY' | 'DEVIATED' | 'CRITICAL' | 'NO_GEOFENCE';
      isLowAccuracyOverride: boolean;
      lowAccuracyReason: string | null;
    }>;
  }>;
  project: { projectId?: string; name: string; description: string; organizationName: string; status?: string; totalDonationAmount?: number } | null;
}

/** Lấy header phiên hiện tại mà không lưu dữ liệu server vào client store. */
function getAuthorizationHeaders(): HeadersInit {
  const token = readAuthSession().accessToken;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Portal xử lý khiếu nại cũ, dùng chung action ký EIP-712 với hàng đợi dự án chờ công bố. */
export default function ExecutivePortalClient(): ReactElement {
  const [cases, setCases] = useState<ArbitrationCase[]>([]);
  const [detail, setDetail] = useState<CaseDetail | null>(null);
  const [notice, setNotice] = useState('');
  const [isLoadingCases, setIsLoadingCases] = useState(true);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const [selectedArbitrationId, setSelectedArbitrationId] = useState<string | null>(null);
  const detailRequestVersionRef = useRef(0);

  /** Tải lại danh sách để trạng thái phiếu của card luôn đồng bộ với chi tiết. */
  const loadCases = useCallback(async (): Promise<void> => {
    setIsLoadingCases(true);
    try {
      const response = await fetchApi<ArbitrationCase[]>(
        buildSameOriginApiUrl('/api/project-governance/executive/cases'),
        { headers: getAuthorizationHeaders() }
      );
      setCases(response.data);
    } catch (error) {
      setNotice(getApiErrorMessage(error, 'Không thể tải hồ sơ xét xử.'));
    } finally {
      setIsLoadingCases(false);
    }
  }, []);

  useEffect(() => { void loadCases(); }, [loadCases]);

  /** Bỏ qua response cũ nếu người dùng đã chọn một hồ sơ khác trong lúc API đang trả về. */
  const selectCase = async (arbitrationId: string): Promise<void> => {
    const requestVersion = detailRequestVersionRef.current + 1;
    detailRequestVersionRef.current = requestVersion;
    setSelectedArbitrationId(arbitrationId);
    setDetail(null);
    setIsLoadingDetail(true);
    try {
      const response = await fetchApi<CaseDetail>(
        buildSameOriginApiUrl(`/api/project-governance/executive/cases/${encodeURIComponent(arbitrationId)}`),
        { headers: getAuthorizationHeaders() }
      );
      if (requestVersion === detailRequestVersionRef.current) setDetail(response.data);
    } catch (error) {
      if (requestVersion === detailRequestVersionRef.current) {
        setNotice(getApiErrorMessage(error, 'Không thể tải chi tiết hồ sơ.'));
      }
    } finally {
      if (requestVersion === detailRequestVersionRef.current) setIsLoadingDetail(false);
    }
  };

  const selectedCase = cases.find(item => item.arbitrationId === detail?.arbitrationId);
  const canCurrentUserVote = Boolean(
    selectedCase && !selectedCase.hasCurrentUserVoted && new Date(selectedCase.deadlineAt) > new Date()
  );
  const upholdChairVoteCount = detail?.votes.filter(vote => vote.decision === 'UPHOLD_PROJECT' && vote.voterRole === 'executive_chair').length || 0;
  const upholdMemberVoteCount = detail?.votes.filter(vote => vote.decision === 'UPHOLD_PROJECT' && vote.voterRole === 'executive_member').length || 0;
  const rejectVoteCount = detail?.votes.filter(vote => vote.decision === 'REJECT_PROJECT').length || 0;
  const requiredMemberVotes = selectedCase?.requiredMemberVotes || 2;
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
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-[#0E7C6B]">Hội đồng phán quyết</p>
        <h2 id="project-verdict-title" className="mt-1 text-2xl font-bold tracking-tight text-slate-950">Xét xử khiếu nại dự án</h2>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">Xem lập luận, chứng cứ hiện trường và lịch sử phiếu trước khi đưa ra quyết định.</p>
      </div>
      <span className="inline-flex w-fit items-center gap-2 rounded-full bg-emerald-50 px-3 py-1.5 text-sm font-semibold text-[#0A5C50]"><span className="h-2 w-2 rounded-full bg-[#0E7C6B]" />{isLoadingCases ? 'Đang đồng bộ' : `${cases.length} hồ sơ`}</span>
    </header>

    <p className="mt-4 rounded-2xl border border-emerald-100 bg-emerald-50 p-3 text-sm leading-6 text-emerald-950 sm:p-4">Tiếp tục dự án cần Chủ tịch DAO và tối thiểu 2/4 Ủy viên cùng phía. Hủy dự án chỉ có hiệu lực khi đủ 5/5 ghế snapshot cùng ký.</p>
    {notice ? <p role="status" className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm leading-6 text-amber-950">{notice}</p> : null}
    <CommitteeSeatChangeSigningPanel />

    <div className="mt-5 grid min-w-0 gap-4 lg:grid-cols-[21rem_minmax(0,1fr)] lg:gap-5">
      <aside aria-label="Danh sách hồ sơ xét xử" className="min-w-0">
        <div className="mb-3 flex items-center justify-between"><h3 className="text-sm font-bold text-slate-900">Hồ sơ cần xem xét</h3><span className="text-xs text-slate-500">Ưu tiên theo hạn</span></div>
        {isLoadingCases ? <div aria-label="Đang tải danh sách hồ sơ" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">{Array.from({ length: 3 }).map((_, index) => <div key={index} className="h-36 animate-pulse rounded-2xl border border-slate-100 bg-slate-50 p-4" />)}</div> : null}
        {!isLoadingCases && cases.length === 0 ? <p className="rounded-2xl border border-dashed border-emerald-200 bg-emerald-50/60 px-4 py-8 text-center text-sm text-slate-600">Không có hồ sơ chờ xét xử.</p> : null}
        {!isLoadingCases && cases.length > 0 ? <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">{cases.map(item => {
          const isSelected = selectedArbitrationId === item.arbitrationId;
          return <button type="button" key={item.arbitrationId} onClick={() => void selectCase(item.arbitrationId)} aria-pressed={isSelected} className={`min-w-0 rounded-2xl border p-4 text-left transition-all focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0E7C6B] ${isSelected ? 'border-[#0E7C6B] bg-emerald-50 ring-2 ring-emerald-100' : 'border-slate-200 bg-white hover:border-emerald-300'}`}>
            <div className="flex items-start justify-between gap-2"><span className="rounded-full bg-slate-100 px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-slate-600">{item.hasCurrentUserVoted ? 'Đã bỏ phiếu' : 'Chờ phiếu của bạn'}</span><span className="shrink-0 text-xs font-semibold text-rose-700">Hạn: {new Date(item.deadlineAt).toLocaleDateString('vi-VN')}</span></div>
            <span className="mt-3 block break-words text-base font-bold text-slate-950">{item.projectName}</span>
            <span className="mt-1 block break-words text-sm text-slate-600">{item.organizationName}</span>
            <dl className="mt-4 grid grid-cols-3 gap-1.5 text-center"><div className="rounded-lg bg-slate-50 py-2"><dt className="text-[10px] text-slate-500">Giữ</dt><dd className="mt-0.5 text-sm font-bold text-emerald-800">{item.upholdVoteCount}</dd></div><div className="rounded-lg bg-slate-50 py-2"><dt className="text-[10px] text-slate-500">Hủy</dt><dd className="mt-0.5 text-sm font-bold text-rose-800">{item.rejectVoteCount}</dd></div><div className="rounded-lg bg-slate-50 py-2"><dt className="text-[10px] text-slate-500">Khiếu nại</dt><dd className="mt-0.5 text-sm font-bold text-slate-900">{item.challengeCount}</dd></div></dl>
          </button>;
        })}</div> : null}
      </aside>

      <div aria-live="polite" className="min-w-0">
        {isLoadingDetail ? <div aria-label="Đang tải chi tiết hồ sơ" className="h-72 animate-pulse rounded-2xl border border-emerald-100 bg-emerald-50/60 p-4" /> : null}
        {detail ? <div className="space-y-5">
          <header className="rounded-2xl bg-gradient-to-br from-slate-950 to-slate-800 p-4 text-white sm:p-5"><div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><div className="min-w-0"><p className="text-xs font-bold uppercase tracking-[0.14em] text-emerald-200">Hồ sơ phán quyết</p><h3 className="mt-2 break-words text-xl font-bold">{detail.project?.name || 'Dự án không còn tồn tại'}</h3><p className="mt-1 break-words text-sm text-slate-300">{detail.project?.organizationName}</p></div>{detail.activationState ? <span className="w-fit rounded-full bg-white/10 px-3 py-1.5 text-xs font-semibold text-emerald-100">{detail.activationState}</span> : null}</div><p className="mt-4 break-words text-sm leading-6 text-slate-200">{detail.project?.description || 'Không còn mô tả dự án.'}</p></header>

          <div className="grid gap-3 sm:grid-cols-2"><div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4"><p className="text-xs font-bold uppercase tracking-[0.14em] text-[#0E7C6B]">Tiến độ đồng thuận</p><div className="mt-3 grid grid-cols-2 gap-2"><div className="rounded-xl bg-white p-3"><p className="text-xs text-slate-500">Tiếp tục · Chủ tịch</p><p className="mt-1 text-xl font-bold text-slate-950">{upholdChairVoteCount}/1</p></div><div className="rounded-xl bg-white p-3"><p className="text-xs text-slate-500">Tiếp tục · Ủy viên</p><p className="mt-1 text-xl font-bold text-slate-950">{upholdMemberVoteCount}/{requiredMemberVotes}</p></div></div>{upholdMemberVoteCount >= requiredMemberVotes && upholdChairVoteCount === 0 ? <p className="mt-3 rounded-xl bg-amber-100 px-3 py-2 text-sm font-semibold text-amber-950">Đã đủ phiếu Ủy viên nhưng vẫn cần chữ ký Chủ tịch DAO.</p> : <p className="mt-3 text-sm text-emerald-950">Tiếp tục cần Chủ tịch DAO và tối thiểu {requiredMemberVotes} Ủy viên. Đồng ý hủy hiện có {rejectVoteCount}/5; chỉ hủy khi đủ 5/5.</p>}</div><div className="rounded-2xl border border-slate-200 bg-white p-4"><p className="text-xs font-bold uppercase tracking-[0.14em] text-[#0E7C6B]">Cảnh báo GPS</p><div className="mt-3 flex flex-wrap gap-2">{detail.challenges.flatMap(challenge => challenge.evidencePhotos).map((photo, index) => <EvidenceDeviationBadge key={`${photo.cid}-${index}`} deviationLevel={photo.deviationLevel} distanceMeters={photo.distanceMeters} accuracyMeters={photo.accuracyMeters} />)}</div>{evidenceMarkers.length === 0 ? <p className="mt-3 text-sm text-slate-600">Chưa có ảnh định vị để hiển thị trên bản đồ.</p> : null}</div></div>

          {detail.project?.projectId ? <section className="min-w-0 overflow-hidden rounded-2xl border border-slate-200 bg-white p-3 sm:p-4"><div className="flex flex-wrap items-center justify-between gap-2"><div><p className="text-xs font-bold uppercase tracking-[0.14em] text-[#0E7C6B]">Bản đồ đối chiếu</p><h4 className="mt-1 font-bold text-slate-950">Vùng dự án và ảnh khiếu nại</h4></div><span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700">{evidenceMarkers.length} điểm chứng cứ</span></div><div className="mt-3"><GeofenceMapLazy projectId={detail.project.projectId} markers={evidenceMarkers} /></div></section> : null}

          <section><div className="flex flex-wrap items-center justify-between gap-2"><div><p className="text-xs font-bold uppercase tracking-[0.14em] text-[#0E7C6B]">Nội dung khiếu nại</p><h4 className="mt-1 font-bold text-slate-950">Lập luận và bằng chứng</h4></div><span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">{detail.challenges.length} khiếu nại</span></div>{detail.challenges.length > 0 ? <div className="mt-3 space-y-3">{detail.challenges.map((challenge, index) => <article key={`${challenge.challengerName}-${index}`} className="min-w-0 rounded-2xl border border-slate-200 bg-white p-4"><div className="flex flex-wrap items-center justify-between gap-2"><p className="break-words font-bold text-slate-900">{challenge.challengerName}</p><span className="rounded-full bg-rose-50 px-2.5 py-1 text-xs font-semibold text-rose-800">Khiếu nại #{index + 1}</span></div><p className="my-3 break-words text-sm leading-6 text-slate-700">{challenge.reason}</p><ChallengeEvidenceGallery photos={challenge.evidencePhotos || []} /></article>)}</div> : <p className="mt-3 rounded-xl border border-dashed border-slate-200 p-4 text-sm text-slate-600">Hồ sơ này không còn dữ liệu khiếu nại để hiển thị.</p>}</section>

          <section><p className="text-xs font-bold uppercase tracking-[0.14em] text-[#0E7C6B]">Sổ phiếu snapshot</p><h4 className="mt-1 font-bold text-slate-950">Trạng thái biểu quyết của Ủy ban</h4><ul className="mt-3 grid gap-2 sm:grid-cols-2">{detail.committeeSnapshot.map(member => { const vote = detail.votes.find(item => item.voterUserId === member.userId); return <li key={member.userId} className="min-w-0 rounded-xl border border-slate-100 bg-slate-50 p-3"><div className="flex flex-wrap items-center justify-between gap-2"><span className="break-all text-sm font-bold text-slate-900">{vote?.voterName || member.userId}</span><span className={`rounded-full px-2 py-1 text-[10px] font-bold ${vote ? vote.decision === 'UPHOLD_PROJECT' ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800' : 'bg-slate-200 text-slate-600'}`}>{vote ? vote.decision === 'UPHOLD_PROJECT' ? 'GIỮ DỰ ÁN' : 'TỪ CHỐI DỰ ÁN' : 'CHƯA BỎ PHIẾU'}</span></div><p className="mt-1 text-xs text-slate-500">{member.role === 'executive_chair' ? 'Chủ tịch DAO' : 'Ủy viên Điều hành'}</p>{vote ? <p className="mt-2 break-words text-xs leading-5 text-slate-600">{vote.reason}</p> : null}</li>; })}</ul></section>

          {detail.project ? <ProjectVerdictVotingActions arbitrationId={detail.arbitrationId} canVote={canCurrentUserVote} project={{ status: detail.project.status || '', totalDonationAmount: detail.project.totalDonationAmount || 0 }} upholdLabel="Bác khiếu nại" onVoted={async () => { await Promise.all([loadCases(), selectCase(detail.arbitrationId)]); }} /> : null}
        </div> : null}
        {!isLoadingDetail && !detail ? <div className="grid min-h-72 place-items-center rounded-2xl border border-dashed border-emerald-200 bg-emerald-50/40 p-6 text-center text-sm text-slate-600">Chọn một hồ sơ để bắt đầu.</div> : null}
      </div>
    </div>
  </section>;
}
