'use client';

import { type FormEvent, type ReactElement, useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { buildApiUrl, fetchApi, type ApiErrorResponse } from '@/app/utils/apiClient';
import { readAuthSession } from '@/app/utils/authSession';
import { refreshAuthSession } from '@/app/utils/authSessionRefresh';
import { EvidenceCameraCapture } from '../common/evidenceCamera/EvidenceCameraCapture';
import type { CapturedEvidencePhoto } from '../common/evidenceCamera/types';
import AuditorFieldReportForm from './AuditorFieldReportForm';

interface AuditorProject {
  projectId: string;
  name: string;
  description?: string;
  status: 'PENDING_ACTIVATION' | 'DISPUTED';
  activationEligibleAt: string | null;
  hasCurrentUserChallenged: boolean;
}

interface ActiveAuditorProject {
  projectId: string;
  name: string;
  milestonePlan: Array<{ milestoneIndex: number; milestoneKey: string; description: string }>;
  fieldReport?: { reportId: string } | null;
}

/** Tạo header xác thực cho các API governance cần đọc lại phiên hiện tại. */
function getAuthorizationHeaders(): HeadersInit {
  const token = readAuthSession().accessToken;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Hiển thị cổng Auditor gồm khiếu nại niêm yết và biên bản hiện trường độc lập. */
export default function AuditorPortalClient(): ReactElement {
  const { replace } = useRouter();
  const [projects, setProjects] = useState<AuditorProject[]>([]);
  const [activeProjects, setActiveProjects] = useState<ActiveAuditorProject[]>([]);
  const [activeTab, setActiveTab] = useState<'CHALLENGES' | 'FIELD_REPORTS'>('CHALLENGES');
  const [selectedProject, setSelectedProject] = useState<AuditorProject | null>(null);
  const [reason, setReason] = useState('');
  const [photos, setPhotos] = useState<CapturedEvidencePhoto[]>([]);
  const [notice, setNotice] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isProjectsLoading, setIsProjectsLoading] = useState(true);
  const [isActiveProjectsLoading, setIsActiveProjectsLoading] = useState(true);

  /** Tải tài nguyên Auditor và làm mới phiên một lần khi access token vừa bị thu hồi. */
  const fetchAuditorResourceWithRefresh = useCallback(async <T,>(pathname: string): Promise<T | null> => {
    try {
      const response = await fetchApi<T>(buildApiUrl(pathname), { headers: getAuthorizationHeaders() });
      return response.data;
    } catch (error) {
      if ((error as ApiErrorResponse).statusCode !== 401) {
        throw error;
      }

      const refreshResult = await refreshAuthSession();
      if (refreshResult.status === 'REFRESHED') {
        const response = await fetchApi<T>(buildApiUrl(pathname), { headers: getAuthorizationHeaders() });
        return response.data;
      }

      if (refreshResult.status === 'RATE_LIMITED') {
        setNotice('Hệ thống đang giới hạn tần suất xác thực. Vui lòng thử lại sau ít phút.');
        return null;
      }

      if (refreshResult.status === 'UNAVAILABLE') {
        setNotice('Chưa thể kết nối máy chủ để khôi phục phiên. Vui lòng thử lại.');
        return null;
      }

      replace('/login');
      return null;
    }
  }, [replace]);

  /** Tải danh sách dự án còn trong cửa sổ khiếu nại. */
  const loadProjects = useCallback(async (): Promise<void> => {
    setIsProjectsLoading(true);
    try {
      const projectList = await fetchAuditorResourceWithRefresh<AuditorProject[]>('/api/project-governance/auditor/pending-projects');
      if (projectList) {
        setProjects(projectList);
      }
    } catch (error) {
      setNotice((error as ApiErrorResponse).message || 'Không thể tải danh sách dự án niêm yết.');
    } finally {
      setIsProjectsLoading(false);
    }
  }, [fetchAuditorResourceWithRefresh]);

  /** Tải dự án ACTIVE để form biên bản chỉ cho chọn hồ sơ đủ điều kiện. */
  const loadActiveProjects = useCallback(async (): Promise<void> => {
    setIsActiveProjectsLoading(true);
    try {
      const projectList = await fetchAuditorResourceWithRefresh<ActiveAuditorProject[]>('/api/project-governance/auditor/active-projects');
      if (projectList) {
        setActiveProjects(projectList);
      }
    } catch (error) {
      setNotice((error as ApiErrorResponse).message || 'Không thể tải danh sách dự án ACTIVE.');
    } finally {
      setIsActiveProjectsLoading(false);
    }
  }, [fetchAuditorResourceWithRefresh]);

  useEffect(() => {
    void Promise.all([loadProjects(), loadActiveProjects()]);
  }, [loadActiveProjects, loadProjects]);

  /** Đóng form khiếu nại và giải phóng object URL của ảnh camera trong trình duyệt. */
  const closeChallengeForm = (): void => {
    photos.forEach(photo => URL.revokeObjectURL(photo.previewObjectUrl));
    setPhotos([]);
    setReason('');
    setSelectedProject(null);
  };

  /** Gửi khiếu nại cùng evidence camera trong một request nguyên tử. */
  const submitChallenge = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!selectedProject || reason.trim().length < 30) return;
    setIsSubmitting(true);
    try {
      await fetchApi(buildApiUrl('/api/project-governance/challenges'), {
        method: 'POST',
        headers: getAuthorizationHeaders(),
        body: JSON.stringify({
          projectId: selectedProject.projectId,
          reason: reason.trim(),
          clientSubmittedAt: new Date().toISOString(),
          photos: photos.map(({ localId, previewObjectUrl, ...photo }) => photo)
        })
      });
      setNotice('Đã ghi nhận khiếu nại; dự án được khóa để Ủy ban Điều hành xem xét.');
      closeChallengeForm();
      await loadProjects();
    } catch (error) {
      const apiError = error as ApiErrorResponse;
      setNotice(apiError.errorCode === 'DUPLICATE_EVIDENCE_PHOTO' ? 'Một ảnh đã được dùng cho bản ghi khác. Vui lòng chụp ảnh mới.' : apiError.message || 'Không thể gửi khiếu nại.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_right,_rgba(20,184,166,0.14),_transparent_32%),linear-gradient(180deg,_#f8fffd_0%,_#f8fafc_38%,_#f8fafc_100%)] px-4 py-8 text-slate-900 sm:px-6 sm:py-10">
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="relative overflow-hidden rounded-3xl border border-emerald-900/10 bg-white px-6 py-7 shadow-[0_20px_60px_rgba(14,124,107,0.10)] sm:px-8 sm:py-9">
          <div className="absolute -right-20 -top-24 h-56 w-56 rounded-full bg-emerald-200/45 blur-3xl" aria-hidden="true" />
          <div className="relative flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-2xl">
              <p className="inline-flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-bold uppercase tracking-[0.16em] text-emerald-800">
                <span className="h-2 w-2 rounded-full bg-emerald-500" aria-hidden="true" />
                Cổng kiểm toán viên
              </p>
              <h1 className="mt-4 text-3xl font-bold tracking-tight text-slate-950 sm:text-4xl">Rà soát minh bạch, ghi nhận có căn cứ</h1>
              <p className="mt-3 max-w-xl text-sm leading-7 text-slate-600 sm:text-base">Theo dõi dự án trong giai đoạn niêm yết, gửi khiếu nại kèm minh chứng và lập biên bản thực địa cho dự án đang hoạt động.</p>
            </div>
            <div className="grid shrink-0 grid-cols-2 gap-3 sm:flex sm:gap-6" aria-label="Tóm tắt nghiệp vụ Auditor">
              <div className="border-l-2 border-emerald-500 pl-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Nghiệp vụ</p>
                <p className="mt-1 text-sm font-bold text-slate-800">02 luồng kiểm tra</p>
              </div>
              <div className="border-l-2 border-teal-200 pl-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Minh chứng</p>
                <p className="mt-1 text-sm font-bold text-slate-800">Camera &amp; vị trí</p>
              </div>
            </div>
          </div>
        </header>

        {notice && <p role="status" aria-live="polite" className="rounded-2xl border border-teal-200 bg-teal-50 px-4 py-3 text-sm leading-6 text-teal-900 shadow-sm">{notice}</p>}

        <div role="tablist" aria-label="Nghiệp vụ kiểm toán viên" className="flex gap-1 overflow-x-auto rounded-2xl border border-emerald-900/10 bg-white p-1.5 shadow-[0_8px_24px_rgba(15,23,42,0.05)]">
          <button type="button" id="auditor-challenges-tab" role="tab" aria-controls="auditor-challenges-panel" aria-selected={activeTab === 'CHALLENGES'} onClick={() => setActiveTab('CHALLENGES')} className={`min-h-11 shrink-0 rounded-xl px-4 text-sm font-bold transition focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-emerald-200 ${activeTab === 'CHALLENGES' ? 'bg-[#0e7c6b] text-white shadow-sm' : 'text-slate-600 hover:bg-emerald-50 hover:text-emerald-800'}`}>
            Khiếu nại niêm yết
          </button>
          <button type="button" id="auditor-field-reports-tab" role="tab" aria-controls="auditor-field-reports-panel" aria-selected={activeTab === 'FIELD_REPORTS'} onClick={() => setActiveTab('FIELD_REPORTS')} className={`min-h-11 shrink-0 rounded-xl px-4 text-sm font-bold transition focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-emerald-200 ${activeTab === 'FIELD_REPORTS' ? 'bg-[#0e7c6b] text-white shadow-sm' : 'text-slate-600 hover:bg-emerald-50 hover:text-emerald-800'}`}>
            Biên bản hiện trường
          </button>
        </div>

        {activeTab === 'CHALLENGES' ? (
          <section id="auditor-challenges-panel" role="tabpanel" aria-labelledby="auditor-challenges-tab" aria-busy={isProjectsLoading} className="rounded-3xl border border-emerald-900/10 bg-white p-5 shadow-[0_12px_36px_rgba(15,23,42,0.06)] sm:p-7">
            <div className="flex flex-col gap-2 border-b border-slate-100 pb-5 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.16em] text-emerald-700">Cửa sổ rà soát</p>
                <h2 className="mt-1 text-2xl font-bold tracking-tight text-slate-950">Dự án đang niêm yết</h2>
              </div>
              <p className="text-sm text-slate-500">Khiếu nại hợp lệ sẽ tạm khóa dự án để xem xét.</p>
            </div>

            {isProjectsLoading ? (
              <div className="mt-5 grid gap-4 md:grid-cols-2" aria-label="Đang tải dự án niêm yết">
                {[0, 1].map(index => <div key={index} className="h-52 animate-pulse rounded-2xl bg-slate-100" />)}
              </div>
            ) : projects.length ? (
              <div className="mt-5 grid gap-4 md:grid-cols-2">
                {projects.map(project => (
                  <article key={project.projectId} className="flex min-h-56 flex-col rounded-2xl border border-[#d7eee9] bg-[#fbfefd] p-5 transition hover:-translate-y-0.5 hover:border-emerald-300 hover:shadow-[0_12px_28px_rgba(14,124,107,0.10)]">
                    <div className="flex items-start justify-between gap-3">
                      <h3 className="text-lg font-bold leading-6 text-slate-900">{project.name}</h3>
                      <span className={`shrink-0 rounded-full border px-2.5 py-1 text-xs font-bold ${project.status === 'DISPUTED' ? 'border-amber-200 bg-amber-50 text-amber-800' : 'border-emerald-200 bg-emerald-50 text-emerald-800'}`}>{project.status === 'DISPUTED' ? 'Đang xử lý' : 'Đang niêm yết'}</span>
                    </div>
                    <p className="mt-3 text-sm leading-6 text-slate-600">{project.description || 'Dự án chưa cập nhật mô tả công khai.'}</p>
                    <div className="mt-4 rounded-xl bg-white px-3 py-2.5 text-sm leading-6 text-slate-600">
                      <span className="font-semibold text-slate-700">Trạng thái: </span>
                      {project.status === 'DISPUTED' ? 'Dự án đang được Ủy ban xét xử.' : `Dự kiến kích hoạt: ${project.activationEligibleAt ? new Date(project.activationEligibleAt).toLocaleString('vi-VN') : 'đang chờ'}`}
                    </div>
                    <div className="mt-auto pt-4">
                      {project.hasCurrentUserChallenged ? <p className="text-sm font-medium text-slate-500">Bạn đã khiếu nại dự án này.</p> : <button type="button" onClick={() => setSelectedProject(project)} className="inline-flex min-h-11 items-center justify-center rounded-xl bg-[#0e7c6b] px-4 text-sm font-bold text-white shadow-sm transition hover:bg-[#0a5c50] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-emerald-200">{project.status === 'DISPUTED' ? 'Bổ sung bằng chứng' : 'Gửi khiếu nại'}</button>}
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="mt-5 rounded-2xl border border-dashed border-emerald-200 bg-emerald-50/60 px-5 py-12 text-center">
                <p className="text-base font-bold text-slate-800">Chưa có dự án trong cửa sổ rà soát</p>
                <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-slate-600">Chỉ dự án đã được duyệt và đang niêm yết hoặc tranh chấp mới xuất hiện tại đây. Dự án ACTIVE được kiểm tra trong mục Biên bản hiện trường.</p>
                {!isActiveProjectsLoading && activeProjects.length > 0 && <div className="mx-auto mt-5 max-w-lg rounded-xl border border-emerald-200 bg-white px-4 py-4 text-left shadow-sm sm:flex sm:items-center sm:justify-between sm:gap-4">
                  <div>
                    <p className="text-sm font-bold text-slate-800">Có {activeProjects.length} dự án ACTIVE</p>
                    <p className="mt-1 text-xs leading-5 text-slate-500">Chuyển sang biên bản hiện trường để xem và lập minh chứng thực địa.</p>
                  </div>
                  <button type="button" onClick={() => setActiveTab('FIELD_REPORTS')} className="mt-3 inline-flex min-h-10 shrink-0 items-center justify-center rounded-lg bg-[#0e7c6b] px-3 text-sm font-bold text-white transition hover:bg-[#0a5c50] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-emerald-200 sm:mt-0">Xem {activeProjects.length} dự án ACTIVE</button>
                </div>}
              </div>
            )}

            {selectedProject && <form onSubmit={event => void submitChallenge(event)} className="mt-6 rounded-2xl border border-amber-200 bg-amber-50/70 p-5 sm:p-6">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <p className="text-xs font-bold uppercase tracking-[0.16em] text-amber-800">Gửi hồ sơ khiếu nại</p>
                  <h2 className="mt-1 text-xl font-bold text-slate-950">{selectedProject.name}</h2>
                </div>
                <span className="w-fit rounded-full bg-white px-3 py-1 text-xs font-bold text-amber-800 shadow-sm">Cần căn cứ rõ ràng</span>
              </div>
              <p className="mt-4 rounded-xl border border-amber-200 bg-white/80 px-4 py-3 text-sm leading-6 text-amber-950">Khiếu nại sẽ tạm khóa dự án ngay lập tức. Danh tính của bạn được lưu cùng hồ sơ; khiếu nại thiếu cơ sở có thể bị đánh dấu là quấy rối.</p>
              <div className="mt-5">
                <div className="mb-2 flex items-center justify-between gap-4">
                  <label htmlFor="auditor-challenge-reason" className="text-sm font-bold text-slate-800">Lý do khiếu nại</label>
                  <span className="text-xs font-semibold text-slate-500">Tối thiểu 30 ký tự</span>
                </div>
                <textarea id="auditor-challenge-reason" aria-label="Lý do khiếu nại" aria-describedby="auditor-challenge-reason-count" rows={5} className="w-full resize-y rounded-xl border border-amber-200 bg-white px-3 py-2.5 text-sm leading-6 text-slate-800 outline-none transition placeholder:text-slate-400 focus:border-emerald-600 focus:ring-4 focus:ring-emerald-100" minLength={30} maxLength={2000} value={reason} onChange={event => setReason(event.target.value)} required />
                <p id="auditor-challenge-reason-count" aria-live="polite" className="mt-2 text-right text-xs text-slate-500">{reason.length}/2000 ký tự</p>
              </div>
              <div className="mt-5 rounded-xl border border-amber-100 bg-white/70 p-3 sm:p-4">
                <EvidenceCameraCapture maxPhotos={5} photos={photos} onChange={setPhotos} moduleLabel="khiếu nại" disabled={isSubmitting} />
              </div>
              <div className="mt-5 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
                <button type="button" onClick={closeChallengeForm} disabled={isSubmitting} className="min-h-11 rounded-xl border border-slate-300 bg-white px-4 text-sm font-bold text-slate-700 transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-slate-200 disabled:cursor-not-allowed disabled:opacity-60">Hủy</button>
                <button type="submit" disabled={isSubmitting || reason.trim().length < 30} aria-busy={isSubmitting} className="min-h-11 rounded-xl bg-[#0e7c6b] px-4 text-sm font-bold text-white shadow-sm transition hover:bg-[#0a5c50] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-emerald-200 disabled:cursor-not-allowed disabled:opacity-60">{isSubmitting ? 'Đang gửi…' : 'Xác nhận gửi khiếu nại'}</button>
              </div>
            </form>}
          </section>
        ) : (
          <section id="auditor-field-reports-panel" role="tabpanel" aria-labelledby="auditor-field-reports-tab" aria-busy={isActiveProjectsLoading} className="rounded-3xl border border-emerald-900/10 bg-white p-5 shadow-[0_12px_36px_rgba(15,23,42,0.06)] sm:p-7">
            <div className="border-b border-slate-100 pb-5">
              <p className="text-xs font-bold uppercase tracking-[0.16em] text-emerald-700">Giám sát thực địa</p>
              <h2 className="mt-1 text-2xl font-bold tracking-tight text-slate-950">Kiểm tra dự án ACTIVE</h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">Mỗi dự án chỉ được lập một biên bản. Ảnh được xác thực từ camera, vị trí và không thể nộp đè.</p>
            </div>
            {isActiveProjectsLoading ? <div className="mt-5 h-80 animate-pulse rounded-2xl bg-slate-100" aria-label="Đang tải dự án ACTIVE" /> : <AuditorFieldReportForm projects={activeProjects} onSubmitted={loadActiveProjects} />}
          </section>
        )}
      </div>
    </main>
  );
}
