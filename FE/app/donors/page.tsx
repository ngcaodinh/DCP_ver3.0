'use client';

import { Suspense, useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { useSearchParams } from 'next/navigation';
import { buildApiUrl, fetchApi } from '../utils/apiClient';

type DonorListItem = { fullName: string; gmail: string; donatedAmount: number; donatedAt: string; transactionHash: string };
type DonationCampaignDetail = { projectId: string; name: string };
type DonorPaginationResponse = { items: DonorListItem[]; totalItems: number; totalPages: number; currentPage: number; pageSize: number };

/** Kiểu cho trạng thái lọc ngày. dateMode 'range' = lọc từ ngày đến ngày, 'single' = chọn một ngày cụ thể. */
type DateFilterMode = 'range' | 'single';

const pageSizeOptionList = [25, 50, 75] as const;
/** Hàm định dạng số tiền theo chuẩn Việt Nam. Mục đích: hiển thị số tiền quyên góp rõ ràng, dễ đọc. */
const formatCurrencyVnd = (amountValue: number): string => `${new Intl.NumberFormat('vi-VN').format(amountValue)} Token`;
/** Hàm định dạng ngày giờ. Mục đích: hiển thị mốc thời gian dễ hiểu cho người dùng. */
const formatDateTime = (dateTimeValue: string): string => {
  const parsedDateTime = new Date(dateTimeValue);
  if (Number.isNaN(parsedDateTime.getTime())) return 'Không xác định';
  return parsedDateTime.toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
};
/** Hàm rút gọn transaction hash. Mục đích: giữ giao diện gọn trên mobile. */
const shortenTransactionHash = (transactionHashValue: string): string => (transactionHashValue.length <= 16 ? transactionHashValue : `${transactionHashValue.slice(0, 10)}...${transactionHashValue.slice(-8)}`);
/** Hàm tạo link explorer cho transaction hash. Mục đích: mở block explorer khi hệ thống có cấu hình URL. */
const buildTransactionExplorerUrl = (transactionHashValue: string): string => {
  if (!transactionHashValue) return '';
  const blockchainExplorerTxBaseUrl = String(process.env.NEXT_PUBLIC_BLOCKCHAIN_EXPLORER_TX_BASE_URL || 'https://amoy.polygonscan.com/tx').trim();
  return `${blockchainExplorerTxBaseUrl.replace(/\/$/, '')}/${transactionHashValue}`;
};

function DonorsPageContent() {
  const searchParams = useSearchParams();
  const selectedProjectId = String(searchParams.get('projectId') || '').trim();
  const [projectName, setProjectName] = useState('Dự án');
  const [donorList, setDonorList] = useState<DonorListItem[]>([]);
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedPageSize, setSelectedPageSize] = useState<number>(25);
  const [totalPages, setTotalPages] = useState(1);
  const [isPageLoading, setIsPageLoading] = useState(true);
  const [pageErrorMessage, setPageErrorMessage] = useState('');
  const [lastUpdatedAt, setLastUpdatedAt] = useState('');

  // === State cho tìm kiếm ===
  /** Từ khóa tìm kiếm theo tên donor. Hỗ trợ partial match, không phân biệt hoa thường. */
  const [searchNameQuery, setSearchNameQuery] = useState('');
  /** Chế độ lọc ngày: 'range' = từ ngày → đến ngày, 'single' = một ngày cụ thể. */
  const [dateFilterMode, setDateFilterMode] = useState<DateFilterMode>('range');
  /** Ngày bắt đầu (cho lọc khoảng). Gi dạng YYYY-MM-DD. */
  const [startDateInput, setStartDateInput] = useState('');
  /** Ngày kết thúc (cho lọc khoảng). Gi dạng YYYY-MM-DD. */
  const [endDateInput, setEndDateInput] = useState('');
  /** Ngày cụ thể (cho lọc một ngày). Gi dạng YYYY-MM-DD. */
  const [singleDateInput, setSingleDateInput] = useState('');

  /** Debounce timer ref cho input tìm kiếm tên. Tránh filter quá nhiều lần khi người dùng gõ nhanh. */
  const searchDebounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** State lưu giá trị tìm kiếm đã được debounce — dùng cho logic filter thực sự. */
  const [debouncedSearchName, setDebouncedSearchName] = useState('');

  useEffect(() => setCurrentPage(1), [selectedProjectId]);

  useEffect(() => {
    /** Hàm tải dữ liệu trang donors theo server-side pagination. Mục đích: gọi API theo projectId + page + limit do người dùng chọn. */
    const loadDonorPageData = async () => {
      if (!selectedProjectId) {
        setPageErrorMessage('Thiếu thông tin dự án. Vui lòng quay lại trang chủ và chọn lại dự án.');
        setIsPageLoading(false);
        return;
      }

      setIsPageLoading(true);
      setPageErrorMessage('');

      try {
        const [campaignResponse, donorResponse] = await Promise.all([
          fetchApi<DonationCampaignDetail | null>(buildApiUrl(`/donations/campaigns/${encodeURIComponent(selectedProjectId)}`), { method: 'GET', cache: 'no-store' }),
          fetchApi<DonorPaginationResponse>(
            buildApiUrl(`/donations/donors?projectId=${encodeURIComponent(selectedProjectId)}&page=${currentPage}&limit=${selectedPageSize}`),
            { method: 'GET', cache: 'no-store' }
          )
        ]);

        if (!campaignResponse.data) {
          setPageErrorMessage('Không tìm thấy thông tin dự án đã chọn.');
          setDonorList([]);
          return;
        }

        setProjectName(campaignResponse.data.name);
        setDonorList(donorResponse.data.items);
        setTotalPages(Math.max(1, donorResponse.data.totalPages));
        setLastUpdatedAt(new Date().toISOString());
      } catch (error) {
        const fallbackErrorMessage = 'Không thể tải dữ liệu nhà hảo tâm cho dự án đã chọn. Vui lòng thử lại sau.';
        setPageErrorMessage(error instanceof Error ? error.message || fallbackErrorMessage : fallbackErrorMessage);
        setDonorList([]);
      } finally {
        setIsPageLoading(false);
      }
    };

    void loadDonorPageData();
  }, [currentPage, selectedPageSize, selectedProjectId]);

  /** Hàm xử lý đổi số dòng mỗi trang. Mục đích: cập nhật limit mới và đưa trang hiện tại về 1 để đồng bộ dữ liệu. */
  const handlePageSizeChange = (nextPageSizeValue: number): void => {
    setSelectedPageSize(nextPageSizeValue);
    // Ghi chú logic quan trọng: khi đổi limit phải quay về trang 1 để tránh trường hợp trang hiện tại vượt quá totalPages mới.
    setCurrentPage(1);
  };

  /** Hàm sao chép transaction hash. Mục đích: cho phép người dùng copy nhanh mã giao dịch. */

  /**
   * Hàm xử lý thay đổi input tìm kiếm tên (có debounce 300ms).
   * Mục đích: tránh re-render/filter quá nhiều lần khi người dùng gõ nhanh,
   * chỉ cập nhật filter thực sự sau khi ngừng gõ 300ms.
   */
  const handleSearchNameInputChange = useCallback((inputValue: string) => {
    setSearchNameQuery(inputValue);
    if (searchDebounceTimerRef.current) clearTimeout(searchDebounceTimerRef.current);
    searchDebounceTimerRef.current = setTimeout(() => {
      setDebouncedSearchName(inputValue);
    }, 300);
  }, []);

  /**
   * Hàm lọc danh sách donor theo tên và ngày (client-side).
   * Mục đích: hỗ trợ tìm kiếm partial match không phân biệt hoa thường cho tên,
   * và lọc theo khoảng ngày hoặc một ngày cụ thể cho ngày.
   * Lưu ý: sử dụng `debouncedSearchName` thay vì `searchNameQuery` để tối ưu hiệu suất.
   */
  const filteredDonorList = useMemo(() => {
    return donorList.filter((donorItem) => {
      // --- Lọc theo tên (partial match, không phân biệt hoa thường) ---
      if (debouncedSearchName.trim()) {
        const normalizedDonorName = donorItem.fullName.toLowerCase();
        const normalizedSearchText = debouncedSearchName.toLowerCase().trim();
        if (!normalizedDonorName.includes(normalizedSearchText)) return false;
      }

      // --- Lọc theo ngày ---
      const donatedAtDate = new Date(donorItem.donatedAt);

      if (dateFilterMode === 'range') {
        // Chế độ lọc khoảng: từ ngày → đến ngày
        if (startDateInput) {
          const rangeStartDate = new Date(startDateInput);
          rangeStartDate.setHours(0, 0, 0, 0);
          if (donatedAtDate < rangeStartDate) return false;
        }
        if (endDateInput) {
          const rangeEndDate = new Date(endDateInput);
          rangeEndDate.setHours(23, 59, 59, 999);
          if (donatedAtDate > rangeEndDate) return false;
        }
      } else {
        // Chế độ lọc một ngày cụ thể
        if (singleDateInput) {
          const targetDateObj = new Date(singleDateInput);
          const donatedDateObj = new Date(donorItem.donatedAt);
          const isSameDay =
            donatedDateObj.getFullYear() === targetDateObj.getFullYear() &&
            donatedDateObj.getMonth() === targetDateObj.getMonth() &&
            donatedDateObj.getDate() === targetDateObj.getDate();
          if (!isSameDay) return false;
        }
      }

      return true;
    });
  }, [donorList, debouncedSearchName, dateFilterMode, startDateInput, endDateInput, singleDateInput]);

  /**
   * Hàm xử lý khi người dùng thay đổi chế độ lọc ngày.
   * Mục đích: reset các giá trị ngày khi chuyển chế độ để tránh state không đồng bộ.
   */
  const handleDateFilterModeChange = (selectedMode: DateFilterMode): void => {
    setDateFilterMode(selectedMode);
    setStartDateInput('');
    setEndDateInput('');
    setSingleDateInput('');
  };

  /** Biến kiểm tra xem có bất kỳ bộ lọc nào đang active hay không (dùng debouncedSearchName cho tìm kiếm). */
  const hasActiveFilter = Boolean(debouncedSearchName.trim() || startDateInput || endDateInput || singleDateInput);

  /** Thông báo khi không có kết quả tìm kiếm. */
  const noFilterMatchMessage = hasActiveFilter
    ? `Không tìm thấy nhà hảo tâm nào phù hợp với từ khóa "${debouncedSearchName}" hoặc khoảng ngày đã chọn.`
    : 'Đến hiện tại chưa có cuộc quyên góp nào được ghi nhận.';

  const donorListContent = useMemo(() => {
    if (isPageLoading) return <p className="rounded-xl border border-[#d1fae5] bg-white p-4 text-sm text-[#0f766e]">Đang tải thông tin dự án và danh sách nhà hảo tâm...</p>;
    if (pageErrorMessage) return <p className="rounded-xl border border-[#fecaca] bg-[#fff1f2] p-4 text-sm text-[#b91c1c]">{pageErrorMessage}</p>;

    // Sử dụng danh sách đã lọc (client-side filter) thay vì danh sách gốc từ API.
    if (filteredDonorList.length === 0) {
      return (
        <div className="rounded-2xl border border-[#e2e8f0] bg-white p-6 sm:p-8">
          {/* Container chứa icon + message + suggestion — căn giữa, responsive */}
          <div className="flex flex-col items-center gap-4 text-center">
            {/* Icon minh họa: kính lúp với dấu chấm hỏi */}
            <div className="relative flex h-20 w-20 items-center justify-center rounded-full bg-[#ecfdf5] shadow-[0_4px_14px_rgba(16,185,129,0.15)]">
              <svg className="h-10 w-10 text-[#10b981]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
              </svg>
              {/* Dấu chấm hỏi nhỏ góc phải dưới */}
              <div className="absolute -bottom-1 -right-1 flex h-7 w-7 items-center justify-center rounded-full border-2 border-white bg-[#fee2e2] text-xs font-bold text-[#ef4444] shadow">?</div>
            </div>

            {/* Tiêu đề và mô tả */}
            <div className="space-y-1.5">
              <h3 className="text-base font-semibold text-[#334155]">Không tìm thấy kết quả</h3>
              <p className="text-sm leading-relaxed text-[#64748b]">{noFilterMatchMessage}</p>
            </div>

            {/* Gợi ý xóa bộ lọc */}
            {hasActiveFilter && (
              <div className="mt-1 flex flex-col items-center gap-2">
                <p className="text-xs text-[#94a3b8]">Thử thay đổi bộ lọc hoặc xóa để xem tất cả donor</p>
                <button
                  type="button"
                  onClick={() => { setSearchNameQuery(''); setDebouncedSearchName(''); setStartDateInput(''); setEndDateInput(''); setSingleDateInput(''); setDateFilterMode('range'); }}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-[#10b981] bg-[#ecfdf5] px-4 py-2 text-sm font-semibold text-[#047857] shadow-[0_4px_10px_rgba(16,185,129,0.10)] transition hover:border-[#059669] hover:bg-[#d1fae5] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#10b981] focus-visible:ring-offset-1"
                >
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                  <span>Xóa bộ lọc</span>
                </button>
              </div>
            )}
          </div>
        </div>
      );
    }

    return (
      <>
        {/* Container bảng: overflow-x auto để scroll ngang trên mobile */}
        <div className="overflow-x-auto rounded-xl border border-[#d1fae5] bg-white shadow-[0_4px_16px_rgba(16,185,129,0.08)]">
          <table className="min-w-[900px] w-full text-left text-sm text-[#0f172a] sm:min-w-full">
            {/* Header — nền xanh gradient nhẹ */}
            <thead className="bg-gradient-to-r from-[#ecfdf5] to-[#f0fdfa] text-xs uppercase tracking-[0.05em] text-[#065f46]">
              <tr>
                <th className="px-3 py-2.5 sm:px-4 sm:py-3">Họ tên</th>
                <th className="px-3 py-2.5 sm:px-4 sm:py-3">Gmail</th>
                <th className="px-3 py-2.5 sm:px-4 sm:py-3">Số tiền</th>
                <th className="px-3 py-2.5 sm:px-4 sm:py-3">Ngày giờ</th>
                <th className="min-w-[160px] px-3 py-2.5 sm:min-w-[200px] sm:px-4 sm:py-3">Transaction Hash</th>
              </tr>
            </thead>
            <tbody>
              {filteredDonorList.map((donorItem, donorIndex) => {
                const explorerTransactionUrl = buildTransactionExplorerUrl(donorItem.transactionHash);
                return (
                  <tr
                    key={`${donorItem.transactionHash}-${donorIndex}`}
                    className="group border-t border-[#f1f5f9] align-top transition-colors hover:bg-[#f8fffe]"
                  >
                    {/* Họ tên */}
                    <td className="px-3 py-2.5 font-medium sm:px-4 sm:py-3">
                      <span className="inline-flex items-center gap-1.5">
                        {/* Icon người nhỏ */}
                        <svg className="h-3 w-3 flex-shrink-0 text-[#10b981]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
                        </svg>
                        <span className="truncate max-w-[120px] sm:max-w-none">{donorItem.fullName}</span>
                      </span>
                    </td>
                    {/* Gmail */}
                    <td className="px-3 py-2.5 text-[#334155] sm:px-4 sm:py-3">
                      <span className="block truncate max-w-[100px] text-xs sm:max-w-none sm:text-sm">{donorItem.gmail}</span>
                    </td>
                    {/* Số tiền */}
                    <td className="px-3 py-2.5 font-semibold text-[#047857] sm:px-4 sm:py-3">
                      {formatCurrencyVnd(donorItem.donatedAmount)}
                    </td>
                    {/* Ngày giờ */}
                    <td className="px-3 py-2.5 text-[#334155] sm:px-4 sm:py-3">
                      <span className="block text-xs leading-relaxed sm:text-sm">{formatDateTime(donorItem.donatedAt)}</span>
                    </td>
                    {/* Transaction Hash */}
                      <td className="px-3 py-2.5 font-mono text-xs sm:px-4 sm:py-3">
                        <div className="flex items-start gap-1.5 sm:items-center">
                          {explorerTransactionUrl ? (
                            <a
                              href={explorerTransactionUrl}
                              target="_blank"
                              rel="noreferrer noopener"
                              className="inline-flex items-center gap-1 truncate text-[#1d4ed8] hover:underline max-w-[80px] sm:max-w-none"
                              title={donorItem.transactionHash}
                            >
                              <svg className="h-3 w-3 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                                <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
                              </svg>
                              <span>{shortenTransactionHash(donorItem.transactionHash)}</span>
                            </a>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-[#475569] max-w-[80px] truncate sm:max-w-none" title={donorItem.transactionHash}>
                              <svg className="h-3 w-3 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                                <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                              </svg>
                              <span>{shortenTransactionHash(donorItem.transactionHash)}</span>
                            </span>
                          )}
                        </div>
                      </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="mt-4 rounded-2xl border border-[#99f6e4] bg-gradient-to-br from-white via-[#f7fffd] to-[#ecfdf5] p-3 shadow-[0_14px_35px_rgba(16,185,129,0.12)] sm:p-4">
          <div className="flex flex-col gap-3">
            <div className="rounded-xl border border-[#d1fae5] bg-white/90 p-3 sm:p-4">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(136px,auto)_1fr] sm:items-center sm:gap-3">
                  <label htmlFor="pageSizeSelect" className="text-sm font-semibold text-[#0f766e]">
                    Số dòng mỗi trang
                  </label>
                  <select
                    id="pageSizeSelect"
                    value={selectedPageSize}
                    onChange={event => handlePageSizeChange(Number(event.target.value))}
                    disabled={isPageLoading}
                    className="h-11 w-full min-w-[136px] rounded-xl border border-[#99f6e4] bg-[#f0fdfa] px-3 text-sm font-semibold text-[#0f766e] shadow-[0_6px_14px_rgba(20,184,166,0.12)] outline-none transition hover:border-[#5eead4] hover:bg-[#ccfbf1] focus-visible:ring-2 focus-visible:ring-[#14b8a6] focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:border-[#d1d5db] disabled:bg-[#f8fafc] disabled:text-[#94a3b8]"
                  >
                    {pageSizeOptionList.map(pageSizeOption => (
                      <option key={pageSizeOption} value={pageSizeOption}>
                        {pageSizeOption}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="grid grid-cols-1 items-stretch gap-2 sm:grid-cols-[minmax(120px,auto)_1fr_minmax(120px,auto)] sm:items-center sm:gap-3">
                  <button
                    type="button"
                    onClick={() => setCurrentPage(previousPage => Math.max(1, previousPage - 1))}
                    disabled={currentPage <= 1 || isPageLoading}
                    className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-[#99f6e4] bg-[#f0fdfa] px-4 text-sm font-semibold text-[#0f766e] shadow-[0_6px_14px_rgba(20,184,166,0.10)] transition hover:border-[#5eead4] hover:bg-[#ccfbf1] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#14b8a6] focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:border-[#d1d5db] disabled:bg-[#f8fafc] disabled:text-[#94a3b8] disabled:shadow-none"
                  >
                    <span aria-hidden="true">←</span>
                    <span>Trang trước</span>
                  </button>

                  {/* Ghi chú logic UI: giữ chiều cao cố định + aria-live để cập nhật trạng thái tải mà không làm giật layout và giúp tăng khả năng truy cập. */}
                  <div
                    aria-live="polite"
                    className="flex h-11 min-w-[180px] items-center justify-center rounded-xl border border-[#99f6e4] bg-[#ecfeff] px-4 text-center text-sm font-semibold text-[#0f766e]"
                  >
                    <span className={`mr-2 inline-block h-2.5 w-2.5 rounded-full ${isPageLoading ? 'animate-pulse bg-[#0d9488]' : 'bg-[#10b981]'}`} />
                    {isPageLoading ? 'Đang tải trang...' : `Trang ${currentPage} / ${totalPages}`}
                  </div>

                  <button
                    type="button"
                    onClick={() => setCurrentPage(previousPage => Math.min(totalPages, previousPage + 1))}
                    disabled={currentPage >= totalPages || isPageLoading}
                    className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-[#99f6e4] bg-[#f0fdfa] px-4 text-sm font-semibold text-[#0f766e] shadow-[0_6px_14px_rgba(20,184,166,0.10)] transition hover:border-[#5eead4] hover:bg-[#ccfbf1] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#14b8a6] focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:border-[#d1d5db] disabled:bg-[#f8fafc] disabled:text-[#94a3b8] disabled:shadow-none"
                  >
                    <span>Trang sau</span>
                    <span aria-hidden="true">→</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </>
    );
  }, [currentPage, filteredDonorList, hasActiveFilter, isPageLoading, noFilterMatchMessage, pageErrorMessage, selectedPageSize, totalPages]);

  return (
    <main className="min-h-screen bg-gradient-to-b from-[#f0fdf4] to-[#f8fafc] px-4 py-6 md:px-8">
      <div className="mx-auto w-full max-w-6xl space-y-4">
        <a href="/" className="inline-flex items-center text-sm font-semibold text-[#0f766e] hover:underline">← Quay lại trang chủ</a>
        <section className="space-y-2 rounded-2xl border border-[#a7f3d0] bg-white/90 p-4 text-center md:p-6"><h1 className="text-2xl font-bold text-[#064e3b]">Danh sách nhà hảo tâm - {projectName}</h1><p className="text-sm text-[#334155]">Dữ liệu được lấy trực tiếp từ hệ thống giao dịch quyên góp đã ghi nhận.</p><p className="text-xs font-medium text-[#6b7280]">Lưu ý: 1 Token tương đương 1 đồng (VND).</p><p className="text-xs text-[#64748b]">Cập nhật dữ liệu lúc: {lastUpdatedAt ? formatDateTime(lastUpdatedAt) : 'Chưa có dữ liệu'}</p></section>

        {/* ============================================================
            KHU VỰC TÌM KIẾM & LỌC
            Hỗ trợ: Tìm kiếm theo tên (partial, case-insensitive, debounced 300ms)
                   Lọc theo ngày (khoảng hoặc một ngày cụ thể)
            Mobile-first: stack dọc trên mobile, 2 cột trên lg+
        ============================================================ */}
        <section className="overflow-hidden rounded-2xl border border-[#a7f3d0] bg-white py-6 shadow-[0_8px_24px_rgba(16,185,129,0.10)]">
          {/* Body: grid 2 cột trên lg+, 1 cột trên mobile */}
          <div className="grid grid-cols-1 gap-0 p-0 lg:grid-cols-2">
            {/* --- Cột 1: Tìm kiếm theo tên --- */}
            <div className="flex w-fit flex-col gap-0 sm:max-w-[550px]">
              <label htmlFor="searchByNameInput" className="flex items-center gap-1 text-xs font-semibold text-[#0f766e] sm:text-sm">
                {/* Icon người */}
                <svg className="h-3 w-3 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
                </svg>
                <span>Tìm theo tên</span>
              </label>
              <div className="relative">
                {/* Icon search bên trong input */}
                <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-2.5">
                  <svg className="h-3.5 w-3.5 text-[#10b981]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
                  </svg>
                </div>
                <input
                  id="searchByNameInput"
                  type="text"
                  placeholder="VD: Nguyễn, Trần..."
                  value={searchNameQuery}
                  onChange={(inputEvent) => handleSearchNameInputChange(inputEvent.target.value)}
                  className="block h-9 w-full rounded-lg border border-[#99f6e4] bg-[#f0fdfa] py-1.5 pr-3 pl-8 text-sm text-[#0f172a] shadow-[inset_0_1px_2px_rgba(0,0,0,0.05)] placeholder:text-[#94a3b8] transition hover:border-[#5eead4] hover:bg-[#ccfbf1] focus:border-[#14b8a6] focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#14b8a6] focus:ring-offset-0 disabled:cursor-not-allowed disabled:border-[#d1d5db] disabled:bg-[#f8fafc] disabled:text-[#94a3b8]"
                />
              </div>
              <p className="hidden text-[11px] leading-snug text-[#64748b] sm:block sm:text-xs">Không phân biệt hoa thường, hỗ trợ tìm một phần tên.</p>
            </div>

            {/* --- Cột 2: Lọc ngày --- */}
            <div className="flex flex-col gap-0">
              <span className="flex items-center gap-1 text-xs font-semibold text-[#0f766e] sm:text-sm">
                {/* Icon lịch */}
                <svg className="h-3 w-3 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5" />
                </svg>
                <span>Lọc theo ngày</span>
              </span>

              {/* Radio buttons: responsive — stack trên mobile nhỏ, inline trên mobile trở lên */}
              <div className="flex flex-wrap gap-x-4 gap-y-0">
                <label className="flex cursor-pointer items-center gap-1.5">
                  <span className="relative flex items-center justify-center">
                    <input
                      type="radio"
                      name="dateFilterModeGroup"
                      value="range"
                      checked={dateFilterMode === 'range'}
                      onChange={() => handleDateFilterModeChange('range')}
                      className="peer h-4 w-4 cursor-pointer appearance-none rounded-full border-2 border-[#99f6e4] bg-[#f0fdfa] transition checked:border-[#10b981] checked:bg-[#10b981] checked:shadow-[0_0_0_3px_rgba(16,185,129,0.15)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#14b8a6] focus-visible:ring-offset-1 peer-disabled:cursor-not-allowed peer-disabled:opacity-50"
                    />
                    {/* Dot bên trong radio khi checked */}
                    <span className="pointer-events-none absolute inset-0 m-auto h-1.5 w-1.5 rounded-full bg-white opacity-0 transition peer-checked:opacity-100" />
                  </span>
                  <span className="text-xs font-medium text-[#334155] sm:text-sm">Khoảng ngày</span>
                </label>
                <label className="flex cursor-pointer items-center gap-1.5">
                  <span className="relative flex items-center justify-center">
                    <input
                      type="radio"
                      name="dateFilterModeGroup"
                      value="single"
                      checked={dateFilterMode === 'single'}
                      onChange={() => handleDateFilterModeChange('single')}
                      className="peer h-4 w-4 cursor-pointer appearance-none rounded-full border-2 border-[#99f6e4] bg-[#f0fdfa] transition checked:border-[#10b981] checked:bg-[#10b981] checked:shadow-[0_0_0_3px_rgba(16,185,129,0.15)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#14b8a6] focus-visible:ring-offset-1 peer-disabled:cursor-not-allowed peer-disabled:opacity-50"
                    />
                    <span className="pointer-events-none absolute inset-0 m-auto h-1.5 w-1.5 rounded-full bg-white opacity-0 transition peer-checked:opacity-100" />
                  </span>
                  <span className="text-xs font-medium text-[#334155] sm:text-sm">Một ngày cụ thể</span>
                </label>
              </div>

              {/* Các ô chọn ngày — hiển thị theo chế độ được chọn */}
              {dateFilterMode === 'range' ? (
                <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-x-1 gap-y-0">
                  <div className="flex flex-col gap-0">
                    <label htmlFor="startDateInput" className="text-[11px] font-medium text-[#065f46] sm:text-xs">Từ ngày</label>
                    <input
                      id="startDateInput"
                      type="date"
                      value={startDateInput}
                      onChange={(inputEvent) => setStartDateInput(inputEvent.target.value)}
                      className="block h-9 w-full rounded-lg border border-[#99f6e4] bg-[#f0fdfa] px-2.5 text-sm text-[#0f172a] shadow-[inset_0_1px_2px_rgba(0,0,0,0.05)] transition hover:border-[#5eead4] hover:bg-[#ccfbf1] focus:border-[#14b8a6] focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#14b8a6] focus:ring-offset-0"
                    />
                  </div>
                  <span className="flex items-center justify-center pb-3 text-sm font-semibold text-[#10b981]" aria-hidden="true">→</span>
                  <div className="flex flex-col gap-0">
                    <label htmlFor="endDateInput" className="text-[11px] font-medium text-[#065f46] sm:text-xs">Đến ngày</label>
                    <input
                      id="endDateInput"
                      type="date"
                      value={endDateInput}
                      onChange={(inputEvent) => setEndDateInput(inputEvent.target.value)}
                      className="block h-9 w-full rounded-lg border border-[#99f6e4] bg-[#f0fdfa] px-2.5 text-sm text-[#0f172a] shadow-[inset_0_1px_2px_rgba(0,0,0,0.05)] transition hover:border-[#5eead4] hover:bg-[#ccfbf1] focus:border-[#14b8a6] focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#14b8a6] focus:ring-offset-0"
                    />
                  </div>
                </div>
              ) : (
                <div className="flex flex-col gap-0 sm:max-w-[200px]">
                  <label htmlFor="singleDateInput" className="text-[11px] font-medium text-[#065f46] sm:text-xs">Chọn ngày</label>
                  <input
                    id="singleDateInput"
                    type="date"
                    value={singleDateInput}
                    onChange={(inputEvent) => setSingleDateInput(inputEvent.target.value)}
                    className="block h-9 w-full rounded-lg border border-[#99f6e4] bg-[#f0fdfa] px-2.5 text-sm text-[#0f172a] shadow-[inset_0_1px_2px_rgba(0,0,0,0.05)] transition hover:border-[#5eead4] hover:bg-[#ccfbf1] focus:border-[#14b8a6] focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#14b8a6] focus:ring-offset-0"
                  />
                </div>
              )}
            </div>
          </div>

          {/* Footer: hiển thị badge số kết quả đang lọc + nút xóa */}
          {hasActiveFilter && (
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[#d1fae5] bg-[#f7fffe] px-1 py-0.5 sm:px-1.5">
              <div className="flex items-center gap-2">
                {/* Badge số kết quả */}
                <span className="inline-flex items-center gap-1 rounded-full border border-[#a7f3d0] bg-[#d1fae5] px-2.5 py-0.5 text-xs font-semibold text-[#047857]">
                  <svg className="h-3 w-3" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path fillRule="evenodd" d="M10.5 6a1.5 1.5 0 113 0v3.75a1.5 1.5 0 01-3 0V6zM10.5 15.75a1.5 1.5 0 113 0v3.75a1.5 1.5 0 01-3 0v-3.75z" clipRule="evenodd" /></svg>
                  <span>{filteredDonorList.length} / {donorList.length} kết quả</span>
                </span>
              </div>
              <button
                type="button"
                onClick={() => { setSearchNameQuery(''); setDebouncedSearchName(''); setStartDateInput(''); setEndDateInput(''); setSingleDateInput(''); setDateFilterMode('range'); }}
                className="inline-flex items-center gap-1.5 rounded-lg border border-[#fca5a5] bg-white px-3 py-1.5 text-xs font-semibold text-[#dc2626] shadow-[0_2px_6px_rgba(239,68,68,0.08)] transition hover:border-[#f87171] hover:bg-[#fff5f5] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ef4444] focus-visible:ring-offset-1"
              >
                <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                <span>Xóa bộ lọc</span>
              </button>
            </div>
          )}
        </section>

        {donorListContent}
      </div>
    </main>
  );
}
/** Hàm trang danh sách nhà hảo tâm. Mục đích: bọc useSearchParams trong Suspense để Next.js prerender an toàn. */
export default function DonorsPage() {
  return (
    <Suspense fallback={<main className="min-h-screen bg-[#eefdf9] px-4 py-10 text-center text-sm font-semibold text-[#0f766e]">Đang tải danh sách nhà hảo tâm...</main>}>
      <DonorsPageContent />
    </Suspense>
  );
}
