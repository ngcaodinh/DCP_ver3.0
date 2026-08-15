'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import FeedbackActionDialog from '@/app/components/adminFeedback/FeedbackActionDialog';
import { FeedbackDetailModal } from '@/app/components/adminFeedback/FeedbackDetailModal';
import { FeedbackFlaggingPanel } from '@/app/components/adminFeedback/FeedbackFlaggingPanel';
import type {
  DeletionState,
  FeedbackActionMode,
  FlaggedFeedbackItem,
  FlaggedFeedbackListResponse
} from '@/app/components/adminFeedback/types';
import ToastStack from '@/app/components/systemAdmin/tailwind/ToastStack';
import type { ToastItem } from '@/app/components/systemAdmin/tailwind/types';
import { buildApiUrl, fetchApi, type ApiErrorResponse } from '@/app/utils/apiClient';
import { readAuthSession } from '@/app/utils/authSession';

const MAX_PAGE = 10_000;
const PAGE_LIMIT = 20;

interface ActionState {
  item: FlaggedFeedbackItem;
  mode: FeedbackActionMode;
}

/** Trang admin điều phối auth, URL state, server query và action lifecycle của feedback panel. */
export default function FeedbackFlaggingPageClient(): ReactElement | null {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialDeletionState = useMemo(() => readDeletionStateFromUrl(searchParams), [searchParams]);
  const initialPage = useMemo(() => readPageFromUrl(searchParams), [searchParams]);
  const [authState, setAuthState] = useState<'checking' | 'ready' | 'denied'>('checking');
  const [accessToken, setAccessToken] = useState('');
  const [deletionState, setDeletionState] = useState<DeletionState>(initialDeletionState);
  const [page, setPage] = useState(initialPage);
  const [selectedDetail, setSelectedDetail] = useState<FlaggedFeedbackItem | null>(null);
  const [actionState, setActionState] = useState<ActionState | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const returnFocusRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    setDeletionState(readDeletionStateFromUrl(searchParams));
    setPage(readPageFromUrl(searchParams));
  }, [searchParams]);

  useEffect(() => {
    const session = readAuthSession();
    if (!session.accessToken) {
      router.replace('/login');
      setAuthState('denied');
      return;
    }
    if (session.userRole !== 'admin') {
      router.replace('/unauthorized');
      setAuthState('denied');
      return;
    }
    setAccessToken(session.accessToken);
    setAuthState('ready');
  }, [router]);

  const feedbackQuery = useQuery({
    queryKey: ['admin-flagged-feedback', page, deletionState],
    enabled: authState === 'ready' && Boolean(accessToken),
    retry: false,
    queryFn: async (): Promise<FlaggedFeedbackListResponse> => {
      const params = new URLSearchParams({
        page: String(page),
        limit: String(PAGE_LIMIT),
        deletionState
      });
      const response = await fetchApi<FlaggedFeedbackListResponse>(
        buildApiUrl(`/api/feedback/flagged?${params.toString()}`),
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      return response.data;
    }
  });

  const data = feedbackQuery.data;
  const errorMessage = getErrorMessage(feedbackQuery.error);

  useEffect(() => {
    if (!data || page <= Math.max(data.totalPages, 1)) return;
    const validPage = Math.min(MAX_PAGE, Math.max(1, data.totalPages));
    setPage(validPage);
    replaceUrl(router, validPage, deletionState);
  }, [data, deletionState, page, router]);

  /** Thêm toast bounded và tự dọn sau 4 giây theo convention admin hiện có. */
  const addToast = useCallback((toast: Omit<ToastItem, 'id'>) => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts(previous => [...previous, { ...toast, id }]);
    window.setTimeout(() => setToasts(previous => previous.filter(item => item.id !== id)), 4_000);
  }, []);

  /** Xóa toast khi admin đóng thủ công. */
  const removeToast = useCallback((toastId: string) => {
    setToasts(previous => previous.filter(item => item.id !== toastId));
  }, []);

  /** Chuyển tab bằng URL state để deep-link và back/forward giữ đúng danh sách. */
  const handleChangeDeletionState = useCallback((nextState: DeletionState) => {
    setDeletionState(nextState);
    setPage(1);
    replaceUrl(router, 1, nextState);
  }, [router]);

  /** Ghi nhận trigger button để dialog trả focus đúng phần tử sau khi đóng. */
  const handleViewDetail = useCallback((item: FlaggedFeedbackItem, trigger: HTMLButtonElement) => {
    returnFocusRef.current = trigger;
    setSelectedDetail(item);
  }, []);

  /** Mở dialog action với item và mode hiện tại. */
  const handleAction = useCallback((item: FlaggedFeedbackItem, mode: FeedbackActionMode, trigger: HTMLButtonElement) => {
    returnFocusRef.current = trigger;
    setActionState({ item, mode });
  }, []);

  /** Sau action thành công, refetch list và đưa restore về tab active theo Q18. */
  const handleActionSuccess = useCallback((mode: FeedbackActionMode) => {
    addToast({
      titleText: mode === 'restore' ? 'Khôi phục thành công' : mode === 'delete' ? 'Đã xoá feedback' : 'Đã bỏ flag feedback',
      bodyText: mode === 'restore'
        ? 'Feedback đã quay lại danh sách đang bị flag, chưa hiển thị công khai.'
        : 'Danh sách và thống kê project đã được làm mới.',
      tone: 'success'
    });
    if (mode === 'restore') {
      setDeletionState('active');
      setPage(1);
      replaceUrl(router, 1, 'active');
    }
    void feedbackQuery.refetch();
  }, [addToast, feedbackQuery, router]);

  /** Refresh sau conflict/404 để UI phản ánh trạng thái thắng của request khác. */
  const handleActionRefresh = useCallback(async () => {
    await feedbackQuery.refetch();
  }, [feedbackQuery]);

  /** Hiển thị conflict/restore expiry dưới dạng toast theo severity thay vì lỗi đỏ mặc định. */
  const handleActionNotice = useCallback((message: string, tone: 'info' | 'warning' | 'error') => {
    addToast({
      titleText: tone === 'info' ? 'Danh sách đã được làm mới' : tone === 'warning' ? 'Cần chú ý' : 'Thao tác thất bại',
      bodyText: message,
      tone
    });
  }, [addToast]);

  if (authState === 'checking') {
    return <div className="flex min-h-screen items-center justify-center bg-slate-50 text-sm text-slate-500">Đang xác thực quyền truy cập...</div>;
  }
  if (authState === 'denied') return null;

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-6 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl">
        <nav className="mb-2 text-xs text-slate-400">
          <a href="/admin" className="hover:text-slate-600">Admin</a>
          <span className="mx-1.5">›</span>
          <span className="font-medium text-slate-600">Feedback bị flag</span>
        </nav>
        <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Feedback Flagging Panel</h1>
            <p className="mt-1 text-sm text-slate-500">Review feedback bị flag, lý do và cửa sổ khôi phục 30 ngày.</p>
          </div>
          <button type="button" onClick={() => void feedbackQuery.refetch()} className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100">Làm mới</button>
        </div>

        <div className="mb-5 flex gap-2 border-b border-slate-200" role="tablist" aria-label="Trạng thái feedback">
          <button type="button" role="tab" aria-selected={deletionState === 'active'} onClick={() => handleChangeDeletionState('active')} className={`border-b-2 px-3 py-2 text-sm font-semibold ${deletionState === 'active' ? 'border-emerald-600 text-emerald-700' : 'border-transparent text-slate-500'}`}>Đang bị flag</button>
          <button type="button" role="tab" aria-selected={deletionState === 'deleted'} onClick={() => handleChangeDeletionState('deleted')} className={`border-b-2 px-3 py-2 text-sm font-semibold ${deletionState === 'deleted' ? 'border-amber-600 text-amber-700' : 'border-transparent text-slate-500'}`}>Đã xoá</button>
        </div>

        {feedbackQuery.isLoading && <FeedbackFlaggingPanel items={[]} deletionState={deletionState} isLoading onViewDetail={handleViewDetail} onAction={handleAction} />}
        {errorMessage && (
          <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
            <p>{errorMessage}</p>
            <button type="button" onClick={() => void feedbackQuery.refetch()} className="mt-2 font-medium underline">Thử lại</button>
          </div>
        )}
        {!feedbackQuery.isLoading && !errorMessage && data && (
          <>
            <FeedbackFlaggingPanel items={data.items} deletionState={deletionState} isLoading={false} onViewDetail={handleViewDetail} onAction={handleAction} />
            <div className="mt-4 flex items-center justify-between text-sm text-slate-600">
              <span>{data.total} bản ghi</span>
              <div className="flex items-center gap-2">
                <button type="button" disabled={page <= 1} onClick={() => moveToPage(router, page - 1, deletionState, setPage)} className="rounded-md border border-slate-300 bg-white px-3 py-1.5 disabled:cursor-not-allowed disabled:opacity-40">Trước</button>
                <span>Trang {data.page} / {Math.max(data.totalPages, 1)}</span>
                <button type="button" disabled={page >= data.totalPages} onClick={() => moveToPage(router, page + 1, deletionState, setPage)} className="rounded-md border border-slate-300 bg-white px-3 py-1.5 disabled:cursor-not-allowed disabled:opacity-40">Sau</button>
              </div>
            </div>
          </>
        )}
      </div>

      {selectedDetail && <FeedbackDetailModal item={selectedDetail} deletionState={deletionState} onClose={() => setSelectedDetail(null)} returnFocusRef={returnFocusRef} />}
      {actionState && (
        <FeedbackActionDialog
          feedbackId={actionState.item.feedbackId}
          mode={actionState.mode}
          onClose={() => setActionState(null)}
          onSuccess={handleActionSuccess}
          onRefresh={handleActionRefresh}
          onForbidden={() => router.replace('/unauthorized')}
          onNotice={handleActionNotice}
          returnFocusRef={returnFocusRef}
        />
      )}
      <ToastStack toastItemList={toasts} onCloseToast={removeToast} />
    </main>
  );
}

