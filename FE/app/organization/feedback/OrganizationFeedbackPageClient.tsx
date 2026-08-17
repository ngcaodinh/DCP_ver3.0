'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import ToastStack from '@/app/components/systemAdmin/tailwind/ToastStack';
import type { ToastItem } from '@/app/components/systemAdmin/tailwind/types';
import { BatchUploadModal } from '@/app/components/organizationFeedback/BatchUploadModal';
import { FeedbackStatsChart } from '@/app/components/organizationFeedback/FeedbackStatsChart';
import { OrganizationFeedbackTable } from '@/app/components/organizationFeedback/OrganizationFeedbackTable';
import { downloadFeedbackCsv } from '@/app/components/organizationFeedback/exportFeedbackCsv';
import {
  EXPORT_MAX_ROWS,
  EXPORT_PAGE_LIMIT,
  ORGANIZATION_ROLE_VALUES,
  type BatchUploadResult,
  type FeedbackSource,
  type ModerationState,
  type OrganizationFeedbackListResponse,
  type OrganizationProjectOption
} from '@/app/components/organizationFeedback/types';
import { buildApiUrl, fetchApi, type ApiErrorResponse } from '@/app/utils/apiClient';
import { readAuthSession } from '@/app/utils/authSession';

const PAGE_LIMIT = 20;
const MAX_PAGE = 10_000;

