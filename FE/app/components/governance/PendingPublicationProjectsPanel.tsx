'use client';

import { type ReactElement, useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { buildSameOriginApiUrl, fetchApi, getApiErrorMessage } from '@/app/utils/apiClient';
import { readAuthSession } from '@/app/utils/authSession';
import IpfsEvidencePreviewCard from '@/app/components/common/IpfsEvidencePreviewCard';
import { ChallengeEvidenceGallery, type EvidencePhoto } from './ChallengeEvidenceGallery';
import { EvidenceDeviationBadge } from './EvidenceDeviationBadge';
import { GeofenceMapLazy } from '../oracle/GeofenceMapLazy';
import { ProjectVerdictVotingActions } from './ProjectVerdictVotingActions';
import type {
  ExecutiveCursorPage,
  ExecutiveEvidencePhoto,
  ExecutivePendingPublicationProjectDetail,
  ExecutivePendingPublicationProjectSummary
} from '@/app/types/executiveCommitteeProjects';

/** Đọc access token ngay khi query chạy để phiên đăng nhập mới được dùng cho request kế tiếp. */
function getGovernanceHeaders(): HeadersInit {
  const token = readAuthSession().accessToken;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Đọc một page queue chờ công bố từ endpoint nội bộ có RBAC Ủy ban. */
async function fetchPendingPublicationProjects(cursor: string | null): Promise<ExecutiveCursorPage<ExecutivePendingPublicationProjectSummary>> {
  const response = await fetchApi<ExecutiveCursorPage<ExecutivePendingPublicationProjectSummary>>(
    buildSameOriginApiUrl(`/api/project-governance/executive/pending-activation-projects?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`),
    { headers: getGovernanceHeaders() }
  );
  return response.data;
}

/** Đọc detail queue theo projectId; query key tách biệt ngăn response cũ ghi đè card mới. */
async function fetchPendingPublicationProjectDetail(projectId: string): Promise<ExecutivePendingPublicationProjectDetail> {
  const response = await fetchApi<ExecutivePendingPublicationProjectDetail>(
    buildSameOriginApiUrl(`/api/project-governance/executive/pending-activation-projects/${encodeURIComponent(projectId)}`),
    { headers: getGovernanceHeaders() }
  );
  return response.data;
}

/** Biến evidence DTO sang gallery để tái sử dụng fallback gateway, hiển thị GPS và low-accuracy flag. */
function toGalleryPhotos(photos: ExecutiveEvidencePhoto[], sourceLabel: string): EvidencePhoto[] {
  return photos.map(photo => ({
    cid: photo.cid,
    capturedAt: photo.capturedAt,
    gps: photo.gps ? { latitude: photo.gps.lat, longitude: photo.gps.lng } : null,
    accuracyMeters: photo.accuracyMeters,
    distanceMeters: photo.distanceMeters,
    distanceToProjectCenterMeters: photo.distanceToProjectCenterMeters,
    deviationLevel: photo.deviationLevel,
    isLowAccuracyOverride: photo.isLowAccuracyOverride,
    lowAccuracyReason: photo.lowAccuracyReason,
    sourceLabel
  }));
}

/** Định dạng tiền theo VND, chỉ nhận số đã được backend aggregate từ donation INDEXED. */
function formatVnd(amount: number): string {
  return `${new Intl.NumberFormat('vi-VN').format(Math.max(0, amount || 0))} VND`;
}

/** Hiển thị mốc niêm yết/kích hoạt an toàn khi backend chưa có timestamp lịch sử. */
function formatPublicationSchedule(value: string | null | undefined, labelWhenPassed: string): string {
  if (!value) return 'Chưa xác định thời điểm';
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) return 'Chưa xác định thời điểm';
  const formatted = timestamp.toLocaleString('vi-VN');
  const remainingMs = timestamp.getTime() - Date.now();
  if (remainingMs <= 0) return `${labelWhenPassed}: ${formatted}`;
  const remainingMinutes = Math.ceil(remainingMs / (60 * 1000));
  const remainingLabel = remainingMinutes < 60
    ? `${remainingMinutes} phút`
    : `${Math.ceil(remainingMinutes / 60)} giờ`;
  return `Còn ${remainingLabel} · ${formatted}`;
}

/** Định dạng timestamp lịch sử không gắn trạng thái tiến trình để dùng cho ngày duyệt KYC. */
function formatDateTime(value: string | null | undefined): string {
  if (!value) return 'Chưa có thời điểm';
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? 'Chưa có thời điểm' : timestamp.toLocaleString('vi-VN');
}

/** Chuyển mã kiểm tra toàn vẹn thành thông báo nghiệp vụ, không để mã kỹ thuật rơi vào UI. */
function formatIntegrityIssue(issue: ExecutivePendingPublicationProjectDetail['integrityIssues'][number]): string {
  return issue === 'MISSING_CHALLENGE'
    ? 'Thiếu khiếu nại Auditor gốc của vòng hiện tại.'
    : 'Thiếu hồ sơ xét xử tương ứng với dự án đang tranh chấp.';
}

/** Chỉ đọc trường milestone được công bố để dữ liệu cũ sai shape không phá vỡ màn hình xét duyệt. */
function getMilestoneLabel(item: unknown, index: number): string {
  if (!item || typeof item !== 'object') return `Mốc ${index + 1}: Chưa có mô tả`;
  const milestone = item as { milestoneKey?: unknown; description?: unknown; percentage?: unknown };
  const key = typeof milestone.milestoneKey === 'string' ? milestone.milestoneKey : `Mốc ${index + 1}`;
  const description = typeof milestone.description === 'string' && milestone.description.trim() ? milestone.description : 'Chưa có mô tả';
  const percentage = typeof milestone.percentage === 'number' && Number.isFinite(milestone.percentage) ? ` · ${milestone.percentage}%` : '';
  return `${key}${percentage}: ${description}`;
}

/** Hiển thị nhãn evidence mode mà không để frontend tự suy ra precedence bằng độ dài array. */
function EvidenceModeBadge({ mode }: { mode: ExecutivePendingPublicationProjectSummary['evidence']['mode'] }): ReactElement {
  const metadata = {
    CHALLENGE: { label: 'Có khiếu nại Auditor', className: 'border-rose-200 bg-rose-50 text-rose-900' },
    VERIFICATION: { label: 'Đã xác minh thực địa', className: 'border-emerald-200 bg-emerald-50 text-emerald-800' },
    UNVERIFIED: { label: 'Chưa có evidence Auditor', className: 'border-slate-200 bg-slate-50 text-slate-700' }
  } as const;
  const current = metadata[mode];
  return <span className={`inline-flex rounded-full border px-2.5 py-1 text-[11px] font-bold ${current.className}`}>{current.label}</span>;
}

/** Hiển thị trạng thái KYC đã redacted, không render tài liệu, email, ngân hàng hay mã pháp lý. */
function KycBadge({ status }: { status: ExecutivePendingPublicationProjectSummary['kyc']['status'] }): ReactElement {
  const className = status === 'APPROVED' ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : status === 'NOT_SUBMITTED' ? 'border-slate-200 bg-slate-50 text-slate-600' : 'border-amber-200 bg-amber-50 text-amber-900';
  const label = status === 'APPROVED'
    ? 'KYC đã phê duyệt'
    : status === 'NOT_SUBMITTED'
      ? 'KYC chưa nộp'
      : `KYC: ${status}`;
  return <span className={`inline-flex rounded-full border px-2 py-1 text-[11px] font-semibold ${className}`}>{label}</span>;
}

/** Hiển thị queue PENDING_ACTIVATION/DISPUTED và detail evidence đúng vòng cho cả Chair lẫn Member. */
export function PendingPublicationProjectsPanel(): ReactElement {
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const viewerUserId = readAuthSession().userId || 'anonymous';
  const projectsQuery = useInfiniteQuery({
    queryKey: ['executivePendingPublicationProjects', viewerUserId],
    queryFn: ({ pageParam }) => fetchPendingPublicationProjects(pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: page => page.nextCursor,
    retry: false
  });
  const detailQuery = useQuery({
    queryKey: ['executivePendingPublicationProjectDetail', viewerUserId, selectedProjectId],
    queryFn: () => fetchPendingPublicationProjectDetail(selectedProjectId!),
    enabled: Boolean(selectedProjectId),
    retry: false
  });
  const projects = projectsQuery.data?.pages.flatMap(page => page.items) || [];
  const detail = detailQuery.data || null;
  const isListUnavailable = projectsQuery.isError && projects.length === 0;
  const listNotice = projectsQuery.isError ? getApiErrorMessage(projectsQuery.error, 'Không thể tải dự án chờ công bố.') : '';
  const detailNotice = detailQuery.isError ? getApiErrorMessage(detailQuery.error, 'Không thể tải chi tiết dự án chờ công bố.') : '';
  const evidenceRecordLabel = detail?.evidence.mode === 'CHALLENGE' ? 'Nội dung khiếu nại Auditor' : 'Xác minh thực địa Auditor';
  const evidencePhotoLabel = detail?.evidence.mode === 'CHALLENGE' ? 'Ảnh khiếu nại Auditor' : 'Ảnh xác minh thực địa';
  const detailIntegrityIssues = detail?.integrityIssues || [];
  const mapMarkers = detail?.evidence.records.flatMap(record => record.evidencePhotos.map((photo, index) => ({
    id: `${record.recordId}-${photo.cid}-${index}`,
    coordinate: photo.gps,
    status: !detail.geofence || !photo.gps ? 'NO_GPS' as const : photo.isInsideGeofence ? 'VALID' as const : 'INVALID' as const,
    evidenceCid: photo.cid,
    distanceMeters: photo.distanceMeters,
    distanceToProjectCenterMeters: photo.distanceToProjectCenterMeters,
    capturedAt: photo.capturedAt || undefined
  }))) || [];

  /** Làm mới queue, detail và danh sách case cũ sau khi signature được backend ghi nhận. */
  const refreshAfterVote = async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['executivePendingPublicationProjects'] }),
      queryClient.invalidateQueries({ queryKey: ['executivePendingPublicationProjectDetail', viewerUserId, selectedProjectId] }),
      queryClient.invalidateQueries({ queryKey: ['executiveArbitrationCases'] })
    ]);
  };

  return <section aria-labelledby="pending-publication-projects-title" className="min-w-0 rounded-3xl border border-slate-200/80 bg-white/90 p-4 shadow-[0_16px_35px_-28px_rgba(15,23,42,0.45)] backdrop-blur sm:p-6">
    <header className="flex flex-col gap-4 border-b border-slate-100 pb-4 sm:flex-row sm:items-end sm:justify-between"><div><p className="text-xs font-bold uppercase tracking-[0.16em] text-[#0E7C6B]">Niêm yết lạc quan</p><h2 id="pending-publication-projects-title" className="mt-1 text-2xl font-bold tracking-tight text-slate-950">Dự án chờ công bố</h2><p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">Chỉ hiển thị dự án đang chờ kích hoạt hoặc đang tranh chấp. Khi có khiếu nại, lý do và ảnh khiếu nại luôn được ưu tiên.</p></div><span className="inline-flex w-fit rounded-full bg-slate-100 px-3 py-1.5 text-sm font-semibold text-slate-700">{projectsQuery.isPending ? 'Đang đồng bộ' : `${projects.length} dự án`}</span></header>
    {listNotice ? <div role="status" className="mt-4 flex flex-col gap-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm leading-6 text-amber-950 sm:flex-row sm:items-center sm:justify-between"><p>{listNotice}</p>{isListUnavailable ? <button type="button" onClick={() => void projectsQuery.refetch()} className="min-h-10 rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm font-bold text-amber-900">Thử lại</button> : null}</div> : null}
    {projectsQuery.isPending ? <div aria-label="Đang tải dự án chờ công bố" className="mt-5 grid gap-3 md:grid-cols-2">{Array.from({ length: 2 }).map((_, index) => <div key={index} className="h-48 animate-pulse rounded-2xl bg-slate-100" />)}</div> : null}
    {!projectsQuery.isPending && !isListUnavailable && projects.length === 0 ? <div className="mt-5 rounded-2xl border border-dashed border-emerald-200 bg-emerald-50/60 p-8 text-center"><h3 className="font-semibold text-slate-900">Không có dự án chờ công bố</h3><p className="mt-1 text-sm text-slate-600">Khi dự án vào giai đoạn niêm yết hoặc tranh chấp, hồ sơ sẽ hiện ở đây.</p></div> : null}
    {!projectsQuery.isPending && projects.length ? <div className="mt-5 grid gap-3 md:grid-cols-2">{projects.map(project => {
      const isDisputed = project.status === 'DISPUTED';
      const isSelected = selectedProjectId === project.projectId;
      const integrityIssues = project.integrityIssues || [];
      return <button type="button" key={project.projectId} onClick={() => setSelectedProjectId(project.projectId)} aria-pressed={isSelected} className={`relative min-w-0 overflow-hidden rounded-2xl border p-4 text-left transition-shadow focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0E7C6B] ${isDisputed ? 'border-rose-400 bg-rose-50/70 shadow-[0_0_0_3px_rgba(251,113,133,0.14)]' : 'border-slate-200 bg-white hover:border-emerald-300'} ${isSelected ? 'ring-2 ring-emerald-300' : ''}`}>
        {isDisputed ? <span aria-hidden="true" className="pointer-events-none absolute inset-0 rounded-2xl border-2 border-rose-400 motion-safe:animate-[executive-dispute-attention_1.8s_ease-in-out_infinite] motion-reduce:animate-none" /> : null}
        <div className="relative flex flex-wrap items-center gap-2"><span className={`inline-flex rounded-full px-2.5 py-1 text-[11px] font-bold ${isDisputed ? 'bg-rose-700 text-white motion-safe:animate-pulse motion-reduce:animate-none' : 'bg-slate-100 text-slate-700'}`}>{isDisputed ? 'Cần chú ý: đang tranh chấp' : 'Chờ công bố'}</span><EvidenceModeBadge mode={project.evidence.mode} /><KycBadge status={project.kyc.status} /></div>
        <h3 className="relative mt-3 break-words font-bold text-slate-950">{project.name}</h3><p className="relative mt-1 text-sm text-slate-600">{project.organizationName} · Vòng {project.listingRound}</p>
        <dl className="relative mt-4 grid grid-cols-2 gap-2 text-sm"><div className="rounded-xl bg-white/80 p-2.5"><dt className="text-[11px] text-slate-500">Mục tiêu</dt><dd className="mt-1 font-bold text-slate-900">{formatVnd(project.goalAmount)}</dd></div><div className="rounded-xl bg-white/80 p-2.5"><dt className="text-[11px] text-slate-500">Đã INDEXED</dt><dd className="mt-1 font-bold text-slate-900">{formatVnd(project.donationSummary.totalAmount)}</dd></div><div className="rounded-xl bg-white/80 p-2.5"><dt className="text-[11px] text-slate-500">Khiếu nại vòng này</dt><dd className="mt-1 font-bold text-slate-900">{project.challengeCount}</dd></div><div className="rounded-xl bg-white/80 p-2.5"><dt className="text-[11px] text-slate-500">Xác minh hiện trường</dt><dd className="mt-1 font-bold text-slate-900">{project.verificationCount}</dd></div></dl>
        <p className="relative mt-3 text-xs text-slate-600">Niêm yết: {formatPublicationSchedule(project.listedAt, 'Đã niêm yết')} · Kích hoạt: {formatPublicationSchedule(project.activationEligibleAt, 'Đã đến hạn')}</p>
        {integrityIssues.length ? <p role="alert" className="relative mt-3 rounded-lg border border-rose-300 bg-rose-100/80 p-2 text-xs font-semibold leading-5 text-rose-950">Dữ liệu tranh chấp chưa toàn vẹn; biểu quyết đang bị khóa.</p> : null}
        {isDisputed && project.arbitration ? <p className="relative mt-3 text-xs font-semibold text-rose-900">Tiếp tục: Chủ tịch {project.arbitration.upholdChairVoteCount}/1 · Ủy viên {project.arbitration.upholdMemberVoteCount}/{project.arbitration.requiredMemberVotes} · Hủy: {project.arbitration.rejectVoteCount}/{project.arbitration.totalCommitteeSeats}</p> : null}
      </button>;
    })}</div> : null}
    {projectsQuery.hasNextPage ? <button type="button" disabled={projectsQuery.isFetchingNextPage} onClick={() => void projectsQuery.fetchNextPage()} className="mt-5 min-h-11 rounded-xl border border-emerald-200 bg-white px-4 py-2 text-sm font-semibold text-[#0A5C50] disabled:opacity-60">{projectsQuery.isFetchingNextPage ? 'Đang tải thêm…' : 'Tải thêm dự án'}</button> : null}
    {detailNotice ? <div role="status" className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">{detailNotice}</div> : null}
    {detailQuery.isPending && selectedProjectId ? <div aria-label="Đang tải chi tiết dự án chờ công bố" className="mt-5 h-72 animate-pulse rounded-2xl bg-slate-100" /> : null}
    {detail ? <section className="mt-5 min-w-0 space-y-5 rounded-2xl border border-emerald-200 bg-gradient-to-br from-emerald-50 to-white p-4 sm:p-5"><header className="border-b border-emerald-100 pb-4"><p className="text-xs font-bold uppercase tracking-[0.14em] text-[#0E7C6B]">Hồ sơ dự án</p><h3 className="mt-1 text-lg font-bold text-slate-950">{detail.name}</h3><p className="mt-1 text-sm leading-6 text-slate-600">{detail.description}</p></header><dl className="grid gap-3 sm:grid-cols-5"><div className="rounded-xl border border-white bg-white/80 p-3"><dt className="text-xs text-slate-500">Mục tiêu</dt><dd className="mt-1 font-bold text-slate-950">{formatVnd(detail.goalAmount)}</dd></div><div className={`rounded-xl border p-3 ${detail.donationSummary.totalAmount > 0 ? 'border-rose-200 bg-rose-50 text-rose-950' : 'border-white bg-white/80 text-slate-950'}`}><dt className="text-xs text-slate-500">Donation đã INDEXED</dt><dd className="mt-1 font-bold">{formatVnd(detail.donationSummary.totalAmount)}</dd><p className="mt-1 text-xs">{detail.donationSummary.donationCount} lượt{detail.donationSummary.totalAmount > 0 ? ' · Cảnh báo: dự án chưa ACTIVE nhưng đã có donation.' : ''}</p></div><div className="rounded-xl border border-white bg-white/80 p-3"><dt className="text-xs text-slate-500">KYC người tạo</dt><dd className="mt-1"><KycBadge status={detail.kyc.status} /></dd><p className="mt-1 text-xs text-slate-500">Duyệt: {formatDateTime(detail.kyc.reviewedAt)}</p></div><div className="rounded-xl border border-white bg-white/80 p-3"><dt className="text-xs text-slate-500">Hạn dự án</dt><dd className="mt-1 text-sm font-bold text-slate-950">{formatPublicationSchedule(detail.deadline, 'Đã đến hạn')}</dd></div><div className="rounded-xl border border-white bg-white/80 p-3"><dt className="text-xs text-slate-500">Kích hoạt</dt><dd className="mt-1 text-sm font-bold text-slate-950">{formatPublicationSchedule(detail.activationEligibleAt, 'Đã đến hạn')}</dd><p className="mt-1 text-xs text-slate-500">Niêm yết: {formatPublicationSchedule(detail.listedAt, 'Đã niêm yết')}</p></div></dl>
      {(detail.milestonePlan || []).length ? <div><h4 className="font-bold text-slate-900">Kế hoạch các mốc</h4><ol className="mt-3 space-y-2">{(detail.milestonePlan || []).map((milestone, index) => <li key={index} className="rounded-xl border border-white bg-white/80 p-3 text-sm leading-6 text-slate-700">{getMilestoneLabel(milestone, index)}</li>)}</ol></div> : null}
      {detailIntegrityIssues.length ? <div role="alert" className="rounded-xl border border-rose-400 bg-rose-100 p-4 text-sm leading-6 text-rose-950"><p className="font-bold">Dữ liệu tranh chấp chưa toàn vẹn — biểu quyết bị khóa</p><ul className="mt-2 list-disc space-y-1 pl-5">{detailIntegrityIssues.map(issue => <li key={issue}>{formatIntegrityIssue(issue)}</li>)}</ul></div> : null}
      {detail.evidenceFiles.length ? <div><h4 className="font-bold text-slate-900">Tệp hồ sơ dự án</h4><div className="mt-3 grid gap-3 sm:grid-cols-2">{detail.evidenceFiles.map(file => <IpfsEvidencePreviewCard key={file.cid} cid={file.cid} fileName={file.fileName} mimeType={file.mimeType} documentTypeLabel="Hồ sơ dự án" compact />)}</div></div> : null}
      {detail.evidence.mode === 'UNVERIFIED' ? <div className="rounded-xl border border-dashed border-slate-300 bg-white/80 p-4 text-sm leading-6 text-slate-600">Chưa có khiếu nại hoặc ảnh xác minh thực địa trong vòng niêm yết hiện tại. Đây không phải là kết luận dự án đã được xác minh.</div> : <div><h4 className="font-bold text-slate-900">{evidenceRecordLabel}</h4><div className="mt-3 space-y-3">{detail.evidence.records.map(record => <article key={record.recordId} className={`rounded-xl border p-3 ${detail.evidence.mode === 'CHALLENGE' ? 'border-rose-200 bg-rose-50/70' : 'border-emerald-100 bg-white/80'}`}><p className="font-semibold text-slate-950">{record.auditorLabel}</p>{record.reason ? <p className="mt-2 rounded-lg border border-rose-200 bg-white/80 p-3 text-sm leading-6 text-rose-950">{record.reason}</p> : null}{record.note ? <p className="mt-2 text-sm leading-6 text-slate-700">{record.note}</p> : null}<p className="mt-2 text-xs text-slate-500">Gửi lúc {new Date(record.submittedAt).toLocaleString('vi-VN')}</p><div className="mt-3"><ChallengeEvidenceGallery photos={toGalleryPhotos(record.evidencePhotos, evidencePhotoLabel)} /></div></article>)}</div></div>}
      <div><h4 className="font-bold text-slate-900">Đối chiếu geofence</h4><div className="mt-3"><GeofenceMapLazy projectId={detail.projectId} snapshot={detail.geofence} markers={mapMarkers} /></div></div>
      {detail.evidence.records.flatMap(record => record.evidencePhotos).length ? <div className="flex flex-wrap gap-2">{detail.evidence.records.flatMap(record => record.evidencePhotos).map((photo, index) => <EvidenceDeviationBadge key={`${photo.cid}-${index}`} deviationLevel={photo.deviationLevel} distanceMeters={photo.distanceMeters} accuracyMeters={photo.accuracyMeters} />)}</div> : null}
      {detail.status === 'DISPUTED' && detail.arbitration ? <div className="rounded-xl border border-rose-200 bg-rose-50/70 p-3 text-sm text-rose-950"><p className="font-bold">Tiến độ biểu quyết</p><p className="mt-1">Tiếp tục: Chủ tịch {detail.arbitration.upholdChairVoteCount}/1 · Ủy viên {detail.arbitration.upholdMemberVoteCount}/{detail.arbitration.requiredMemberVotes} · Hủy: {detail.arbitration.rejectVoteCount}/{detail.arbitration.totalCommitteeSeats}</p></div> : null}
      {detail.status === 'DISPUTED' && detail.arbitration && detailIntegrityIssues.length === 0 ? <ProjectVerdictVotingActions arbitrationId={detail.arbitration.arbitrationId} canVote={detail.arbitration.canCurrentUserVote} project={{ status: detail.status, totalDonationAmount: detail.donationSummary.totalAmount }} onVoted={refreshAfterVote} /> : null}
    </section> : null}
  </section>;
}