/** Đọc deletionState URL với fallback active an toàn. */
function readDeletionStateFromUrl(searchParams: Readonly<URLSearchParams>): DeletionState {
  return searchParams.get('deletionState') === 'deleted' ? 'deleted' : 'active';
}

/** Parse page URL bounded theo contract validator BE. */
function readPageFromUrl(searchParams: Readonly<URLSearchParams>): number {
  const parsed = Number(searchParams.get('page') ?? '1');
  return Number.isInteger(parsed) && parsed >= 1 ? Math.min(parsed, MAX_PAGE) : 1;
}

/** Đồng bộ page/tab vào URL mà không reload toàn trang. */
function replaceUrl(router: ReturnType<typeof useRouter>, page: number, deletionState: DeletionState): void {
  router.replace(`/admin/feedback?page=${page}&limit=${PAGE_LIMIT}&deletionState=${deletionState}`, { scroll: false });
}

/** Di chuyển page và giữ nguyên tab hiện tại. */
function moveToPage(router: ReturnType<typeof useRouter>, page: number, deletionState: DeletionState, setPage: (page: number) => void): void {
  const nextPage = Math.min(MAX_PAGE, Math.max(1, page));
  setPage(nextPage);
  replaceUrl(router, nextPage, deletionState);
}

/** Lấy message server an toàn cho vùng alert của panel. */
function getErrorMessage(error: unknown): string | null {
  if (!error) return null;
  if (typeof error === 'object' && error !== null && 'message' in error && typeof (error as ApiErrorResponse).message === 'string') {
    return (error as ApiErrorResponse).message;
  }
  return 'Không thể tải feedback bị flag. Vui lòng thử lại.';
}
