'use client';

// =============================================================================
// TransparencyDashboardClient — D4: Thành phần client điều phối trang /transparency.
// Gồm: bộ chọn dự án (GET /donations/campaigns), điều phối 2 hook dữ liệu
// (timeline + summary), render DonutChart + UnifiedTimeline, nút Xuất PDF
// (window.print) và Xuất CSV (helper tự viết). Khi chưa chọn dự án → hiển thị
// hướng dẫn và KHÔNG gọi timeline/summary.
// =============================================================================

import { useMemo, useState } from 'react';
import { useTransparencyTimeline } from '@/app/hooks/useTransparencyTimeline';
import { useTransparencySummary } from '@/app/hooks/useTransparencySummary';
import { useTransparencyProjects } from '@/app/hooks/useTransparencyProjects';
import type { TimelineEvent } from './types';
import UnifiedTimeline from './UnifiedTimeline';
import DonutChart from './DonutChart';
import { downloadTimelineCsv } from './exportCsv';
import { formatVnd } from './format';
import FoundationKycVerifiedBadge from '@/app/components/foundationKyc/FoundationKycVerifiedBadge';

/**
 * Thành phần thẻ số liệu tổng quan (nhãn + giá trị).
 *
 * @param label Nhãn mô tả chỉ số
 * @param value Giá trị hiển thị (đã định dạng)
 */
function SummaryStatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-emerald-900/15 bg-white p-4">
      <p className="text-xs text-slate-500">{label}</p>
      <p className="mt-1 font-mono text-lg font-semibold text-slate-900">{value}</p>
    </div>
  );
}

/**
 * Thành phần dashboard minh bạch chính.
 * Điều phối toàn bộ luồng chọn dự án → tải dữ liệu → hiển thị → xuất báo cáo.
 */
