'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { buildApiUrl, fetchApi } from '@/app/utils/apiClient';
import { readAuthSession } from '@/app/utils/authSession';
import { formatVietnameseDateTime } from './helpers';
import type {
  SystemErrorLogCategory,
  SystemErrorLogCategorySummary,
  SystemErrorLogItem,
  SystemErrorLogReadStateFilter,
  ToastItem
} from './types';

type SystemErrorLogApiResponse = {
  logs: SystemErrorLogItem[];
  summary: {
    totalCount: number;
    unreadCount: number;
    transferTimeout15MinutesCount: number;
    categorySummaryList: SystemErrorLogCategorySummary[];
  };
};

type SystemErrorLogReadStateUpdateApiResponse = {
  logId: string;
  isRead: boolean;
  readAt: string | null;
};

type SystemErrorLogPanelProps = {
  onPushToast?: (toastItem: Omit<ToastItem, 'id'>) => void;
};

const categoryFilterOptionList: Array<{ key: SystemErrorLogCategory; labelText: string }> = [
  { key: 'TRANSFER_TIMEOUT_15_MINUTES', labelText: 'Quá hạn 15 phút' },
  { key: 'DEPOSIT', labelText: 'Lỗi nạp tiền' },
  { key: 'DISBURSEMENT', labelText: 'Lỗi giải ngân' },
  { key: 'AUTH', labelText: 'Lỗi xác thực' }
];

const readStateFilterOptionList: Array<{ key: SystemErrorLogReadStateFilter; labelText: string }> = [
  { key: 'all', labelText: 'Tất cả' },
  { key: 'unread', labelText: 'Chưa đọc' },
  { key: 'read', labelText: 'Đã đọc' }
];

const pageSizeOptionList = [5, 10, 20, 50] as const;

/**
 * Hàm chuẩn hóa chuỗi tìm kiếm.
 * Mục đích: giúp tìm kiếm không phân biệt chữ hoa/chữ thường và khoảng trắng thừa.
 */
function normalizeSearchText(searchText: string): string {
  return String(searchText || '').trim().toLowerCase();
}

/**
 * Hàm trả về class màu cho badge mức độ nghiêm trọng.
 * Mục đích: đồng bộ cách hiển thị mức độ ưu tiên xử lý lỗi trên toàn bảng.
 */
function getSeverityBadgeClassName(severityLevel: SystemErrorLogItem['severityLevel']): string {
  if (severityLevel === 'high') {
    return 'border-red-300 bg-red-50 text-red-700';
  }

  if (severityLevel === 'medium') {
    return 'border-amber-300 bg-amber-50 text-amber-700';
  }

  return 'border-emerald-300 bg-emerald-50 text-emerald-700';
}

/**
 * Hàm trả về class màu cho badge module nguồn lỗi.
 * Mục đích: giúp Admin nhận diện nhanh lỗi thuộc luồng nghiệp vụ nào.
 */
function getSourceModuleBadgeClassName(sourceModule: SystemErrorLogItem['sourceModule']): string {
  if (sourceModule === 'DEPOSIT') {
    return 'border-cyan-300 bg-cyan-50 text-cyan-700';
  }

  if (sourceModule === 'DISBURSEMENT') {
    return 'border-purple-300 bg-purple-50 text-purple-700';
  }

  return 'border-slate-300 bg-slate-50 text-slate-700';
}

/**
 * Hàm hiển thị label mức độ nghiêm trọng.
 * Mục đích: chuyển trạng thái kỹ thuật thành nội dung dễ đọc cho Admin vận hành.
 */
function getSeverityLabelText(severityLevel: SystemErrorLogItem['severityLevel']): string {
  if (severityLevel === 'high') {
    return 'Cao';
  }

  if (severityLevel === 'medium') {
    return 'Trung bình';
  }

  return 'Thấp';
}

/**
 * Hàm chuẩn hóa giá trị để hiển thị trong phần chi tiết log.
 * Mục đích: đảm bảo các trường null/undefined luôn hiển thị rõ ràng cho Admin.
 */
