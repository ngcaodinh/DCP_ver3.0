'use client';

import type { ReactElement } from 'react';
import type { OrganizationFeedbackStats } from './types';

interface FeedbackStatsChartProps {
  stats: OrganizationFeedbackStats;
}

/** Hiển thị các thẻ tổng quan và phân bố rating bằng Tailwind thuần, không thêm thư viện biểu đồ. */
export function FeedbackStatsChart({ stats }: FeedbackStatsChartProps): ReactElement {
  const highestCount = Math.max(...Array.from({ length: 5 }, (_, index) => stats.distribution[String(index + 1)] ?? 0), 0);

  return (
    <section aria-label="Thống kê feedback" className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard label="Tổng số phản hồi" value={String(stats.totalCount)} />
        <StatCard label="Đang hiển thị" value={String(stats.visibleCount)} />
        <StatCard label="Đang chờ duyệt" value={String(stats.pendingCount)} />
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold text-slate-900">Phân bố đánh giá</h2>
          <span className="text-sm text-slate-600">
            Điểm trung bình:{' '}
            <strong>{stats.avgRating === null ? '—' : `${stats.avgRating.toFixed(2)}★`}</strong>
          </span>
        </div>

        {stats.totalCount === 0 ? (
          <p className="mt-4 text-sm text-slate-500">Chưa có dữ liệu thống kê.</p>
        ) : (
          <div className="mt-4 space-y-3">
            {[5, 4, 3, 2, 1].map(rating => {
              const count = stats.distribution[String(rating)] ?? 0;
              const percentage = highestCount === 0 ? 0 : (count / highestCount) * 100;
              return (
                <div key={rating} className="flex items-center gap-3">
                  <span className="w-10 text-xs font-semibold text-slate-600">{rating}★</span>
                  <div className="h-3 flex-1 rounded-full bg-slate-100" aria-hidden="true">
                    <div className="h-3 rounded-full bg-amber-400" style={{ width: `${percentage}%` }} />
                  </div>
                  <span
                    className="w-20 text-right text-xs text-slate-600"
                    aria-label={`${rating} sao: ${count} phản hồi`}
                  >
                    {count} ({Math.round((count / stats.totalCount) * 100)}%)
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

/** Hiển thị một thẻ số liệu có nhãn rõ ràng cho màn hình nhỏ và trình đọc màn hình. */
function StatCard({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <p className="text-xs font-medium text-slate-500">{label}</p>
      <p className="mt-2 text-2xl font-bold text-slate-900">{value}</p>
    </div>
  );
}
