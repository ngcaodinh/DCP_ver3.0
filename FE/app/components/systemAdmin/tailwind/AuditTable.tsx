import { useEffect, useMemo, useState } from 'react';
import { getShortHash, getStatusBadgeClass } from './helpers';
import type { AuditLogItem } from './types';

type AuditTableProps = {
  auditLogItemList: AuditLogItem[];
};

/** Danh sách lựa chọn cho bộ lọc trạng thái ký duyệt. */
const statusFilterOptionList = ['Tất cả trạng thái', 'Đã ký', 'Chờ ký', 'Bị từ chối'] as const;

/** Danh sách lựa chọn số bản ghi trên mỗi trang. */
const pageSizeOptionList = [5, 10, 20, 50] as const;

/** Hàm tạo đường dẫn block explorer cho transaction hash. */
function buildTransactionExplorerUrl(transactionHashValue: string): string {
  if (!transactionHashValue) return '';
  const blockchainExplorerTxBaseUrl = String(
    process.env.NEXT_PUBLIC_BLOCKCHAIN_EXPLORER_TX_BASE_URL || 'https://amoy.polygonscan.com/tx'
  ).trim();
  return `${blockchainExplorerTxBaseUrl.replace(/\/$/, '')}/${transactionHashValue}`;
}

/** Hàm component AuditTable để hiển thị nhật ký ký duyệt bằng dữ liệu thật từ backend, không dùng dữ liệu cố định. */
export default function AuditTable({ auditLogItemList }: AuditTableProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedStatusFilter, setSelectedStatusFilter] = useState<string>('Tất cả trạng thái');
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(10);

  /** Danh sách nhật ký đã được lọc theo trạng thái và từ khóa tìm kiếm. */
  const filteredAuditLogItemList = useMemo(() => {
    return auditLogItemList.filter((auditLogItem) => {
      const isMatchingStatus =
        selectedStatusFilter === 'Tất cả trạng thái' || auditLogItem.statusText === selectedStatusFilter;
      const normalizedSearchQuery = searchQuery.trim().toLowerCase();
      const isMatchingSearch =
        normalizedSearchQuery === '' ||
        auditLogItem.transactionId.toLowerCase().includes(normalizedSearchQuery) ||
        auditLogItem.requestId.toLowerCase().includes(normalizedSearchQuery);
      return isMatchingStatus && isMatchingSearch;
    });
  }, [auditLogItemList, selectedStatusFilter, searchQuery]);

  const totalAuditLogCount = auditLogItemList.length;
  const filteredAuditLogCount = filteredAuditLogItemList.length;
  const totalPages = Math.max(1, Math.ceil(filteredAuditLogCount / pageSize));
  const displayedStartIndex = filteredAuditLogCount > 0 ? (currentPage - 1) * pageSize + 1 : 0;
  const displayedEndIndex = Math.min(currentPage * pageSize, filteredAuditLogCount);

  /** Danh sách nhật ký chỉ thuộc trang hiện tại. */
  const paginatedAuditLogItemList = useMemo(() => {
    const startIndex = (currentPage - 1) * pageSize;
    return filteredAuditLogItemList.slice(startIndex, startIndex + pageSize);
  }, [currentPage, filteredAuditLogItemList, pageSize]);

  useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery, selectedStatusFilter, pageSize]);

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
    <div className="overflow-hidden rounded-xl border border-emerald-900/15 bg-white">
      <div className="border-b border-emerald-900/15 px-6 py-3.5">
        <h2 className="text-[14px] font-bold leading-5 text-slate-900">Nhật ký ký duyệt gần nhất</h2>
      </div>

      <div className="flex flex-wrap items-center gap-2.5 border-b border-emerald-900/15 bg-slate-50 px-6 py-3">
        <div className="relative w-full md:w-[300px]">
          <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400">⌕</span>
          <input
            placeholder="Tìm mã yêu cầu / Tx hash"
            value={searchQuery}
            onChange={(inputEvent) => setSearchQuery(inputEvent.target.value)}
            className="h-8 w-full rounded-lg border border-emerald-900/15 bg-white pl-7 pr-3 text-[12px] outline-none transition focus:border-cyan-500"
          />
        </div>
        <select
          value={selectedStatusFilter}
          onChange={(selectEvent) => setSelectedStatusFilter(selectEvent.target.value)}
          className="h-8 min-w-[156px] rounded-lg border border-emerald-900/15 bg-white px-3 text-[12px] text-slate-700 outline-none transition focus:border-cyan-500"
        >
          {statusFilterOptionList.map((statusOption) => (
            <option key={statusOption} value={statusOption}>{statusOption}</option>
          ))}
        </select>
      </div>

      <div className="overflow-x-auto">
        <table className="min-w-full text-left">
          <thead className="bg-slate-50 text-[10px] uppercase tracking-[0.1em] text-slate-500">
            <tr>
              {['Tx hash', 'Yêu cầu', 'Số tiền', 'Trạng thái', 'Đơn vị thao tác', 'Thời gian'].map((headerLabel) => (
                <th key={headerLabel} className="px-6 py-2.5 font-semibold">{headerLabel}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {paginatedAuditLogItemList.length === 0 ? (
              <tr className="border-t border-slate-100">
                <td colSpan={6} className="px-6 py-6 text-center text-sm text-slate-500">
                  {auditLogItemList.length === 0
                    ? 'Chưa có dữ liệu nhật ký ký duyệt từ backend.'
                    : 'Không tìm thấy bản ghi phù hợp với bộ lọc.'}
                </td>
              </tr>
            ) : paginatedAuditLogItemList.map((auditLogItem) => {
              const transactionExplorerUrl = buildTransactionExplorerUrl(auditLogItem.transactionId);
              return (
                <tr key={`${auditLogItem.transactionId}-${auditLogItem.requestId}-${auditLogItem.timeText}`} className="border-t border-slate-100 text-sm transition hover:bg-slate-50/80">
                  <td className="px-6 py-3 font-mono text-[12px] leading-4">
                    {transactionExplorerUrl ? (
                      <a
                        href={transactionExplorerUrl}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="inline-flex items-center gap-1 text-cyan-700 hover:text-cyan-900 hover:underline"
                        title={auditLogItem.transactionId}
                      >
                        <svg className="h-3 w-3 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
                        </svg>
                        <span>{getShortHash(auditLogItem.transactionId)}</span>
                      </a>
                    ) : (
                      <span className="text-cyan-700">{getShortHash(auditLogItem.transactionId)}</span>
                    )}
                  </td>
                  <td className="px-6 py-3 text-[13px] leading-4 text-slate-800">{auditLogItem.requestId}</td>
                  <td className="px-6 py-3 font-mono text-[13px] font-semibold leading-4 text-slate-800">{auditLogItem.amountText}</td>
                  <td className="px-6 py-3">
                    <span className={`inline-flex rounded-full px-2.5 py-1 text-[11px] font-semibold leading-none ${getStatusBadgeClass(auditLogItem.statusText)}`}>
                      {auditLogItem.statusText}
                    </span>
                  </td>
                  <td className="px-6 py-3 text-[13px] leading-4 text-slate-700">{auditLogItem.actorText}</td>
                  <td className="px-6 py-3 font-mono text-[12px] leading-4 text-slate-600">{auditLogItem.timeText}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-emerald-900/15 bg-slate-50 px-6 py-2.5 text-[12px] text-slate-600">
        <p>Hiển thị {displayedStartIndex}-{displayedEndIndex} trên {filteredAuditLogCount} bản ghi{filteredAuditLogCount !== totalAuditLogCount ? ` (tổng ${totalAuditLogCount})` : ''}</p>
        <p className="font-medium text-slate-500">Đồng bộ thời gian thực từ backend</p>
      </div>

      {filteredAuditLogCount > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-emerald-900/15 bg-slate-50 px-5 py-3">
          <div className="flex items-center gap-2">
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
  );
}