export default function TransparencyDashboardClient() {
  const [selectedProjectId, setSelectedProjectId] = useState('');

  // Tải danh sách dự án cho bộ chọn qua hook chung (đồng bộ layer data-fetching với timeline/summary).
  const projectsQuery = useTransparencyProjects();
  const projectOptions = projectsQuery.data ?? [];
  const isLoadingProjects = projectsQuery.isLoading;
  const projectLoadError = projectsQuery.isError
    ? projectsQuery.error?.message || 'Không thể tải danh sách dự án.'
    : '';

  const timelineQuery = useTransparencyTimeline(selectedProjectId || undefined);
  const summaryQuery = useTransparencySummary(selectedProjectId || undefined);

  // Gộp sự kiện từ tất cả các trang đã tải thành một mảng phẳng để render + xuất CSV.
  const timelineEvents = useMemo<TimelineEvent[]>(() => {
    if (!timelineQuery.data) {
      return [];
    }
    return timelineQuery.data.pages.flatMap((page) => page.timeline);
  }, [timelineQuery.data]);

  const hasSelectedProject = Boolean(selectedProjectId);
  const summary = summaryQuery.data;

  /** Hàm xử lý xuất PDF. Mục đích: dùng cơ chế in của trình duyệt (CSS @media print lo phần ẩn/hiện). */
  function handleExportPdf() {
    window.print();
  }

  /** Hàm xử lý xuất CSV. Mục đích: tải toàn bộ sự kiện đang hiển thị ra file CSV UTF-8. */
  function handleExportCsv() {
    downloadTimelineCsv(timelineEvents, `transparency-${selectedProjectId || 'all'}-${Date.now()}.csv`);
  }

  const canExport = hasSelectedProject && timelineEvents.length > 0;

  return (
    <main className="mx-auto max-w-5xl px-4 py-8">
      {/* Khu vực tiêu đề + bộ điều khiển: sẽ được ẩn khi in PDF (class transparency-controls). */}
      <header className="transparency-controls mb-6">
        <h1 className="text-2xl font-bold text-slate-900">Bảng minh bạch dòng tiền</h1>
        <p className="mt-1 text-sm text-slate-500">
          Trực quan hóa dòng tiền liền mạch: Nạp VND → Phát hành token → Quyên góp → Giải ngân.
        </p>

        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="flex-1">
            <label htmlFor="transparency-project-select" className="mb-1 block text-sm font-medium text-slate-700">
              Chọn dự án
            </label>
            <select
              id="transparency-project-select"
              value={selectedProjectId}
              onChange={(event) => setSelectedProjectId(event.target.value)}
              disabled={isLoadingProjects || Boolean(projectLoadError)}
              className="w-full rounded-md border border-emerald-900/15 bg-white px-3 py-2 text-sm text-slate-900 disabled:cursor-not-allowed disabled:bg-slate-100 sm:max-w-md"
            >
              <option value="">
                {isLoadingProjects ? 'Đang tải dự án...' : '— Vui lòng chọn dự án —'}
              </option>
              {projectOptions.map((option) => (
                <option key={option.projectId} value={option.projectId}>
                  {option.name}
                </option>
              ))}
            </select>
            {projectLoadError && <p className="mt-1 text-xs text-red-600">{projectLoadError}</p>}
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleExportPdf}
              disabled={!canExport}
              className="rounded-md bg-gradient-to-r from-[#0E7C6B] to-[#1AAE97] px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
            >
              Xuất PDF
            </button>
            <button
              type="button"
              onClick={handleExportCsv}
              disabled={!canExport}
              className="rounded-md border border-emerald-900/15 bg-white px-4 py-2 text-sm font-semibold text-emerald-800 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Xuất CSV
            </button>
          </div>
        </div>
      </header>

      <FoundationKycVerifiedBadge />

      {/* Trạng thái chưa chọn dự án: hướng dẫn, không gọi API summary/timeline. */}
      {!hasSelectedProject ? (
        <div className="transparency-controls rounded-lg border border-dashed border-emerald-900/25 bg-slate-50 p-10 text-center text-slate-500">
          Vui lòng chọn dự án để xem dòng tiền và biểu đồ minh bạch.
        </div>
      ) : (
        // Khu vực báo cáo: phần được giữ lại khi in PDF.
        <section className="transparency-report grid grid-cols-1 gap-6 lg:grid-cols-3">
          {/* Cột trái: biểu đồ donut + số liệu tổng quan. */}
          <aside className="lg:col-span-1">
            <div className="rounded-lg border border-emerald-900/15 bg-white p-5">
              <h2 className="mb-4 text-lg font-semibold text-slate-900">Tổng quan phân bổ</h2>
              {summaryQuery.isLoading ? (
                <p className="text-center text-sm text-slate-500">Đang tải số liệu...</p>
              ) : summaryQuery.isError ? (
                <div className="text-center">
                  <p className="mb-3 text-sm text-red-700">
                    {summaryQuery.error?.message || 'Không thể tải số liệu tổng quan.'}
                  </p>
                  <button
                    type="button"
                    onClick={() => summaryQuery.refetch()}
                    className="rounded-md border border-red-300 bg-white px-4 py-2 text-sm font-semibold text-red-700 hover:bg-red-100"
                  >
                    Thử lại
                  </button>
                </div>
              ) : summary ? (
                <DonutChart
                  totalRaised={summary.totalRaised}
                  totalDisbursed={summary.totalDisbursed}
                  remaining={summary.remaining}
                />
              ) : null}
            </div>

            {summary && !summaryQuery.isLoading && !summaryQuery.isError && (
              <div className="mt-4 grid grid-cols-2 gap-3">
                <SummaryStatCard label="Số giao dịch" value={formatVnd(summary.transactionCount)} />
                <SummaryStatCard label="Lượt giải ngân" value={formatVnd(summary.disbursementCount)} />
              </div>
            )}
          </aside>

          {/* Cột phải: timeline dòng tiền. */}
          <div className="lg:col-span-2">
            <h2 className="mb-4 text-lg font-semibold text-slate-900">Dòng thời gian giao dịch</h2>
            <UnifiedTimeline
              events={timelineEvents}
              isLoading={timelineQuery.isLoading}
              isError={timelineQuery.isError}
              errorMessage={timelineQuery.error?.message}
              onRetry={() => timelineQuery.refetch()}
              hasNextPage={Boolean(timelineQuery.hasNextPage)}
              isFetchingNextPage={timelineQuery.isFetchingNextPage}
              onLoadMore={() => timelineQuery.fetchNextPage()}
            />
          </div>
        </section>
      )}
    </main>
  );
}