/** Điều phối auth gate, URL filter, query dữ liệu, upload và export của trang organization feedback. */
export default function OrganizationFeedbackPageClient(): ReactElement | null {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [authState, setAuthState] = useState<'checking' | 'ready' | 'denied'>('checking');
  const [accessToken, setAccessToken] = useState('');
  const [page, setPage] = useState(() => readPageFromUrl(searchParams));
  const [projectId, setProjectId] = useState(() => searchParams.get('projectId') ?? '');
  const [source, setSource] = useState<FeedbackSource | ''>(() => readSourceFromUrl(searchParams));
  const [moderationState, setModerationState] = useState<ModerationState>(() => readModerationStateFromUrl(searchParams));
  const [isUploadOpen, setIsUploadOpen] = useState(false);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const uploadTriggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    setPage(readPageFromUrl(searchParams));
    setProjectId(searchParams.get('projectId') ?? '');
    setSource(readSourceFromUrl(searchParams));
    setModerationState(readModerationStateFromUrl(searchParams));
  }, [searchParams]);

  useEffect(() => {
    const session = readAuthSession();
    if (!session.accessToken) {
      router.replace('/login');
      setAuthState('denied');
      return;
    }
    if (!ORGANIZATION_ROLE_VALUES.includes(session.userRole as typeof ORGANIZATION_ROLE_VALUES[number])) {
      router.replace('/unauthorized');
      setAuthState('denied');
      return;
    }
    setAccessToken(session.accessToken);
    setAuthState('ready');
  }, [router]);

  const queryFilters = useMemo(() => ({
    page,
    limit: PAGE_LIMIT,
    projectId,
    source,
    moderationState
  }), [moderationState, page, projectId, source]);

  const feedbackQuery = useQuery({
    queryKey: ['organization-feedback', queryFilters],
    enabled: authState === 'ready' && Boolean(accessToken),
    retry: false,
    queryFn: async (): Promise<OrganizationFeedbackListResponse> => {
      const params = new URLSearchParams({
        page: String(page),
        limit: String(PAGE_LIMIT),
        moderationState
      });
      if (projectId) params.set('projectId', projectId);
      if (source) params.set('source', source);
      const response = await fetchApi<OrganizationFeedbackListResponse>(
        buildApiUrl(`/api/feedback/organization?${params.toString()}`),
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      return response.data;
    }
  });

  const projectsQuery = useQuery({
    queryKey: ['organization-project-options'],
    enabled: authState === 'ready' && Boolean(accessToken),
    retry: false,
    queryFn: async (): Promise<OrganizationProjectOption[]> => {
      const response = await fetchApi<OrganizationProjectOption[]>(
        buildApiUrl('/projects'),
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      return response.data;
    }
  });

  const data = feedbackQuery.data;
  const errorMessage = getErrorMessage(feedbackQuery.error);
  const hasActiveFilters = Boolean(projectId || source || moderationState !== 'all');

  useEffect(() => {
    if (feedbackQuery.error) {
      redirectForAuthorizationError(feedbackQuery.error, router);
    }
  }, [feedbackQuery.error, router]);

  useEffect(() => {
    if (!data || data.page === page) return;
    setPage(data.page);
    replaceUrl(router, data.page, projectId, source, moderationState);
  }, [data, moderationState, page, projectId, router, source]);

  /** Thêm toast bounded và tự dọn sau bốn giây theo convention các panel hiện có. */
  const addToast = useCallback((toast: Omit<ToastItem, 'id'>): void => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts(previous => [...previous, { ...toast, id }]);
    window.setTimeout(() => setToasts(previous => previous.filter(item => item.id !== id)), 4_000);
  }, []);

  /** Xóa toast khi người dùng đóng thủ công. */
  const removeToast = useCallback((toastId: string): void => {
    setToasts(previous => previous.filter(item => item.id !== toastId));
  }, []);

  /** Cập nhật một filter và reset về trang đầu để tránh deep-link tới trang không còn dữ liệu. */
  const updateFilter = useCallback((next: Partial<{ projectId: string; source: FeedbackSource | ''; moderationState: ModerationState }>): void => {
    const nextProjectId = next.projectId ?? projectId;
    const nextSource = next.source ?? source;
    const nextModerationState = next.moderationState ?? moderationState;
    setPage(1);
    setProjectId(nextProjectId);
    setSource(nextSource);
    setModerationState(nextModerationState);
    replaceUrl(router, 1, nextProjectId, nextSource, nextModerationState);
  }, [moderationState, projectId, router, source]);

  /** Gọi lại danh sách sau upload để thống kê và bảng phản ánh batch mới ngay lập tức. */
  const handleUploaded = useCallback((result: BatchUploadResult): void => {
    if (!result.isDuplicate && result.success > 0) {
      addToast({ titleText: 'Upload thành công', bodyText: `Đã tiếp nhận ${result.success} phản hồi.`, tone: 'success' });
    }
    void feedbackQuery.refetch();
  }, [addToast, feedbackQuery]);

  /** Gom tối đa 20 trang dữ liệu hiện tại để xuất báo cáo mà không mở endpoint export mới. */
  const handleExport = useCallback(async (): Promise<void> => {
    if (!data || data.total === 0) return;
    const exportablePageCount = Math.ceil(data.total / EXPORT_PAGE_LIMIT);
    const pageCount = Math.min(exportablePageCount, Math.ceil(EXPORT_MAX_ROWS / EXPORT_PAGE_LIMIT));
    const exportedItems = [] as OrganizationFeedbackListResponse['items'];
    try {
      for (let exportPage = 1; exportPage <= pageCount; exportPage += 1) {
        // Gọi tuần tự để giữ mức tải ổn định trong giới hạn rate limit của endpoint đọc.
        const params = new URLSearchParams({
          page: String(exportPage),
          limit: String(EXPORT_PAGE_LIMIT),
          moderationState
        });
        if (projectId) params.set('projectId', projectId);
        if (source) params.set('source', source);
        const response = await fetchApi<OrganizationFeedbackListResponse>(
          buildApiUrl(`/api/feedback/organization?${params.toString()}`),
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        exportedItems.push(...response.data.items);
      }
      if (data.total > EXPORT_MAX_ROWS) {
        addToast({ titleText: 'Báo cáo đã được cắt', bodyText: 'Chỉ xuất 2000 dòng đầu tiên theo giới hạn báo cáo.', tone: 'warning' });
      }
      downloadFeedbackCsv(exportedItems.slice(0, EXPORT_MAX_ROWS));
    } catch (error) {
      if (redirectForAuthorizationError(error, router)) return;
      const statusCode = (error as Partial<ApiErrorResponse>)?.statusCode;
      if (statusCode === 429 && exportedItems.length > 0) {
        downloadFeedbackCsv(exportedItems.slice(0, EXPORT_MAX_ROWS));
        addToast({
          titleText: 'Xuất CSV chưa đầy đủ',
          bodyText: `Đã tải được ${Math.min(exportedItems.length, EXPORT_MAX_ROWS)} dòng trước khi chạm giới hạn. Vui lòng thử lại sau.`,
          tone: 'warning'
        });
        return;
      }
      addToast({ titleText: 'Xuất CSV thất bại', bodyText: getErrorMessage(error) ?? 'Vui lòng thử lại sau.', tone: 'error' });
    }
  }, [accessToken, addToast, data, moderationState, projectId, router, source]);

  if (authState === 'checking') {
    return <div className="flex min-h-screen items-center justify-center bg-slate-50 text-sm text-slate-500">Đang xác thực quyền truy cập...</div>;
  }
  if (authState === 'denied') return null;

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-6 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl">
        <nav className="mb-2 text-xs text-slate-400">
          <a href="/organization" className="hover:text-slate-600">Tổ chức</a>
          <span className="mx-1.5">›</span>
          <span className="font-medium text-slate-600">Quản lý feedback</span>
        </nav>
        <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Quản lý feedback</h1>
            <p className="mt-1 text-sm text-slate-500">Theo dõi phản hồi đã gửi, upload theo lô và xuất báo cáo.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button ref={uploadTriggerRef} type="button" onClick={() => setIsUploadOpen(true)} className="rounded-md bg-emerald-600 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-700">Tải feedback theo lô</button>
            <button type="button" onClick={() => void handleExport()} disabled={!data || data.total === 0 || feedbackQuery.isLoading} className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50">Xuất CSV</button>
            <button type="button" onClick={() => void feedbackQuery.refetch()} className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">Làm mới</button>
          </div>
        </div>

        {data && <FeedbackStatsChart stats={data.stats} />}
        {feedbackQuery.isLoading && <div aria-label="Đang tải feedback" className="mt-4 h-36 animate-pulse rounded-xl bg-white" />}

        <section className="mt-5 rounded-xl border border-slate-200 bg-white p-4 shadow-sm" aria-label="Bộ lọc feedback">
          <div className="grid gap-3 md:grid-cols-3">
            <label className="text-xs font-semibold text-slate-600">Dự án
              <select aria-label="Lọc theo dự án" value={projectId} onChange={event => updateFilter({ projectId: event.target.value })} className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-normal text-slate-700">
                <option value="">Tất cả dự án</option>
                {(projectsQuery.data ?? []).map(project => <option key={project.projectId} value={project.projectId}>{project.name}</option>)}
              </select>
              {projectsQuery.error && <span className="mt-1 block text-[11px] font-normal text-amber-700">Không thể tải danh sách dự án; bộ lọc dự án tạm thời không khả dụng.</span>}
            </label>
            <label className="text-xs font-semibold text-slate-600">Nguồn
              <select aria-label="Lọc theo nguồn" value={source} onChange={event => updateFilter({ source: event.target.value as FeedbackSource | '' })} className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-normal text-slate-700">
                <option value="">Tất cả nguồn</option>
                <option value="batch">Batch</option>
                <option value="public">Public</option>
              </select>
            </label>
            <label className="text-xs font-semibold text-slate-600">Trạng thái
              <select aria-label="Lọc theo trạng thái moderation" value={moderationState} onChange={event => updateFilter({ moderationState: event.target.value as ModerationState })} className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-normal text-slate-700">
                <option value="all">Tất cả</option>
                <option value="visible">Đang hiển thị</option>
                <option value="pending">Đang chờ duyệt</option>
              </select>
            </label>
          </div>
        </section>

        {errorMessage && (
          <div role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
            <p>{errorMessage}</p>
            <button type="button" onClick={() => void feedbackQuery.refetch()} className="mt-2 font-medium underline">Thử lại</button>
          </div>
        )}

        {!feedbackQuery.isLoading && !errorMessage && data && data.items.length === 0 && (
          <div className="mt-4 rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center">
            <p className="text-sm font-semibold text-slate-800">{hasActiveFilters ? 'Không có phản hồi phù hợp bộ lọc.' : 'Chưa có phản hồi nào'}</p>
            <p className="mt-2 text-sm text-slate-500">{hasActiveFilters ? 'Thử xóa bộ lọc để xem toàn bộ dữ liệu.' : 'Hãy upload file CSV để bắt đầu quản lý feedback.'}</p>
            <div className="mt-4 flex justify-center gap-2">
              {hasActiveFilters && <button type="button" onClick={() => updateFilter({ projectId: '', source: '', moderationState: 'all' })} className="rounded-md border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700">Xóa bộ lọc</button>}
              <button type="button" onClick={() => setIsUploadOpen(true)} className="rounded-md bg-emerald-600 px-3 py-2 text-sm font-semibold text-white">Mở modal upload</button>
            </div>
          </div>
        )}

        {!feedbackQuery.isLoading && !errorMessage && data && data.items.length > 0 && (
          <>
            <div className="mt-4"><OrganizationFeedbackTable items={data.items} /></div>
            <div className="mt-4 flex items-center justify-between text-sm text-slate-600">
              <span>{data.total} bản ghi</span>
              <div className="flex items-center gap-2">
                <button type="button" disabled={page <= 1} onClick={() => moveToPage(router, page - 1, projectId, source, moderationState, setPage)} className="rounded-md border border-slate-300 bg-white px-3 py-1.5 disabled:cursor-not-allowed disabled:opacity-40">Trước</button>
                <span>Trang {data.page} / {Math.max(data.totalPages, 1)}</span>
                <button type="button" disabled={page >= data.totalPages} onClick={() => moveToPage(router, page + 1, projectId, source, moderationState, setPage)} className="rounded-md border border-slate-300 bg-white px-3 py-1.5 disabled:cursor-not-allowed disabled:opacity-40">Sau</button>
              </div>
            </div>
          </>
        )}
      </div>

      <BatchUploadModal
        isOpen={isUploadOpen}
        accessToken={accessToken}
        onClose={() => setIsUploadOpen(false)}
        onUploaded={handleUploaded}
        onUnauthorized={() => router.replace('/login')}
        onForbidden={() => router.replace('/unauthorized')}
        onNotice={(message, tone) => addToast({ titleText: tone === 'warning' ? 'Cần chú ý' : 'Upload feedback', bodyText: message, tone })}
        returnFocusRef={uploadTriggerRef}
      />
      <ToastStack toastItemList={toasts} onCloseToast={removeToast} />
    </main>
  );
}

