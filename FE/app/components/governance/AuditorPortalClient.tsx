'use client';

import { type ReactElement, useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { buildSameOriginApiUrl, fetchApi, type ApiErrorResponse } from '@/app/utils/apiClient';
import { clearAuthSession, readAuthSession } from '@/app/utils/authSession';
import { refreshAuthSession } from '@/app/utils/authSessionRefresh';
import AuditorFieldReportForm from './AuditorFieldReportForm';
import AuditorStakeAccountPanel from './AuditorStakeAccountPanel';
import AuditorEarningsPanel from './AuditorEarningsPanel';
import AuditorFieldReportHistory from './AuditorFieldReportHistory';
import AuditorListingHistory from './AuditorListingHistory';
import AuditorListingVerificationForm from './AuditorListingVerificationForm';
import AuditorPortalNavigation, { type AuditorPortalTab } from './AuditorPortalNavigation';

interface AuditorProject {
  projectId: string;
  name: string;
  description?: string;
  status: 'PENDING_ACTIVATION' | 'DISPUTED';
  activationEligibleAt: string | null;
  hasCurrentUserChallenged: boolean;
  hasCurrentUserVerified: boolean;
}

interface ActiveAuditorProject {
  projectId: string;
  name: string;
  milestonePlan: Array<{ milestoneIndex: number; milestoneKey: string; description: string }>;
  fieldReport?: { reportId: string } | null;
}

/** Tạo header xác thực cho các API governance cần đọc lại phiên hiện tại. */
function getAuthorizationHeaders(): HeadersInit {
  const token = (readAuthSession().accessToken || '').trim();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Nhận diện lỗi phiên theo errorCode kể cả khi proxy không giữ nguyên HTTP 401. */
function isAuthenticationError(error: unknown): boolean {
  const apiError = error as ApiErrorResponse;
  return apiError.statusCode === 401 || apiError.errorCode === 'UNAUTHENTICATED';
}

/** Hiển thị cổng Auditor gồm khiếu nại niêm yết và biên bản hiện trường độc lập. */
export default function AuditorPortalClient(): ReactElement {
  const { replace } = useRouter();
  const [projects, setProjects] = useState<AuditorProject[]>([]);
  const [activeProjects, setActiveProjects] = useState<ActiveAuditorProject[]>([]);
  const [hasLoadedActiveProjects, setHasLoadedActiveProjects] = useState(false);
  const [activeTab, setActiveTab] = useState<AuditorPortalTab>('CHALLENGES');
  const [selectedProject, setSelectedProject] = useState<AuditorProject | null>(null);
  const [notice, setNotice] = useState('');
  const [isProjectsLoading, setIsProjectsLoading] = useState(true);
  const [isActiveProjectsLoading, setIsActiveProjectsLoading] = useState(true);

  /** Tải tài nguyên Auditor và làm mới phiên một lần khi access token vừa bị thu hồi. */
  const fetchAuditorResourceWithRefresh = useCallback(async <T,>(pathname: string): Promise<T | null> => {
    try {
      const response = await fetchApi<T>(buildSameOriginApiUrl(pathname), { headers: getAuthorizationHeaders() });
      return response.data;
    } catch (error) {
      if (!isAuthenticationError(error)) {
        throw error;
      }

      const refreshResult = await refreshAuthSession();
      if (refreshResult.status === 'REFRESHED') {
        const response = await fetchApi<T>(buildSameOriginApiUrl(pathname), { headers: getAuthorizationHeaders() });
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
        setHasLoadedActiveProjects(true);
      }
    } catch (error) {
      setNotice((error as ApiErrorResponse).message || 'Không thể tải danh sách dự án ACTIVE.');
    } finally {
      setIsActiveProjectsLoading(false);
    }
  }, [fetchAuditorResourceWithRefresh]);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  /** Mở ngay khu vực cọc khi PayOS trả Auditor về portal để tiếp tục đối soát phiếu nạp. */
  useEffect(() => {
    const searchParams = new URLSearchParams(window.location.search);
    if (searchParams.get('paymentFlow') === 'auditor_portal' && /^\d{1,20}$/.test(searchParams.get('orderCode') || '')) {
      setActiveTab('STAKE');
    }
  }, []);

  /** Chỉ tải dự án ACTIVE khi Auditor thực sự mở nghiệp vụ biên bản hiện trường. */
  useEffect(() => {
    if (activeTab === 'FIELD_REPORTS' && !hasLoadedActiveProjects) void loadActiveProjects();
  }, [activeTab, hasLoadedActiveProjects, loadActiveProjects]);

  /** Chuyển người không có vai trò Auditor về trang báo không đủ quyền sau khi phiên đã hydrate. */
  useEffect(() => {
    const userRole = readAuthSession().userRole;
    if (userRole && userRole !== 'auditor') replace('/unauthorized');
  }, [replace]);

  /** Đóng form xác minh đã tách thành component độc lập. */
  const closeChallengeForm = (): void => {
    setSelectedProject(null);
  };

  /** Xoá toàn bộ dữ liệu phiên Auditor ở client và đưa người dùng về màn hình đăng nhập. */
  const handleLogout = (): void => {
    clearAuthSession();
    setSelectedProject(null);
    replace('/login');
  };

  return (
    <>
      <AuditorPortalNavigation activeTab={activeTab} onTabChange={setActiveTab} onLogout={handleLogout} />
      <main className="min-h-screen w-full overflow-x-clip bg-[radial-gradient(circle_at_top_right,_rgba(20,184,166,0.14),_transparent_32%),linear-gradient(180deg,_#f8fffd_0%,_#f8fafc_38%,_#f8fafc_100%)] px-3 py-5 text-slate-900 sm:px-6 sm:py-10">
        <div className="mx-auto min-w-0 max-w-6xl space-y-5 sm:space-y-6">
        <header className="relative min-w-0 overflow-hidden rounded-3xl border border-emerald-900/10 bg-white px-4 py-6 shadow-[0_20px_60px_rgba(14,124,107,0.10)] sm:px-8 sm:py-9">
          <div className="absolute -right-20 -top-24 h-56 w-56 rounded-full bg-emerald-200/45 blur-3xl" aria-hidden="true" />
          <div className="relative flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div className="min-w-0 max-w-2xl">
              <p className="inline-flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-bold uppercase tracking-[0.16em] text-emerald-800">
                <span className="h-2 w-2 rounded-full bg-emerald-500" aria-hidden="true" />
                Cổng kiểm toán viên
              </p>
              <h1 className="mt-4 break-words text-3xl font-bold tracking-tight text-slate-950 sm:text-4xl">Rà soát minh bạch, ghi nhận có căn cứ</h1>
              <p className="mt-3 max-w-xl text-sm leading-7 text-slate-600 sm:text-base">Theo dõi dự án trong giai đoạn niêm yết, gửi kết quả xác minh kèm minh chứng và lập biên bản thực địa cho dự án đang hoạt động.</p>
            </div>
            <div className="grid min-w-0 shrink-0 grid-cols-2 gap-3 sm:flex sm:gap-6" aria-label="Tóm tắt nghiệp vụ Auditor">
              <div className="border-l-2 border-emerald-500 pl-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Nghiệp vụ</p>
                <p className="mt-1 text-sm font-bold text-slate-800">04 nghiệp vụ</p>
              </div>
              <div className="border-l-2 border-teal-200 pl-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Minh chứng</p>
                <p className="mt-1 break-words text-sm font-bold text-slate-800">Camera &amp; vị trí</p>
              </div>
            </div>
          </div>
        </header>

        {notice && <p role="status" aria-live="polite" className="rounded-2xl border border-teal-200 bg-teal-50 px-4 py-3 text-sm leading-6 text-teal-900 shadow-sm">{notice}</p>}

        {activeTab === 'STAKE' ? <AuditorStakeAccountPanel isActive fetchAuditorResource={fetchAuditorResourceWithRefresh} /> : activeTab === 'EARNINGS' ? <AuditorEarningsPanel isActive fetchAuditorResource={fetchAuditorResourceWithRefresh} /> : activeTab === 'CHALLENGES' ? (
          <section id="auditor-challenges-panel" role="tabpanel" aria-labelledby="auditor-challenges-tab" aria-busy={isProjectsLoading} className="min-w-0 rounded-3xl border border-emerald-900/10 bg-white p-4 shadow-[0_12px_36px_rgba(15,23,42,0.06)] sm:p-7">
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
                  <article key={project.projectId} className="flex min-h-56 min-w-0 flex-col rounded-2xl border border-[#d7eee9] bg-[#fbfefd] p-4 transition hover:-translate-y-0.5 hover:border-emerald-300 hover:shadow-[0_12px_28px_rgba(14,124,107,0.10)] sm:p-5">
                    <div className="flex min-w-0 flex-col items-start gap-2 sm:flex-row sm:justify-between sm:gap-3">
                      <h3 className="min-w-0 break-words text-lg font-bold leading-6 text-slate-900">{project.name}</h3>
                      <span className={`shrink-0 rounded-full border px-2.5 py-1 text-xs font-bold ${project.status === 'DISPUTED' ? 'border-amber-200 bg-amber-50 text-amber-800' : 'border-emerald-200 bg-emerald-50 text-emerald-800'}`}>{project.status === 'DISPUTED' ? 'Đang xử lý' : 'Đang niêm yết'}</span>
                    </div>
                    <p className="mt-3 text-sm leading-6 text-slate-600">{project.description || 'Dự án chưa cập nhật mô tả công khai.'}</p>
                    <div className="mt-4 rounded-xl bg-white px-3 py-2.5 text-sm leading-6 text-slate-600">
                      <span className="font-semibold text-slate-700">Trạng thái: </span>
                      {project.status === 'DISPUTED' ? 'Dự án đang được Ủy ban xét xử.' : `Dự kiến kích hoạt: ${project.activationEligibleAt ? new Date(project.activationEligibleAt).toLocaleString('vi-VN') : 'đang chờ'}`}
                    </div>
                    <div className="mt-auto pt-4">
                      {project.hasCurrentUserChallenged || project.hasCurrentUserVerified ? <p className="text-sm font-medium text-slate-500">Bạn đã gửi kết quả xác minh cho dự án này.</p> : <button type="button" onClick={() => setSelectedProject(project)} className="inline-flex min-h-11 w-full items-center justify-center rounded-xl bg-[#0e7c6b] px-4 text-sm font-bold text-white shadow-sm transition hover:bg-[#0a5c50] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-emerald-200 sm:w-auto">Chụp xác minh thực địa</button>}
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="mt-5 rounded-2xl border border-dashed border-emerald-200 bg-emerald-50/60 px-5 py-12 text-center">
                <p className="text-base font-bold text-slate-800">Chưa có dự án trong cửa sổ rà soát</p>
                <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-slate-600">Chỉ dự án đã được duyệt và đang niêm yết hoặc tranh chấp mới xuất hiện tại đây. Dự án ACTIVE được kiểm tra trong mục Biên bản hiện trường.</p>
                {!isActiveProjectsLoading && activeProjects.length > 0 && <div className="mx-auto mt-5 max-w-lg min-w-0 rounded-xl border border-emerald-200 bg-white px-4 py-4 text-left shadow-sm sm:flex sm:items-center sm:justify-between sm:gap-4">
                  <div>
                    <p className="text-sm font-bold text-slate-800">Có {activeProjects.length} dự án đang hoạt động</p>
                    <p className="mt-1 text-xs leading-5 text-slate-500">Chuyển sang biên bản hiện trường để xem và lập minh chứng thực địa.</p>
                  </div>
                  <button type="button" onClick={() => setActiveTab('FIELD_REPORTS')} className="mt-3 inline-flex min-h-10 w-full shrink-0 items-center justify-center rounded-lg bg-[#0e7c6b] px-3 text-sm font-bold text-white transition hover:bg-[#0a5c50] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-emerald-200 sm:mt-0 sm:w-auto">Xem {activeProjects.length} dự án đang hoạt động</button>
                </div>}
              </div>
            )}

            {selectedProject && <AuditorListingVerificationForm projectId={selectedProject.projectId} projectName={selectedProject.name} onCompleted={loadProjects} onClose={closeChallengeForm} />}
            <AuditorListingHistory fetchAuditorResource={fetchAuditorResourceWithRefresh} />
          </section>
        ) : (
          <section id="auditor-field-reports-panel" role="tabpanel" aria-labelledby="auditor-field-reports-tab" aria-busy={isActiveProjectsLoading} className="min-w-0 rounded-3xl border border-emerald-900/10 bg-white p-4 shadow-[0_12px_36px_rgba(15,23,42,0.06)] sm:p-7">
            <div className="border-b border-slate-100 pb-5">
              <p className="text-xs font-bold uppercase tracking-[0.16em] text-emerald-700">Giám sát thực địa</p>
              <h2 className="mt-1 text-2xl font-bold tracking-tight text-slate-950">Kiểm tra dự án đang hoạt động</h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">Mỗi dự án chỉ được lập một biên bản. Ảnh được xác thực từ camera, vị trí và không thể nộp đè.</p>
            </div>
            {isActiveProjectsLoading ? <div className="mt-5 h-80 animate-pulse rounded-2xl bg-slate-100" aria-label="Đang tải dự án ACTIVE" /> : <AuditorFieldReportForm projects={activeProjects} onSubmitted={loadActiveProjects} />}
            {!isActiveProjectsLoading && <AuditorFieldReportHistory fetchAuditorResource={fetchAuditorResourceWithRefresh} />}
          </section>
        )}
        </div>
      </main>
    </>
  );
}
