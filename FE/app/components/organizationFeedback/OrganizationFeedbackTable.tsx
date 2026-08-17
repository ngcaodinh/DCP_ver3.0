'use client';

import type { ReactElement } from 'react';
import type { OrganizationFeedbackItem } from './types';

interface OrganizationFeedbackTableProps {
  items: OrganizationFeedbackItem[];
}

const FEEDBACK_DATE_FORMATTER = new Intl.DateTimeFormat('vi-VN', {
  timeZone: 'Asia/Ho_Chi_Minh',
  dateStyle: 'medium',
  timeStyle: 'short'
});

/** Bảng feedback public-safe, chỉ render các key trong DTO và không phát hành risk score hay hash nội bộ. */
export function OrganizationFeedbackTable({ items }: OrganizationFeedbackTableProps): ReactElement {
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
      <table className="min-w-[980px] w-full text-left text-sm">
        <caption className="sr-only">Danh sách feedback đã gửi của tổ chức</caption>
        <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th scope="col" className="px-4 py-3">Dự án</th>
            <th scope="col" className="px-4 py-3">Điểm</th>
            <th scope="col" className="px-4 py-3">Nội dung</th>
            <th scope="col" className="px-4 py-3">Thời điểm gửi</th>
            <th scope="col" className="px-4 py-3">Nguồn</th>
            <th scope="col" className="px-4 py-3">Trạng thái</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {items.map(item => (
            <tr key={item.feedbackId} className="align-top hover:bg-slate-50">
              <td className="px-4 py-4">
                <span className="block font-semibold text-slate-900">{item.projectName ?? item.projectId}</span>
                <span className="font-mono text-xs text-slate-500">{item.projectId}</span>
              </td>
              <td className="px-4 py-4 font-semibold text-amber-700">{item.rating}★</td>
              <td className="max-w-sm px-4 py-4 text-slate-700">{truncateFeedbackComment(item.comment)}</td>
              <td className="whitespace-nowrap px-4 py-4 text-slate-600">{formatFeedbackDate(item.submittedAt)}</td>
              <td className="px-4 py-4 text-slate-600">{item.source === 'batch' ? 'Batch' : 'Public'}</td>
              <td className="px-4 py-4">
                <span className={`rounded-full px-2 py-1 text-xs font-semibold ${item.isFlagged ? 'bg-amber-100 text-amber-800' : 'bg-emerald-100 text-emerald-800'}`}>
                  {item.isFlagged ? 'Đang chờ duyệt' : 'Đang hiển thị'}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Cắt preview comment nhưng giữ nguyên nội dung đầy đủ cho backend và file export. */
export function truncateFeedbackComment(comment: string): string {
  return comment.length > 120 ? `${comment.slice(0, 120)}…` : comment;
}

/** Format timestamp theo timezone nghiệp vụ của giao diện organization. */
export function formatFeedbackDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'Thời điểm không xác định';
  }
  return FEEDBACK_DATE_FORMATTER.format(date);
}