/** Đọc page từ URL và giới hạn theo contract validator BE. */
function readPageFromUrl(searchParams: Readonly<URLSearchParams>): number {
  const value = Number(searchParams.get('page') ?? '1');
  return Number.isInteger(value) && value >= 1 ? Math.min(value, MAX_PAGE) : 1;
}

/** Đọc filter source hợp lệ từ URL, fallback về tất cả. */
function readSourceFromUrl(searchParams: Readonly<URLSearchParams>): FeedbackSource | '' {
  const value = searchParams.get('source');
  return value === 'batch' || value === 'public' ? value : '';
}

/** Đọc filter moderation hợp lệ từ URL, fallback về all. */
function readModerationStateFromUrl(searchParams: Readonly<URLSearchParams>): ModerationState {
  const value = searchParams.get('moderationState');
  return value === 'visible' || value === 'pending' ? value : 'all';
}

/** Đồng bộ URL state để deep-link và back/forward giữ đúng filter hiện tại. */
function replaceUrl(
  router: ReturnType<typeof useRouter>,
  nextPage: number,
  projectId: string,
  source: FeedbackSource | '',
  moderationState: ModerationState
): void {
  const params = new URLSearchParams({ page: String(nextPage), limit: String(PAGE_LIMIT), moderationState });
  if (projectId) params.set('projectId', projectId);
  if (source) params.set('source', source);
  router.replace(`/organization/feedback?${params.toString()}`, { scroll: false });
}

