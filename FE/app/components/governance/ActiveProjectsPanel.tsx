'use client';

import type { ReactElement } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { buildSameOriginApiUrl, fetchApi, getApiErrorMessage } from '@/app/utils/apiClient';
import { readAuthSession } from '@/app/utils/authSession';
import { EvidenceDeviationBadge } from './EvidenceDeviationBadge';

type ActiveProject = { projectId: string; name: string; organizationName: string; fieldReportCount: number; pendingDisbursementCount: number };
type ActiveProjectDetail = { evidencePhotos: Array<{ cid: string; source: string; deviationLevel: 'INSIDE' | 'WITHIN_ACCURACY' | 'DEVIATED' | 'CRITICAL' | 'NO_GEOFENCE'; distanceMeters: number | null; accuracyMeters: number; isLowAccuracyOverride: boolean; lowAccuracyReason: string | null }>; highestDeviationLevel: 'INSIDE' | 'WITHIN_ACCURACY' | 'DEVIATED' | 'CRITICAL' | 'NO_GEOFENCE' };

/** Lấy header access token hiện tại để API quản trị không phụ thuộc vào cache UI. */
function getGovernanceHeaders(): HeadersInit {
  const token = readAuthSession().accessToken;
  return token ? { Authorization: 'Bearer ' + token } : {};
}

