'use client';

import type { ReactElement, ReactNode } from 'react';
import {
  HIGH_RISK_HIGHLIGHT_THRESHOLD,
  type DeletionState,
  type FeedbackActionMode,
  type FlaggedFeedbackItem
} from './types';

interface FeedbackFlaggingPanelProps {
  items: FlaggedFeedbackItem[];
  deletionState: DeletionState;
  isLoading: boolean;
  onViewDetail: (item: FlaggedFeedbackItem, trigger: HTMLButtonElement) => void;
  onAction: (item: FlaggedFeedbackItem, mode: FeedbackActionMode, trigger: HTMLButtonElement) => void;
}

const indicatorLabels: Record<string, string> = {
  repeated_words: 'Từ lặp lại',
  gibberish_detected: 'Nội dung khó hiểu',
};

/** Hiển thị lý do flag theo nguồn manual/auto/legacy mà không trộn ngữ nghĩa giữa các nhánh. */
export function renderFlagReason(item: FlaggedFeedbackItem): ReactNode {
  if (item.flagReason.kind === 'MANUAL') {
    return (
      <div className="space-y-1">
        <span className="font-semibold text-amber-700">Admin flag</span>
        <p>{item.flagReason.adminReason ?? 'Không có lý do admin.'}</p>
        <p className="text-[11px] text-slate-500">
          {item.flagReason.flaggedByAdminId ?? 'Admin không xác định'} · {formatDate(item.flagReason.flaggedAt)}
        </p>
      </div>
    );
  }
  if (item.flagReason.kind === 'AUTO') {
    return (
      <div className="space-y-1">
        <span className="font-semibold text-violet-700">Tự động phát hiện</span>
        <p>{formatIndicators(item.flagReason.indicators)}</p>
      </div>
    );
  }
  return <span className="text-slate-500">Không xác định</span>;
}

/** Bảng feedback bị flag với empty state riêng cho từng tab và thao tác keyboard-accessible. */
export function FeedbackFlaggingPanel({
  items,
  deletionState,
  isLoading,
  onViewDetail,
  onAction
}: FeedbackFlaggingPanelProps): ReactElement {
  if (isLoading) {
    return <FeedbackTableSkeleton />;
  }

  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-slate-300 bg-white p-10 text-center text-sm text-slate-500">
        {deletionState === 'active'
          ? 'Không có feedback nào đang bị flag.'
          : 'Không có feedback nào đang trong cửa sổ khôi phục.'}
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
      <table className="min-w-[1120px] w-full text-left text-sm">
        <caption className="sr-only">
          {deletionState === 'active' ? 'Danh sách feedback đang bị flag' : 'Danh sách feedback đã xoá mềm'}
        </caption>
        <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th scope="col" className="px-4 py-3">Project</th>
            <th scope="col" className="px-4 py-3">Risk score</th>
            <th scope="col" className="px-4 py-3">Flag reason</th>
            <th scope="col" className="px-4 py-3">Comment preview</th>
            <th scope="col" className="px-4 py-3">Hành động</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {items.map((item) => {
            const isHighRisk = item.riskScore > HIGH_RISK_HIGHLIGHT_THRESHOLD;
            return (
              <tr key={item.feedbackId} className={`align-top ${isHighRisk ? 'bg-red-50' : 'hover:bg-slate-50'}`}>
                <td className="px-4 py-4">
                  <span className="block font-semibold text-slate-900">{item.projectName ?? item.projectId}</span>
                  <span className="font-mono text-xs text-slate-500">{item.projectId}</span>
                </td>
                <td className="px-4 py-4">
                  <span className={`font-mono font-bold ${isHighRisk ? 'text-red-700' : 'text-slate-800'}`}>{item.riskScore}/10</span>
                  {isHighRisk && <span className="mt-1 block text-xs font-semibold text-red-700">Rủi ro cao</span>}
                </td>
                <td className="max-w-xs px-4 py-4 text-xs text-slate-700">{renderFlagReason(item)}</td>
                <td className="max-w-sm px-4 py-4 text-slate-700">
                  <p>{truncateComment(item.comment)}</p>
                  <span className="mt-1 block text-xs text-slate-500">{formatDate(item.submittedAt)}</span>
                </td>
                <td className="px-4 py-4">
                  <div className="flex min-w-[180px] flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={(event) => onViewDetail(item, event.currentTarget)}
                      className="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100"
                    >
                      Xem chi tiết
                    </button>
                    {deletionState === 'active' ? (
                      <>
                        <button
                          type="button"
                          onClick={(event) => onAction(item, 'unflag', event.currentTarget)}
                          className="rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-100"
                        >
                          Bỏ flag
                        </button>
                        <button
                          type="button"
                          onClick={(event) => onAction(item, 'delete', event.currentTarget)}
                          className="rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-100"
                        >
                          Xoá
                        </button>
                      </>
                    ) : (
                      <div className="flex items-center gap-2">
                        <span className={`rounded-full px-2 py-1 text-xs font-semibold ${isNearPurge(item) ? 'bg-red-100 text-red-700' : item.isRestorable ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-600'}`}>
                          {item.isRestorable ? `Còn ${item.daysUntilPurge ?? 0} ngày` : 'Hết hạn khôi phục'}
                        </span>
                        <button
                          type="button"
                          onClick={(event) => onAction(item, 'restore', event.currentTarget)}
                          disabled={!item.isRestorable}
                          className="rounded-md border border-blue-200 bg-blue-50 px-2.5 py-1.5 text-xs font-semibold text-blue-700 hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          Khôi phục
                        </button>
                      </div>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Truncate preview tại FE để BE vẫn giữ nguyên comment phục vụ detail và audit policy. */
export function truncateComment(comment: string): string {
  return comment.length > 120 ? `${comment.slice(0, 120)}…` : comment;
}

/** Xác định nhãn cảnh báo khi feedback sắp hết cửa sổ khôi phục. */
export function isNearPurge(item: FlaggedFeedbackItem): boolean {
  return item.isRestorable === true && (item.daysUntilPurge ?? 0) <= 3;
}

/** Chuyển indicators heuristic thành nhãn tiếng Việt dễ đọc trong bảng. */
function formatIndicators(indicators: string[]): string {
  if (indicators.length === 0) return 'Không có chỉ báo cụ thể.';
  return indicators.map(indicator => {
    if (indicator.startsWith('extreme_rating:')) return `Rating cực đoan (${indicator.slice('extreme_rating:'.length)} sao)`;
    return indicatorLabels[indicator] ?? indicator;
  }).join(', ');
}

/** Format timestamp theo timezone sản phẩm mà không làm lộ metadata khác. */
function formatDate(value: string | null): string {
  if (!value) return 'Thời điểm không xác định';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Thời điểm không xác định';
  return new Intl.DateTimeFormat('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh',
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(date);
}

/** Placeholder nhẹ trong lúc server state đang tải. */
function FeedbackTableSkeleton(): ReactElement {
  return <div aria-label="Đang tải feedback bị flag" className="space-y-2 rounded-lg border border-slate-200 bg-white p-4">{Array.from({ length: 5 }, (_, index) => <div key={index} className="h-16 animate-pulse rounded bg-slate-100" />)}</div>;
}