/** Di chuyển trang nhưng giữ nguyên toàn bộ bộ lọc đang áp dụng. */
function moveToPage(
  router: ReturnType<typeof useRouter>,
  nextPage: number,
  projectId: string,
  source: FeedbackSource | '',
  moderationState: ModerationState,
  setPage: (value: number) => void
): void {
  const boundedPage = Math.min(MAX_PAGE, Math.max(1, nextPage));
  setPage(boundedPage);
  replaceUrl(router, boundedPage, projectId, source, moderationState);
}

/** Lấy thông báo an toàn từ lỗi API mà không đẩy raw stack trace ra giao diện. */
function getErrorMessage(error: unknown): string | null {
  if (!error) return null;
  const apiError = error as Partial<ApiErrorResponse>;
  if (apiError.statusCode === 401) return 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.';
  if (apiError.statusCode === 403) return 'Tài khoản không có quyền xem feedback của tổ chức.';
  return typeof apiError.message === 'string' ? apiError.message : 'Không thể tải feedback. Vui lòng thử lại.';
}

/** Điều hướng về đúng boundary khi API xác nhận session hết hạn hoặc role không hợp lệ. */
function redirectForAuthorizationError(
  error: unknown,
  router: ReturnType<typeof useRouter>
): boolean {
  const statusCode = (error as Partial<ApiErrorResponse>)?.statusCode;
  if (statusCode === 401) {
    router.replace('/login');
    return true;
  }
  if (statusCode === 403) {
    router.replace('/unauthorized');
    return true;
  }
  return false;
}
