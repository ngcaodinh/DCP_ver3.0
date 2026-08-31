'use client';

import { type ReactElement, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { buildSameOriginApiUrl, fetchApi, getApiErrorMessage } from '@/app/utils/apiClient';
import { readAuthSession } from '@/app/utils/authSession';
import IpfsEvidencePreviewCard from '@/app/components/common/IpfsEvidencePreviewCard';
import type { EvidencePhoto } from './ChallengeEvidenceGallery';
import { ChallengeEvidenceGallery } from './ChallengeEvidenceGallery';
import { EvidenceDeviationBadge } from './EvidenceDeviationBadge';
import { GeofenceMapLazy } from '../oracle/GeofenceMapLazy';
import type {
  ExecutiveActiveProjectDetail,
  ExecutiveActiveProjectSummary,
  ExecutiveCursorPage,
  ExecutiveEvidencePhoto
} from '@/app/types/executiveCommitteeProjects';

/** Lấy header token tại thời điểm query chạy để không giữ access token cũ trong cache UI. */
function getGovernanceHeaders(): HeadersInit {
  const token = readAuthSession().accessToken;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Đọc một page ACTIVE; server state được TanStack Query quản lý thay vì useEffect thủ công. */
async function fetchExecutiveActiveProjects(cursor: string | null): Promise<ExecutiveCursorPage<ExecutiveActiveProjectSummary>> {
  const response = await fetchApi<ExecutiveCursorPage<ExecutiveActiveProjectSummary>>(
    buildSameOriginApiUrl(`/api/project-governance/executive/active-projects?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`),
    { headers: getGovernanceHeaders() }
  );
  return response.data;
}

/** Đọc detail ACTIVE theo projectId; query key riêng loại bỏ race response cũ khi đổi card. */
async function fetchExecutiveActiveProjectDetail(projectId: string): Promise<ExecutiveActiveProjectDetail> {
  const response = await fetchApi<ExecutiveActiveProjectDetail>(
    buildSameOriginApiUrl(`/api/project-governance/executive/active-projects/${encodeURIComponent(projectId)}`),
    { headers: getGovernanceHeaders() }
  );
  return response.data;
}

/** Chuẩn hoá DTO evidence về gallery cũ để tất cả nguồn ảnh giữ cùng fallback IPFS và metadata GPS. */
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

/** Định dạng tiền VND không phụ thuộc locale của browser để card hiển thị nhất quán. */
function formatVnd(amount: number): string {
  return `${new Intl.NumberFormat('vi-VN').format(Math.max(0, amount || 0))} VND`;
}

/** Định dạng mốc thời gian server trả về và giữ fallback rõ ràng cho record lịch sử. */
function formatDateTime(value: string | null | undefined): string {
  if (!value) return 'Chưa có thời điểm';
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? 'Chưa có thời điểm' : timestamp.toLocaleString('vi-VN');
}

/** Tạo liên kết Google Maps từ tâm geofence để đối chiếu nhanh với vị trí dự án đã đăng ký. */
function buildGoogleMapsProjectLocationUrl(coordinate: { lat: number; lng: number } | null | undefined): string | null {
  if (!coordinate || !Number.isFinite(coordinate.lat) || !Number.isFinite(coordinate.lng)) return null;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${coordinate.lat},${coordinate.lng}`)}`;
}

/** Chỉ đọc các trường milestone công khai để record lịch sử sai shape không làm hỏng portal. */
function getMilestoneLabel(item: unknown, index: number): string {
  if (!item || typeof item !== 'object') return `Mốc ${index + 1}: Chưa có mô tả`;
  const milestone = item as { milestoneKey?: unknown; description?: unknown; percentage?: unknown };
  const key = typeof milestone.milestoneKey === 'string' ? milestone.milestoneKey : `Mốc ${index + 1}`;
  const description = typeof milestone.description === 'string' && milestone.description.trim() ? milestone.description : 'Chưa có mô tả';
  const percentage = typeof milestone.percentage === 'number' && Number.isFinite(milestone.percentage) ? ` · ${milestone.percentage}%` : '';
  return `${key}${percentage}: ${description}`;
}

/** Hiển thị KYC đã redacted, không hiển thị bất cứ file hay thuộc tính định danh nào của người tạo. */
function KycBadge({ status }: { status: ExecutiveActiveProjectSummary['kyc']['status'] }): ReactElement {
  const label = status === 'APPROVED'
    ? 'KYC đã phê duyệt'
    : status === 'NOT_SUBMITTED'
      ? 'KYC chưa nộp'
      : `KYC: ${status}`;
  const className = status === 'APPROVED'
    ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
    : status === 'NOT_SUBMITTED'
      ? 'border-slate-200 bg-slate-50 text-slate-600'
      : 'border-amber-200 bg-amber-50 text-amber-900';
  return <span className={`inline-flex rounded-full border px-2 py-1 text-[11px] font-semibold ${className}`}>{label}</span>;
}

/** Hiển thị dự án ACTIVE với ảnh IPFS, ngữ cảnh nghiệp vụ và bản đồ geofence chỉ đọc cho Chair/Member. */
export function ActiveProjectsPanel(): ReactElement {
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const projectsQuery = useInfiniteQuery({
    queryKey: ['executiveActiveProjects'],
    queryFn: ({ pageParam }) => fetchExecutiveActiveProjects(pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: page => page.nextCursor,
    retry: false
  });
  const detailQuery = useQuery({
    queryKey: ['executiveActiveProjectDetail', selectedProjectId],
    queryFn: () => fetchExecutiveActiveProjectDetail(selectedProjectId!),
    enabled: Boolean(selectedProjectId),
    retry: false
  });
  const projects = projectsQuery.data?.pages.flatMap(page => page.items) || [];
  const detail = detailQuery.data || null;
  const isListUnavailable = projectsQuery.isError && projects.length === 0;
  const listNotice = projectsQuery.isError ? getApiErrorMessage(projectsQuery.error, 'Không thể tải dự án đang hoạt động.') : '';
  const detailNotice = detailQuery.isError ? getApiErrorMessage(detailQuery.error, 'Không thể tải bằng chứng dự án.') : '';
  const detailEvidenceFiles = detail?.evidenceFiles || [];
  const detailFieldReports = detail?.fieldReports || (detail?.evidencePhotos?.length ? [{
    reportId: 'legacy-evidence',
    auditorLabel: 'Báo cáo khảo sát thực địa',
    note: '',
    verifiedMilestoneIndexes: [],
    submittedAt: '',
    evidencePhotos: detail.evidencePhotos
  }] : []);
  const detailListingVerifications = detail?.listingVerifications || [];
  const detailDisbursementEvidence = detail?.disbursementEvidence || [];
  const detailDonationSummary = detail?.donationSummary || { totalAmount: 0, donationCount: 0 };
  const detailKycStatus = detail?.profile?.kyc?.status || 'NOT_SUBMITTED';
  const mapMarkers = detail?.evidencePhotos.map((photo, index) => ({
    id: `${photo.cid}-${index}`,
    coordinate: photo.gps,
    status: !detail.geofence || !photo.gps ? 'NO_GPS' as const : photo.isInsideGeofence ? 'VALID' as const : 'INVALID' as const,
    evidenceCid: photo.cid,
    distanceMeters: photo.distanceMeters,
    distanceToProjectCenterMeters: photo.distanceToProjectCenterMeters,
    capturedAt: photo.capturedAt || undefined
  })) || [];
  const googleMapsProjectLocationUrl = buildGoogleMapsProjectLocationUrl(detail?.geofence?.centroid);

  return <section aria-labelledby="active-projects-title" className="min-w-0 rounded-3xl border border-slate-200/80 bg-white/90 p-4 shadow-[0_16px_35px_-28px_rgba(15,23,42,0.45)] backdrop-blur sm:p-6">
    <header className="flex flex-col gap-4 border-b border-slate-100 pb-4 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-[#0E7C6B]">Giám sát minh bạch</p>
        <h2 id="active-projects-title" className="mt-1 text-2xl font-bold tracking-tight text-slate-950">Dự án đang hoạt động</h2>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">Kiểm tra hồ sơ, ảnh hiện trường, vị trí GPS, báo cáo khảo sát thực địa của kiểm toán viên và hồ sơ minh chứng giải ngân của từng dự án.</p>
      </div>
      <span className="inline-flex w-fit items-center gap-2 rounded-full bg-emerald-50 px-3 py-1.5 text-sm font-semibold text-[#0A5C50]">
        <span className="h-2 w-2 rounded-full bg-[#0E7C6B]" />
        {projectsQuery.isPending ? 'Đang đồng bộ' : isListUnavailable ? 'Không khả dụng' : `${projects.length} dự án`}
      </span>
    </header>

    {listNotice ? <div role="status" className="mt-4 flex flex-col gap-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm leading-6 text-amber-950 sm:flex-row sm:items-center sm:justify-between"><p className="break-words">{listNotice}</p>{isListUnavailable ? <button type="button" onClick={() => void projectsQuery.refetch()} className="min-h-10 w-full shrink-0 rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm font-bold text-amber-900 transition-colors hover:bg-amber-100 sm:w-auto">Thử lại</button> : null}</div> : null}

    {projectsQuery.isPending ? <div aria-label="Đang tải danh sách dự án" className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{Array.from({ length: 3 }).map((_, index) => <div key={index} className="h-48 animate-pulse rounded-2xl border border-slate-100 bg-slate-50 p-4"><div className="h-3 w-20 rounded bg-slate-200" /><div className="mt-4 h-5 w-3/4 rounded bg-slate-200" /><div className="mt-3 h-3 w-1/2 rounded bg-slate-200" /></div>)}</div> : null}

    {!projectsQuery.isPending && !isListUnavailable && projects.length === 0 ? <div className="mt-5 rounded-2xl border border-dashed border-emerald-200 bg-emerald-50/60 px-5 py-10 text-center"><h3 className="font-semibold text-slate-900">Chưa có dự án cần theo dõi</h3><p className="mx-auto mt-1 max-w-md text-sm leading-6 text-slate-600">Các dự án ở trạng thái hoạt động sẽ xuất hiện tại đây cùng bằng chứng hiện trường liên quan.</p></div> : null}

    {!projectsQuery.isPending && projects.length > 0 ? <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{projects.map(project => {
      const isSelected = selectedProjectId === project.projectId;
      const summaryDonation = project.donationSummary || { totalAmount: 0, donationCount: 0 };
      const summaryKycStatus = project.kyc?.status || 'NOT_SUBMITTED';
      return <button type="button" key={project.projectId} onClick={() => setSelectedProjectId(project.projectId)} aria-pressed={isSelected} className={`min-w-0 rounded-2xl border p-4 text-left transition-all focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0E7C6B] ${isSelected ? 'border-[#0E7C6B] bg-emerald-50/80 ring-2 ring-emerald-100' : 'border-slate-200 bg-white hover:-translate-y-0.5 hover:border-emerald-300 hover:shadow-md'}`}>
        <div className="flex flex-wrap items-center gap-2"><span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] font-bold text-emerald-800"><span className="h-1.5 w-1.5 rounded-full bg-current" />Đang theo dõi</span><KycBadge status={summaryKycStatus} /><EvidenceDeviationBadge deviationLevel={project.highestDeviationLevel || 'NO_GEOFENCE'} distanceMeters={null} accuracyMeters={0} /></div>
        <h3 className="mt-3 break-words text-base font-bold text-slate-950">{project.name}</h3><p className="mt-1 break-words text-sm text-slate-600">{project.organizationName}</p>
        <dl className="mt-4 grid grid-cols-2 gap-2 text-sm"><div className="rounded-xl bg-slate-50 p-2.5"><dt className="text-[11px] text-slate-500">Mục tiêu</dt><dd className="mt-1 font-bold text-slate-900">{formatVnd(project.goalAmount || 0)}</dd></div><div className="rounded-xl bg-slate-50 p-2.5"><dt className="text-[11px] text-slate-500">Đã quyên góp</dt><dd className="mt-1 font-bold text-slate-900">{formatVnd(summaryDonation.totalAmount)}</dd></div><div className="rounded-xl bg-slate-50 p-2.5"><dt className="text-[11px] text-slate-500">Hiện trường</dt><dd className="mt-1 font-bold text-slate-900">{project.fieldReportCount}</dd></div><div className="rounded-xl bg-slate-50 p-2.5"><dt className="text-[11px] text-slate-500">Chờ giải ngân</dt><dd className="mt-1 font-bold text-slate-900">{project.pendingDisbursementCount}</dd></div></dl>
      </button>;
    })}</div> : null}

    {projectsQuery.hasNextPage ? <button type="button" disabled={projectsQuery.isFetchingNextPage} onClick={() => void projectsQuery.fetchNextPage()} className="mt-5 min-h-11 w-full rounded-xl border border-emerald-200 bg-white px-4 py-2 text-sm font-semibold text-[#0A5C50] transition-colors hover:bg-emerald-50 disabled:cursor-wait disabled:opacity-60 sm:w-auto">{projectsQuery.isFetchingNextPage ? 'Đang tải thêm…' : 'Tải thêm dự án'}</button> : null}

    {detailNotice ? <div role="status" className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">{detailNotice}</div> : null}
    {detailQuery.isPending && selectedProjectId ? <section aria-label="Đang tải bằng chứng dự án" className="mt-5 animate-pulse rounded-2xl border border-emerald-100 bg-emerald-50/70 p-4 sm:p-5"><div className="h-5 w-48 rounded bg-emerald-200" /><div className="mt-4 h-36 rounded-xl bg-white" /></section> : null}

    {detail ? <section className="mt-5 min-w-0 space-y-5 rounded-2xl border border-emerald-200 bg-gradient-to-br from-emerald-50 to-white p-4 sm:p-5">
      <div className="flex flex-col gap-3 border-b border-emerald-100 pb-4 sm:flex-row sm:items-center sm:justify-between"><div><p className="text-xs font-bold uppercase tracking-[0.14em] text-[#0E7C6B]">Chứng cứ hiện trường</p><h3 className="mt-1 font-bold text-slate-950">{detail.name}</h3><p className="mt-1 text-sm leading-6 text-slate-600">{detail.description}</p></div><EvidenceDeviationBadge deviationLevel={detail.highestDeviationLevel} distanceMeters={null} accuracyMeters={0} /></div>
      <dl className="grid gap-3 sm:grid-cols-4"><div className="rounded-xl border border-white bg-white/80 p-3"><dt className="text-xs text-slate-500">Mục tiêu</dt><dd className="mt-1 font-bold text-slate-950">{formatVnd(detail.goalAmount)}</dd></div><div className="rounded-xl border border-white bg-white/80 p-3"><dt className="text-xs text-slate-500">Đã INDEXED</dt><dd className="mt-1 font-bold text-slate-950">{formatVnd(detailDonationSummary.totalAmount)}</dd><p className="mt-1 text-xs text-slate-500">{detailDonationSummary.donationCount} lượt quyên góp</p></div><div className="rounded-xl border border-white bg-white/80 p-3"><dt className="text-xs text-slate-500">Trạng thái người tạo</dt><dd className="mt-1"><KycBadge status={detailKycStatus} /></dd><p className="mt-1 text-xs text-slate-500">Duyệt: {formatDateTime(detail.profile?.kyc?.reviewedAt)}</p></div><div className="rounded-xl border border-white bg-white/80 p-3"><dt className="text-xs text-slate-500">Hạn dự án</dt><dd className="mt-1 text-sm font-bold text-slate-950">{formatDateTime(detail.deadline)}</dd></div></dl>
      {(detail.milestonePlan || []).length ? <div><h4 className="font-bold text-slate-900">Kế hoạch các mốc</h4><ol className="mt-3 space-y-2">{(detail.milestonePlan || []).map((milestone, index) => <li key={index} className="rounded-xl border border-white bg-white/80 p-3 text-sm leading-6 text-slate-700">{getMilestoneLabel(milestone, index)}</li>)}</ol></div> : null}
      {detailEvidenceFiles.length ? <div><h4 className="font-bold text-slate-900">Hồ sơ dự án</h4><div className="mt-3 grid gap-3 sm:grid-cols-2">{detailEvidenceFiles.map(file => <IpfsEvidencePreviewCard key={file.cid} cid={file.cid} fileName={file.fileName} mimeType={file.mimeType} documentTypeLabel="Hồ sơ dự án" compact />)}</div></div> : null}
      <div><div className="flex flex-wrap items-center justify-between gap-2"><h4 className="font-bold text-slate-900">Đối chiếu vị trí thực địa</h4>{googleMapsProjectLocationUrl ? <a href={googleMapsProjectLocationUrl} target="_blank" rel="noreferrer" className="inline-flex min-h-9 items-center rounded-lg border border-emerald-200 bg-white px-3 py-1.5 text-xs font-bold text-[#0A5C50] transition-colors hover:bg-emerald-50">Mở vị trí dự án trên Google Maps</a> : null}</div><div className="mt-3"><GeofenceMapLazy projectId={detail.projectId} snapshot={detail.geofence} markers={mapMarkers} /></div></div>
      <div><h4 className="font-bold text-slate-900">Ảnh xác minh thực địa khi niêm yết</h4>{detailListingVerifications.length ? <div className="mt-3 space-y-3">{detailListingVerifications.map(verification => <article key={verification.verificationId} className="rounded-xl border border-white bg-white/80 p-3"><p className="font-semibold text-slate-900">{verification.auditorLabel}</p>{verification.note ? <p className="mt-1 text-sm leading-6 text-slate-600">{verification.note}</p> : null}<p className="mt-2 text-xs text-slate-500">Gửi lúc: {formatDateTime(verification.submittedAt)}</p><div className="mt-3"><ChallengeEvidenceGallery photos={toGalleryPhotos(verification.evidencePhotos, 'Ảnh xác minh thực địa khi niêm yết')} emptyMessage="Bản xác minh này chưa kèm ảnh thực địa." /></div></article>)}</div> : <p className="mt-3 rounded-xl border border-dashed border-emerald-200 bg-white/70 p-4 text-sm text-slate-600">Chưa có ảnh xác minh thực địa được ghi nhận trong giai đoạn niêm yết.</p>}</div>
      <div><h4 className="font-bold text-slate-900">Báo cáo khảo sát thực địa</h4>{detailFieldReports.length ? <div className="mt-3 space-y-3">{detailFieldReports.map(report => <article key={report.reportId} className="rounded-xl border border-white bg-white/80 p-3"><p className="font-semibold text-slate-900">{report.auditorLabel}</p><p className="mt-1 text-sm leading-6 text-slate-600">{report.note}</p><p className="mt-2 text-xs text-slate-500">Gửi lúc: {formatDateTime(report.submittedAt)} · Mốc đã xác minh: {report.verifiedMilestoneIndexes.length ? report.verifiedMilestoneIndexes.join(', ') : 'Chưa ghi nhận'}</p><div className="mt-3"><ChallengeEvidenceGallery photos={toGalleryPhotos(report.evidencePhotos, 'Ảnh khảo sát thực địa')} emptyMessage="Báo cáo này chưa kèm ảnh thực địa." /></div></article>)}</div> : <p className="mt-3 rounded-xl border border-dashed border-emerald-200 bg-white/70 p-4 text-sm text-slate-600">Chưa có báo cáo khảo sát thực địa từ kiểm toán viên cho dự án này.</p>}</div>
      <div><h4 className="font-bold text-slate-900">Hồ sơ minh chứng giải ngân</h4>{detailDisbursementEvidence.length ? <div className="mt-3 space-y-3">{detailDisbursementEvidence.map(request => <article key={request.requestId} className="rounded-xl border border-white bg-white/80 p-3"><p className="font-semibold text-slate-900">Yêu cầu #{request.requestId} · {formatVnd(request.amount)}</p><p className="mt-1 text-sm leading-6 text-slate-600">{request.usagePurpose}</p><p className="mt-1 text-xs font-semibold text-slate-500">Trạng thái: {request.status} · Tạo lúc: {formatDateTime(request.createdAt)}</p><div className="mt-3"><ChallengeEvidenceGallery photos={toGalleryPhotos(request.evidencePhotos, 'Ảnh minh chứng giải ngân')} emptyMessage="Yêu cầu này chưa kèm ảnh minh chứng giải ngân." /></div></article>)}</div> : <p className="mt-3 rounded-xl border border-dashed border-emerald-200 bg-white/70 p-4 text-sm text-slate-600">Chưa có hồ sơ minh chứng cho các yêu cầu giải ngân.</p>}</div>
    </section> : null}
  </section>;
}