function getDetailDisplayText(value: string | number | null | undefined): string {
  if (typeof value === 'number') {
    return String(value);
  }

  const normalizedText = String(value || '').trim();
  return normalizedText || '-';
}

/**
 * Hàm trả về số lượng theo category từ summary API.
 * Mục đích: hiển thị badge đếm chính xác cho từng nhóm lỗi trong bộ lọc.
 */
function getCategoryCountFromSummary(
  categorySummaryList: SystemErrorLogCategorySummary[],
  category: SystemErrorLogCategory,
  readStateFilter: SystemErrorLogReadStateFilter
): number {
  const matchedCategorySummary = categorySummaryList.find((categorySummaryItem) => categorySummaryItem.category === category);
  if (!matchedCategorySummary) {
    return 0;
  }

  if (readStateFilter === 'unread') {
    return matchedCategorySummary.unreadCount;
  }

  return matchedCategorySummary.totalCount;
}

/**
 * Hàm component hiển thị panel log lỗi hệ thống.
 * Mục đích: cho phép Admin phân loại lỗi, đọc nhanh, và đánh dấu trạng thái đã đọc.
 */
export default function SystemErrorLogPanel({ onPushToast }: SystemErrorLogPanelProps) {
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);
  const [searchKeyword, setSearchKeyword] = useState('');
  const [expandedLogId, setExpandedLogId] = useState<string | null>(null);
  const [updatingLogId, setUpdatingLogId] = useState<string | null>(null);
  const [isMarkingAllVisibleAsRead, setIsMarkingAllVisibleAsRead] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState<SystemErrorLogCategory | 'all'>('all');
  const [selectedReadStateFilter, setSelectedReadStateFilter] = useState<SystemErrorLogReadStateFilter>('all');
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(10);
  const [logItemList, setLogItemList] = useState<SystemErrorLogItem[]>([]);
  const [summaryData, setSummaryData] = useState<SystemErrorLogApiResponse['summary']>({
    totalCount: 0,
    unreadCount: 0,
    transferTimeout15MinutesCount: 0,
    categorySummaryList: []
  });

  /**
   * Hàm tải danh sách log lỗi hệ thống từ backend.
   * Mục đích: đồng bộ dữ liệu mới nhất theo bộ lọc category/readState.
   */
  const loadSystemErrorLogs = useCallback(async () => {
    setIsLoading(true);
    setHasError(false);

    try {
      const session = readAuthSession();
      const queryParameterList = new URLSearchParams({
        category: selectedCategory,
        readState: selectedReadStateFilter,
        limitCount: '120'
      });

      const responsePayload = await fetchApi<SystemErrorLogApiResponse>(
        buildApiUrl(`/api/admin/dashboard/system-error-logs?${queryParameterList.toString()}`),
        {
          headers: {
            Authorization: `Bearer ${session.accessToken}`
          }
        }
      );

      setLogItemList(responsePayload.data.logs || []);
      setSummaryData(responsePayload.data.summary);
    } catch {
      setHasError(true);
      onPushToast?.({
        titleText: 'Lỗi tải dữ liệu',
        bodyText: 'Không thể tải log lỗi hệ thống. Vui lòng thử lại.',
        tone: 'error'
      });
    } finally {
      setIsLoading(false);
    }
  }, [onPushToast, selectedCategory, selectedReadStateFilter]);

  useEffect(() => {
    loadSystemErrorLogs();
  }, [loadSystemErrorLogs]);

  /**
   * Hàm cập nhật trạng thái đọc cục bộ sau khi API thành công.
   * Mục đích: phản hồi UI tức thời mà không cần chờ tải lại toàn bộ danh sách.
   */
  const applyReadStateInLocalStore = useCallback((targetLogId: string, isRead: boolean, readAt: string | null) => {
    setLogItemList((previousLogItemList) => previousLogItemList.map((logItem) => {
      if (logItem.id !== targetLogId) {
        return logItem;
      }

      return {
        ...logItem,
        isRead,
        readAt
      };
    }));

    setSummaryData((previousSummaryData) => {
      const matchedLogItem = logItemList.find((logItem) => logItem.id === targetLogId);
      if (!matchedLogItem) {
        return previousSummaryData;
      }

      const isNoStateChange = matchedLogItem.isRead === isRead;
      if (isNoStateChange) {
        return previousSummaryData;
      }

      const updatedUnreadCount = Math.max(
        0,
        previousSummaryData.unreadCount + (isRead ? -1 : 1)
      );

      // Ghi chú logic phức tạp: chỉ cập nhật unreadCount của đúng category chứa log đang thao tác,
      // tránh làm sai thống kê các nhóm lỗi còn lại khi Admin đánh dấu đọc/chưa đọc.
      const updatedCategorySummaryList = previousSummaryData.categorySummaryList.map((categorySummaryItem) => {
        if (categorySummaryItem.category !== matchedLogItem.category) {
          return categorySummaryItem;
        }

        return {
          ...categorySummaryItem,
          unreadCount: Math.max(0, categorySummaryItem.unreadCount + (isRead ? -1 : 1))
        };
      });

      return {
        ...previousSummaryData,
        unreadCount: updatedUnreadCount,
        categorySummaryList: updatedCategorySummaryList
      };
    });
  }, [logItemList]);

  /**
   * Hàm gửi request cập nhật trạng thái đọc/chưa đọc tới backend.
   * Mục đích: tái sử dụng cùng một luồng gọi API cho thao tác đơn lẻ và thao tác hàng loạt.
   */
  const requestReadStateUpdate = useCallback(async (
    targetLogId: string,
    isRead: boolean
  ): Promise<SystemErrorLogReadStateUpdateApiResponse> => {
    const session = readAuthSession();

    const responsePayload = await fetchApi<SystemErrorLogReadStateUpdateApiResponse>(
      buildApiUrl(`/api/admin/dashboard/system-error-logs/${encodeURIComponent(targetLogId)}/read`),
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${session.accessToken}`
        },
        body: JSON.stringify({ isRead })
      }
    );

    return responsePayload.data;
  }, []);

  /**
   * Hàm gọi API cập nhật trạng thái đọc/chưa đọc cho một log.
   * Mục đích: lưu thao tác của Admin để tránh xử lý trùng các log đã xem.
   */
  const updateReadStateForLog = useCallback(async (targetLogId: string, isRead: boolean) => {
    setUpdatingLogId(targetLogId);

    try {
      const updatedReadState = await requestReadStateUpdate(targetLogId, isRead);

      applyReadStateInLocalStore(
        updatedReadState.logId,
        updatedReadState.isRead,
        updatedReadState.readAt
      );

      onPushToast?.({
        titleText: 'Cập nhật thành công',
        bodyText: isRead ? 'Đã đánh dấu log là đã đọc.' : 'Đã chuyển log về trạng thái chưa đọc.',
        tone: 'success'
      });
    } catch {
      onPushToast?.({
        titleText: 'Cập nhật thất bại',
        bodyText: 'Không thể cập nhật trạng thái đọc cho log lỗi.',
        tone: 'error'
      });
    } finally {
      setUpdatingLogId(null);
    }
  }, [applyReadStateInLocalStore, onPushToast, requestReadStateUpdate]);

  /**
   * Hàm đánh dấu toàn bộ log đang hiển thị thành đã đọc.
   * Mục đích: tăng tốc xử lý khi Admin đã rà soát một batch log lỗi.
   */
  const markAllVisibleLogsAsRead = useCallback(async (visibleLogList: SystemErrorLogItem[]) => {
    const unreadVisibleLogList = visibleLogList.filter((logItem) => !logItem.isRead);
    if (!unreadVisibleLogList.length) {
      return;
    }

    setIsMarkingAllVisibleAsRead(true);

    try {
      const updatedReadStateList = await Promise.all(
        unreadVisibleLogList.map((logItem) => requestReadStateUpdate(logItem.id, true))
      );

      updatedReadStateList.forEach((updatedReadStateItem) => {
        applyReadStateInLocalStore(
          updatedReadStateItem.logId,
          updatedReadStateItem.isRead,
          updatedReadStateItem.readAt
        );
      });

      onPushToast?.({
        titleText: 'Đã đánh dấu hàng loạt',
        bodyText: `Đã cập nhật ${unreadVisibleLogList.length} log sang trạng thái đã đọc.`,
        tone: 'success'
      });
    } catch {
      onPushToast?.({
        titleText: 'Cập nhật thất bại',
        bodyText: 'Không thể đánh dấu toàn bộ log đang hiển thị.',
        tone: 'error'
      });
    } finally {
      setIsMarkingAllVisibleAsRead(false);
    }
  }, [applyReadStateInLocalStore, onPushToast, requestReadStateUpdate]);

  const visibleLogItemList = useMemo(() => {
    const normalizedKeyword = normalizeSearchText(searchKeyword);
    if (!normalizedKeyword) {
      return logItemList;
    }

    return logItemList.filter((logItem) => {
      const combinedSearchContent = normalizeSearchText(
        `${logItem.title} ${logItem.details} ${logItem.referenceCode} ${logItem.categoryLabel} ${logItem.detailContext.sourceOrigin} ${logItem.detailContext.actor.displayName} ${logItem.detailContext.actor.email || ''} ${logItem.detailContext.eventType || ''} ${logItem.detailContext.correlationId || ''}`
      );
      return combinedSearchContent.includes(normalizedKeyword);
    });
  }, [logItemList, searchKeyword]);

  const unreadVisibleCount = useMemo(
    () => visibleLogItemList.filter((logItem) => !logItem.isRead).length,
    [visibleLogItemList]
  );

  const visibleLogCount = visibleLogItemList.length;
  const totalPages = Math.max(1, Math.ceil(visibleLogCount / pageSize));

  /** Danh sách log lỗi chỉ thuộc trang hiện tại. */
  const paginatedVisibleLogItemList = useMemo(() => {
    const startIndex = (currentPage - 1) * pageSize;
    return visibleLogItemList.slice(startIndex, startIndex + pageSize);
  }, [currentPage, pageSize, visibleLogItemList]);

  useEffect(() => {
    setCurrentPage(1);
  }, [searchKeyword, selectedCategory, selectedReadStateFilter, pageSize]);

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages);
    }
  }, [currentPage, totalPages]);

  /** Hàm chuyển sang trang trước nếu trang hiện tại chưa phải trang đầu. */
  function handlePreviousPage(): void {
    if (currentPage <= 1) return;
    setCurrentPage(currentPage - 1);
  }

  /** Hàm chuyển sang trang sau nếu trang hiện tại chưa phải trang cuối. */
  function handleNextPage(): void {
    if (currentPage >= totalPages) return;
    setCurrentPage(currentPage + 1);
  }

  /** Hàm chuyển tới trang được chọn trong danh sách phân trang. */
  function handleGoToPage(pageNumber: number): void {
    if (pageNumber < 1 || pageNumber > totalPages || pageNumber === currentPage) return;
    setCurrentPage(pageNumber);
  }

  /** Hàm thay đổi số bản ghi trên mỗi trang. */
  function handlePageSizeChange(nextPageSize: number): void {
    setPageSize(nextPageSize);
  }

  return (
    <div className="space-y-4">
      <div className="overflow-hidden rounded-xl border border-emerald-900/15 bg-white p-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h2 className="text-sm font-bold text-slate-800">Log lỗi hệ thống</h2>
            <p className="mt-1 text-xs text-slate-500">
              Theo dõi lỗi theo từng nhóm nghiệp vụ, ưu tiên xử lý các lỗi chuyển tiền quá hạn 15 phút.
            </p>
          </div>

          <button
            type="button"
            onClick={() => loadSystemErrorLogs()}
            disabled={isLoading}
            className="rounded-lg border border-emerald-900/15 px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Làm mới dữ liệu
          </button>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3">
          <div className="rounded-lg border border-emerald-900/15 bg-slate-50 px-4 py-3">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Tổng log lỗi</p>
            <p className="mt-1 text-2xl font-bold text-slate-800">{summaryData.totalCount}</p>
          </div>

          <div className="rounded-lg border border-emerald-900/15 bg-slate-50 px-4 py-3">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Chưa đọc</p>
            <p className="mt-1 text-2xl font-bold text-amber-600">{summaryData.unreadCount}</p>
          </div>

          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-red-600">Quá hạn 15 phút</p>
            <p className="mt-1 text-2xl font-bold text-red-700">{summaryData.transferTimeout15MinutesCount}</p>
          </div>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-emerald-900/15 bg-white p-5">
        <div className="space-y-3">
          <div>
            <p className="mb-2 text-xs font-semibold text-slate-600">Phân loại lỗi</p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setSelectedCategory('all')}
                className={`rounded-full border px-3 py-1 text-xs font-semibold transition ${selectedCategory === 'all' ? 'border-[#0E7C6B] bg-[#0E7C6B] text-white' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'}`}
              >
                Tất cả ({selectedReadStateFilter === 'unread' ? summaryData.unreadCount : summaryData.totalCount})
              </button>

              {categoryFilterOptionList.map((categoryFilterOption) => (
                <button
                  key={categoryFilterOption.key}
                  type="button"
                  onClick={() => setSelectedCategory(categoryFilterOption.key)}
                  className={`rounded-full border px-3 py-1 text-xs font-semibold transition ${selectedCategory === categoryFilterOption.key ? 'border-[#0E7C6B] bg-[#0E7C6B] text-white' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'}`}
                >
                  {categoryFilterOption.labelText} ({getCategoryCountFromSummary(summaryData.categorySummaryList, categoryFilterOption.key, selectedReadStateFilter)})
                </button>
              ))}
            </div>
          </div>

          <div>
            <p className="mb-2 text-xs font-semibold text-slate-600">Trạng thái đọc</p>
            <div className="flex flex-wrap gap-2">
              {readStateFilterOptionList.map((readStateFilterOption) => (
                <button
                  key={readStateFilterOption.key}
                  type="button"
                  onClick={() => setSelectedReadStateFilter(readStateFilterOption.key)}
                  className={`rounded-full border px-3 py-1 text-xs font-semibold transition ${selectedReadStateFilter === readStateFilterOption.key ? 'border-[#1AAE97] bg-[#1AAE97] text-white' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'}`}
                >
                  {readStateFilterOption.labelText}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="relative w-full lg:max-w-md">
              <svg className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.35-4.35" />
              </svg>

              <input
                type="search"
                value={searchKeyword}
                onChange={(event) => setSearchKeyword(event.target.value)}
                placeholder="Tìm theo tiêu đề, chi tiết, mã tham chiếu..."
                className="h-10 w-full rounded-lg border border-slate-200 bg-white pl-10 pr-4 text-sm text-slate-700 placeholder-slate-400 focus:border-[#1AAE97] focus:outline-none focus:ring-1 focus:ring-[#1AAE97]/30"
              />
            </div>

            <button
              type="button"
              onClick={() => markAllVisibleLogsAsRead(visibleLogItemList)}
              disabled={isMarkingAllVisibleAsRead || unreadVisibleCount === 0}
              className="rounded-lg border border-emerald-900/15 px-3 py-2 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isMarkingAllVisibleAsRead ? 'Đang cập nhật...' : `Đánh dấu đã đọc (${unreadVisibleCount})`}
            </button>
          </div>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-emerald-900/15 bg-white">
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-xs">
            <thead className="bg-slate-50 text-[10px] uppercase tracking-[0.08em] text-slate-500">
              <tr>
                <th className="px-4 py-2.5 font-semibold">Thời gian</th>
                <th className="px-4 py-2.5 font-semibold">Phân loại</th>
                <th className="px-4 py-2.5 font-semibold">Tiêu đề lỗi</th>
                <th className="px-4 py-2.5 font-semibold">Mã tham chiếu</th>
                <th className="px-4 py-2.5 font-semibold">Trạng thái đọc</th>
                <th className="px-4 py-2.5 font-semibold"></th>
              </tr>
            </thead>

            <tbody>
              {isLoading ? (
                Array.from({ length: 6 }).map((placeholderValue, placeholderIndex) => (
                  <tr key={`loading-placeholder-${placeholderValue}-${placeholderIndex}`} className="border-t border-slate-100">
                    <td className="px-4 py-3"><div className="h-4 w-28 animate-pulse rounded bg-slate-200" /></td>
                    <td className="px-4 py-3"><div className="h-4 w-20 animate-pulse rounded bg-slate-200" /></td>
                    <td className="px-4 py-3"><div className="h-4 w-56 animate-pulse rounded bg-slate-200" /></td>
                    <td className="px-4 py-3"><div className="h-4 w-24 animate-pulse rounded bg-slate-200" /></td>
                    <td className="px-4 py-3"><div className="h-4 w-16 animate-pulse rounded bg-slate-200" /></td>
                    <td className="px-4 py-3"><div className="h-7 w-20 animate-pulse rounded bg-slate-200" /></td>
                  </tr>
                ))
              ) : hasError ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center">
                    <p className="text-sm font-semibold text-red-600">Không thể tải log lỗi hệ thống.</p>
                    <button
                      type="button"
                      onClick={() => loadSystemErrorLogs()}
                      className="mt-3 rounded-lg border border-red-200 px-3 py-1.5 text-xs font-semibold text-red-600 transition hover:bg-red-50"
                    >
                      Thử lại
                    </button>
                  </td>
                </tr>
              ) : paginatedVisibleLogItemList.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-xs text-slate-500">
                    Không có log lỗi phù hợp với bộ lọc hiện tại.
                  </td>
                </tr>
              ) : (
                paginatedVisibleLogItemList.map((logItem) => {
                  const isExpanded = expandedLogId === logItem.id;

                  return [
                    <tr
                      key={`${logItem.id}-summary`}
                      className={`border-t border-slate-100 ${logItem.isTransferTimeout15Minutes ? 'bg-red-50/50' : 'bg-white'} ${!logItem.isRead ? 'font-medium' : ''}`}
                    >
                      <td className="px-4 py-3 text-slate-600">{logItem.timestamp}</td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold ${getSeverityBadgeClassName(logItem.severityLevel)}`}>
                            {getSeverityLabelText(logItem.severityLevel)}
                          </span>
                          <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold ${getSourceModuleBadgeClassName(logItem.sourceModule)}`}>
                            {logItem.sourceModule}
                          </span>
                        </div>
                      </td>

                      <td className="px-4 py-3">
                        <p className={`text-xs ${logItem.isTransferTimeout15Minutes ? 'font-bold text-red-700' : 'text-slate-700'}`}>
                          {logItem.title}
                        </p>
                        <p className="mt-0.5 text-[11px] text-slate-500">{logItem.categoryLabel}</p>
                      </td>

                      <td className="px-4 py-3 font-mono text-[11px] text-slate-600">{logItem.referenceCode}</td>

                      <td className="px-4 py-3">
                        {logItem.isRead ? (
                          <span className="inline-flex rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
                            Đã đọc
                          </span>
                        ) : (
                          <span className="inline-flex rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700">
                            Chưa đọc
                          </span>
                        )}
                      </td>

                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => setExpandedLogId((previousExpandedLogId) => previousExpandedLogId === logItem.id ? null : logItem.id)}
                            className="rounded-lg border border-slate-200 px-2.5 py-1 text-[11px] font-semibold text-slate-600 transition hover:bg-slate-50"
                          >
                            {isExpanded ? 'Ẩn' : 'Chi tiết'}
                          </button>

                          <button
                            type="button"
                            disabled={updatingLogId === logItem.id || isMarkingAllVisibleAsRead}
                            onClick={() => updateReadStateForLog(logItem.id, !logItem.isRead)}
                            className="rounded-lg border border-emerald-900/15 px-2.5 py-1 text-[11px] font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            {updatingLogId === logItem.id ? 'Đang lưu...' : (logItem.isRead ? 'Đánh dấu chưa đọc' : 'Đánh dấu đã đọc')}
                          </button>
                        </div>
                      </td>
                    </tr>,

                    isExpanded ? (
                      <tr key={`${logItem.id}-detail`} className="border-t border-slate-100 bg-slate-50/70">
                        <td colSpan={6} className="px-4 py-3">
                          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                            <div className="rounded-lg border border-slate-200 bg-white p-3">
                              <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Chi tiết lỗi</p>
                              <p className="mt-1 text-xs text-slate-700">{logItem.details}</p>
                            </div>

                            <div className="rounded-lg border border-slate-200 bg-white p-3">
                              <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Nguồn và người gây lỗi</p>
                              <div className="mt-1 space-y-1 text-xs text-slate-700">
                                <p><span className="font-semibold text-slate-500">Nguồn:</span> <span className="font-mono">{getDetailDisplayText(logItem.detailContext.sourceOrigin)}</span></p>
                                <p><span className="font-semibold text-slate-500">Người gây lỗi:</span> {getDetailDisplayText(logItem.detailContext.actor.displayName)}</p>
                                <p><span className="font-semibold text-slate-500">Gmail:</span> {getDetailDisplayText(logItem.detailContext.actor.email)}</p>
                                <p><span className="font-semibold text-slate-500">User ID:</span> <span className="font-mono">{getDetailDisplayText(logItem.detailContext.actor.userId)}</span></p>
                                <p><span className="font-semibold text-slate-500">Role:</span> {getDetailDisplayText(logItem.detailContext.actor.role)}</p>
                                <p><span className="font-semibold text-slate-500">Ví:</span> <span className="font-mono">{getDetailDisplayText(logItem.detailContext.actor.walletAddress)}</span></p>
                              </div>
                            </div>

                            <div className="rounded-lg border border-slate-200 bg-white p-3">
                              <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Mốc thời gian cụ thể</p>
                              <div className="mt-1 space-y-1 text-xs text-slate-700">
                                <p><span className="font-semibold text-slate-500">Thời gian nghiệp vụ:</span> {logItem.detailContext.businessTimestamp ? formatVietnameseDateTime(logItem.detailContext.businessTimestamp) : '-'}</p>
                                <p><span className="font-semibold text-slate-500">Thời gian hệ thống:</span> {formatVietnameseDateTime(logItem.detailContext.systemTimestamp)}</p>
                                <p><span className="font-semibold text-slate-500">Created At:</span> {logItem.detailContext.createdAt ? formatVietnameseDateTime(logItem.detailContext.createdAt) : '-'}</p>
                                <p><span className="font-semibold text-slate-500">Updated At:</span> {logItem.detailContext.updatedAt ? formatVietnameseDateTime(logItem.detailContext.updatedAt) : '-'}</p>
                                <p><span className="font-semibold text-slate-500">ISO hệ thống:</span> <span className="font-mono">{getDetailDisplayText(logItem.detailContext.systemTimestamp)}</span></p>
                              </div>
                            </div>

                            <div className="rounded-lg border border-slate-200 bg-white p-3">
                              <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Metadata kỹ thuật</p>
                              <div className="mt-1 space-y-1 text-xs text-slate-700">
                                <p><span className="font-semibold text-slate-500">Event Type:</span> <span className="font-mono">{getDetailDisplayText(logItem.detailContext.eventType)}</span></p>
                                <p><span className="font-semibold text-slate-500">Correlation ID:</span> <span className="font-mono">{getDetailDisplayText(logItem.detailContext.correlationId)}</span></p>
                                <p><span className="font-semibold text-slate-500">IP:</span> <span className="font-mono">{getDetailDisplayText(logItem.detailContext.ipAddress)}</span></p>
                                <p><span className="font-semibold text-slate-500">User-Agent:</span> {getDetailDisplayText(logItem.detailContext.userAgent)}</p>
                              </div>
                            </div>

                            <div className="rounded-lg border border-slate-200 bg-white p-3">
                              <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Liên kết nghiệp vụ</p>
                              <div className="mt-1 space-y-1 text-xs text-slate-700">
                                <p><span className="font-semibold text-slate-500">Project:</span> {getDetailDisplayText(logItem.detailContext.projectName)} <span className="font-mono text-slate-500">({getDetailDisplayText(logItem.detailContext.projectId)})</span></p>
                                <p><span className="font-semibold text-slate-500">Organization:</span> {getDetailDisplayText(logItem.detailContext.organizationName)} <span className="font-mono text-slate-500">({getDetailDisplayText(logItem.detailContext.organizationId)})</span></p>
                                <p><span className="font-semibold text-slate-500">Order Code:</span> <span className="font-mono">{getDetailDisplayText(logItem.detailContext.orderCode)}</span></p>
                                <p><span className="font-semibold text-slate-500">Request ID:</span> <span className="font-mono">{getDetailDisplayText(logItem.detailContext.requestId)}</span></p>
                                <p><span className="font-semibold text-slate-500">PayOS Transaction ID:</span> <span className="font-mono">{getDetailDisplayText(logItem.detailContext.payosTransactionId)}</span></p>
                                <p><span className="font-semibold text-slate-500">PayOS Transfer ID:</span> <span className="font-mono">{getDetailDisplayText(logItem.detailContext.payosTransferId)}</span></p>
                                <p><span className="font-semibold text-slate-500">Transfer Status:</span> {getDetailDisplayText(logItem.detailContext.payosTransferStatus)}</p>
                                <p><span className="font-semibold text-slate-500">Số lần retry:</span> {getDetailDisplayText(logItem.detailContext.transferAttemptCount)}</p>
                                <p><span className="font-semibold text-slate-500">Số tiền (VNĐ):</span> {getDetailDisplayText(logItem.detailContext.amountVnd)}</p>
                                <p><span className="font-semibold text-slate-500">Số tiền token:</span> {getDetailDisplayText(logItem.detailContext.amountToken)}</p>
                              </div>
                            </div>

                            <div className="rounded-lg border border-slate-200 bg-white p-3 lg:col-span-2">
                              <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Thông tin đọc</p>
                              <p className="mt-1 text-xs text-slate-700">
                                {logItem.isRead && logItem.readAt
                                  ? `Đã đọc lúc ${formatVietnameseDateTime(logItem.readAt)}`
                                  : 'Chưa có người đánh dấu đã đọc'}
                              </p>
                            </div>
                          </div>
                        </td>
                      </tr>
                    ) : null
                  ];
                })
              )}
            </tbody>
          </table>
        </div>

        {!isLoading && !hasError && visibleLogCount > 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-emerald-900/15 bg-slate-50 px-5 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-slate-500">Hiển thị</span>
              <select
                value={pageSize}
                onChange={(selectEvent) => handlePageSizeChange(Number(selectEvent.target.value))}
                className="h-7 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700 focus:border-[#1AAE97] focus:outline-none"
                aria-label="Số bản ghi mỗi trang"
              >
                {pageSizeOptionList.map((pageSizeOption) => (
                  <option key={pageSizeOption} value={pageSizeOption}>{pageSizeOption}</option>
                ))}
              </select>
              <span className="text-xs text-slate-500">bản ghi / trang</span>
              <span className="text-xs text-slate-400">
                ({(currentPage - 1) * pageSize + 1}-{Math.min(currentPage * pageSize, visibleLogCount)} trên {visibleLogCount})
              </span>
            </div>

            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={handlePreviousPage}
                disabled={currentPage <= 1}
                className="h-7 w-7 rounded-md border border-slate-200 bg-white text-xs text-slate-600 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
                aria-label="Trang trước"
              >
                ‹
              </button>

              {Array.from({ length: totalPages }, (_, index) => index + 1).map((pageNumber) => (
                <button
                  key={pageNumber}
                  type="button"
                  onClick={() => handleGoToPage(pageNumber)}
                  className={`h-7 min-w-7 rounded-md border text-xs font-medium transition ${pageNumber === currentPage
                    ? 'border-[#0F2040] bg-[#0F2040] text-white'
                    : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-100'
                    }`}
                  aria-label={`Trang ${pageNumber}`}
                  aria-current={pageNumber === currentPage ? 'page' : undefined}
                >
                  {pageNumber}
                </button>
              ))}

              <button
                type="button"
                onClick={handleNextPage}
                disabled={currentPage >= totalPages}
                className="h-7 w-7 rounded-md border border-slate-200 bg-white text-xs text-slate-600 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
                aria-label="Trang sau"
              >
                ›
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