/** Hiển thị dự án ACTIVE và bằng chứng geofence theo lưới co giãn từ điện thoại đến desktop. */
export function ActiveProjectsPanel(): ReactElement {
  const [projects, setProjects] = useState<ActiveProject[]>([]);
  const [detail, setDetail] = useState<ActiveProjectDetail | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isListUnavailable, setIsListUnavailable] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [isDetailLoading, setIsDetailLoading] = useState(false);
  const detailRequestVersionRef = useRef(0);

  /** Tải một trang cursor để danh sách luôn vừa với viewport và không nạp toàn bộ dự án. */
  const loadProjects = useCallback(async (cursor: string | null = null): Promise<void> => {
    if (cursor) setIsLoadingMore(true);
    else {
      setIsLoading(true);
      setNotice('');
      setIsListUnavailable(false);
    }
    try {
      const response = await fetchApi<{ items: ActiveProject[]; nextCursor: string | null }>(
        buildSameOriginApiUrl('/api/project-governance/executive/active-projects?limit=20' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '')),
        { headers: getGovernanceHeaders() }
      );
      setProjects(current => cursor ? [...current, ...response.data.items] : response.data.items);
      setNextCursor(response.data.nextCursor);
      if (!cursor) setIsListUnavailable(false);
    } catch (error) {
      if (!cursor) setIsListUnavailable(true);
      setNotice(getApiErrorMessage(error, 'Không thể tải dự án đang hoạt động.'));
    } finally {
      setIsLoading(false);
      setIsLoadingMore(false);
    }
  }, []);

  useEffect(() => { void loadProjects(); }, [loadProjects]);

  /** Chỉ tải evidence khi ủy viên chọn card, giữ trải nghiệm mobile nhẹ và phản hồi nhanh. */
  const selectProject = async (projectId: string): Promise<void> => {
    const requestVersion = detailRequestVersionRef.current + 1;
    detailRequestVersionRef.current = requestVersion;
    setSelectedProjectId(projectId);
    setDetail(null);
    setIsDetailLoading(true);
    setNotice('');
    try {
      const response = await fetchApi<ActiveProjectDetail>(
        buildSameOriginApiUrl('/api/project-governance/executive/active-projects/' + encodeURIComponent(projectId)),
        { headers: getGovernanceHeaders() }
      );
      // Chỉ hiển thị kết quả của thao tác chọn mới nhất, tránh phản hồi chậm ghi đè card hiện tại.
      if (requestVersion !== detailRequestVersionRef.current) return;
      setDetail(response.data);
    } catch (error) {
      if (requestVersion !== detailRequestVersionRef.current) return;
      setNotice(getApiErrorMessage(error, 'Không thể tải bằng chứng dự án.'));
    } finally {
      if (requestVersion === detailRequestVersionRef.current) setIsDetailLoading(false);
    }
  };

  return <section aria-labelledby="active-projects-title" className="min-w-0 rounded-3xl border border-slate-200/80 bg-white/90 p-4 shadow-[0_16px_35px_-28px_rgba(15,23,42,0.45)] backdrop-blur sm:p-6">
    <header className="flex flex-col gap-4 border-b border-slate-100 pb-4 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-[#0E7C6B]">Giám sát minh bạch</p>
        <h2 id="active-projects-title" className="mt-1 text-2xl font-bold tracking-tight text-slate-950">Dự án đang hoạt động</h2>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">Chọn dự án để kiểm tra chứng cứ hiện trường và mức đối chiếu vị trí do hệ thống xác định.</p>
      </div>
      <span className="inline-flex w-fit items-center gap-2 rounded-full bg-emerald-50 px-3 py-1.5 text-sm font-semibold text-[#0A5C50]">
        <span className="h-2 w-2 rounded-full bg-[#0E7C6B]" />
        {isLoading ? 'Đang đồng bộ' : isListUnavailable ? 'Không khả dụng' : projects.length + ' dự án'}
      </span>
    </header>

    {notice ? <div role="status" className="mt-4 flex flex-col gap-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm leading-6 text-amber-950 sm:flex-row sm:items-center sm:justify-between"><p className="break-words">{notice}</p>{isListUnavailable ? <button type="button" onClick={() => void loadProjects()} className="min-h-10 w-full shrink-0 rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm font-bold text-amber-900 transition-colors hover:bg-amber-100 sm:w-auto">Thử lại</button> : null}</div> : null}

    {isLoading ? <div aria-label="Đang tải danh sách dự án" className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {Array.from({ length: 3 }).map((_, index) => <div key={index} className="h-40 animate-pulse rounded-2xl border border-slate-100 bg-slate-50 p-4"><div className="h-3 w-20 rounded bg-slate-200" /><div className="mt-4 h-5 w-3/4 rounded bg-slate-200" /><div className="mt-3 h-3 w-1/2 rounded bg-slate-200" /><div className="mt-7 grid grid-cols-2 gap-2"><div className="h-9 rounded-xl bg-slate-200" /><div className="h-9 rounded-xl bg-slate-200" /></div></div>)}
    </div> : null}

    {!isLoading && !isListUnavailable && projects.length === 0 ? <div className="mt-5 rounded-2xl border border-dashed border-emerald-200 bg-emerald-50/60 px-5 py-10 text-center">
      <div aria-hidden="true" className="mx-auto grid h-11 w-11 place-items-center rounded-2xl bg-white text-[#0E7C6B] shadow-sm">
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 4 4L19 6" /></svg>
      </div>
      <h3 className="mt-3 font-semibold text-slate-900">Chưa có dự án cần theo dõi</h3>
      <p className="mx-auto mt-1 max-w-md text-sm leading-6 text-slate-600">Các dự án ở trạng thái hoạt động sẽ xuất hiện tại đây cùng các chứng cứ hiện trường liên quan.</p>
    </div> : null}

    {!isLoading && projects.length > 0 ? <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {projects.map(project => {
        const isSelected = selectedProjectId === project.projectId;
        return <button type="button" key={project.projectId} onClick={() => void selectProject(project.projectId)} aria-pressed={isSelected} className={'min-w-0 rounded-2xl border p-4 text-left transition-all focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0E7C6B] ' + (isSelected ? 'border-[#0E7C6B] bg-emerald-50/80 shadow-[0_14px_25px_-20px_rgba(14,124,107,0.7)] ring-2 ring-emerald-100' : 'border-slate-200 bg-white hover:-translate-y-0.5 hover:border-emerald-300 hover:shadow-md')}>
          <span className={'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold ' + (isSelected ? 'bg-emerald-200 text-[#08473F]' : 'bg-emerald-50 text-emerald-800')}><span className="h-1.5 w-1.5 rounded-full bg-current" />{isSelected ? 'Đang xem chứng cứ' : 'Đang theo dõi'}</span>
          <h3 className="mt-3 break-words text-base font-bold text-slate-950">{project.name}</h3>
          <p className="mt-1 break-words text-sm text-slate-600">{project.organizationName}</p>
          <dl className="mt-5 grid grid-cols-2 gap-2">
            <div className="rounded-xl bg-slate-50 p-2.5">
              <dt className="text-[11px] font-medium text-slate-500">Hiện trường</dt>
              <dd className="mt-1 text-lg font-bold text-slate-900">{project.fieldReportCount}</dd>
            </div>
            <div className="rounded-xl bg-slate-50 p-2.5">
              <dt className="text-[11px] font-medium text-slate-500">Chờ giải ngân</dt>
              <dd className="mt-1 text-lg font-bold text-slate-900">{project.pendingDisbursementCount}</dd>
            </div>
          </dl>
        </button>;
      })}
    </div> : null}

    {nextCursor ? <button type="button" disabled={isLoadingMore} onClick={() => void loadProjects(nextCursor)} className="mt-5 min-h-11 w-full rounded-xl border border-emerald-200 bg-white px-4 py-2 text-sm font-semibold text-[#0A5C50] transition-colors hover:bg-emerald-50 disabled:cursor-wait disabled:opacity-60 sm:w-auto">{isLoadingMore ? 'Đang tải thêm…' : 'Tải thêm dự án'}</button> : null}

    {isDetailLoading ? <section aria-label="Đang tải bằng chứng dự án" className="mt-5 animate-pulse rounded-2xl border border-emerald-100 bg-emerald-50/70 p-4 sm:p-5"><div className="h-5 w-48 rounded bg-emerald-200" /><div className="mt-4 grid gap-3 lg:grid-cols-2"><div className="h-28 rounded-xl bg-white" /><div className="h-28 rounded-xl bg-white" /></div></section> : null}

    {detail ? <section className="mt-5 min-w-0 rounded-2xl border border-emerald-200 bg-gradient-to-br from-emerald-50 to-white p-4 sm:p-5">
      <div className="flex flex-col gap-3 border-b border-emerald-100 pb-4 sm:flex-row sm:items-center sm:justify-between">
        <div><p className="text-xs font-bold uppercase tracking-[0.14em] text-[#0E7C6B]">Chứng cứ hiện trường</p><h3 className="mt-1 font-bold text-slate-950">Đối chiếu vị trí đã ghi nhận</h3></div>
        <EvidenceDeviationBadge deviationLevel={detail.highestDeviationLevel} distanceMeters={null} accuracyMeters={0} />
      </div>
      {detail.evidencePhotos.length > 0 ? <div className="mt-4 grid gap-3 lg:grid-cols-2">{detail.evidencePhotos.map((photo, index) => <article key={photo.cid + '-' + index} className="min-w-0 rounded-xl border border-white bg-white p-3 shadow-sm">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <span className="text-xs font-semibold text-slate-600">{photo.source === 'AUDITOR_FIELD_REPORT' ? 'Biên bản kiểm toán viên' : 'Ảnh giải ngân của tổ chức'}</span>
          <EvidenceDeviationBadge deviationLevel={photo.deviationLevel} distanceMeters={photo.distanceMeters} accuracyMeters={photo.accuracyMeters} />
        </div>
        <p className="mt-3 break-all rounded-lg bg-slate-50 px-2.5 py-2 font-mono text-xs text-slate-600">CID: {photo.cid}</p>
        {photo.isLowAccuracyOverride ? <p className="mt-3 break-words rounded-lg bg-amber-50 p-2.5 text-sm leading-5 text-amber-900">Ảnh chụp qua van thoát GPS: {photo.lowAccuracyReason || 'Không nêu lý do'}</p> : null}
      </article>)}</div> : <p className="mt-4 rounded-xl border border-dashed border-emerald-200 bg-white/70 p-4 text-sm text-slate-600">Dự án chưa có ảnh chứng cứ để đối chiếu vị trí.</p>}
    </section> : null}
  </section>;
}
