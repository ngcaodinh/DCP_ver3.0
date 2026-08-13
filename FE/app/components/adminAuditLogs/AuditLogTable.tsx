'use client';

import type { AuditLogItem } from './types';

interface AuditLogTableProps {
  items: AuditLogItem[];
}

const HIDDEN_CONTEXT_KEYS = /account|password|secret|token|phone|email|wallet|address|beneficiary|name/i;

/** Bảng chỉ render DTO đã allowlist; lớp UI vẫn loại key nhạy cảm nếu API bị cấu hình sai. */
export function AuditLogTable({ items }: AuditLogTableProps) {
  if (items.length === 0) {
    return <div className="rounded-lg border border-dashed border-slate-300 bg-white p-10 text-center text-sm text-slate-500">Không có audit log phù hợp với bộ lọc.</div>;
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
      <table className="min-w-[1100px] w-full text-left text-sm">
        <caption className="sr-only">Danh sách admin audit logs</caption>
        <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th scope="col" className="px-4 py-3">Thời gian</th>
            <th scope="col" className="px-4 py-3">Action</th>
            <th scope="col" className="px-4 py-3">Admin</th>
            <th scope="col" className="px-4 py-3">Target</th>
            <th scope="col" className="px-4 py-3">IP / User-Agent</th>
            <th scope="col" className="px-4 py-3">Context</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {items.map((item) => (
            <tr key={item.actionId} className="align-top hover:bg-slate-50">
              <td className="whitespace-nowrap px-4 py-4 text-slate-600">{formatDate(item.createdAt)}</td>
              <td className="px-4 py-4">
                <span className="font-mono text-xs text-slate-900">{item.actionType}</span>
                {item.requiresEscalation && <span className="mt-1 block text-xs font-medium text-amber-700">Escalation</span>}
              </td>
              <td className="px-4 py-4 text-slate-700"><span className="font-mono text-xs">{item.adminId ?? 'SYSTEM'}</span><span className="mt-1 block text-xs text-slate-500">{item.adminRole ?? 'system'}</span></td>
              <td className="px-4 py-4"><span className="block text-xs text-slate-500">{item.targetType}</span><span className="font-mono text-xs text-slate-800">{item.targetId}</span></td>
              <td className="max-w-xs px-4 py-4 text-xs text-slate-600"><span className="block font-mono">{item.ipAddress ?? '—'}</span><span className="mt-1 block truncate" title={item.userAgent ?? undefined}>{item.userAgent ?? '—'}</span></td>
              <td className="max-w-sm px-4 py-4"><div className="space-y-1 text-xs text-slate-600">{safeContextEntries(item.context).map(([key, value]) => <div key={key}><span className="font-medium text-slate-700">{key}:</span> {formatContextValue(value)}</div>)}{item.reason && <div><span className="font-medium text-slate-700">reason:</span> {item.reason}</div>}</div></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function safeContextEntries(context: Record<string, unknown>): Array<[string, unknown]> {
  return Object.entries(context).filter(([key]) => !HIDDEN_CONTEXT_KEYS.test(key)).slice(0, 20);
}

function formatContextValue(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(sanitizeDisplayValue(value));
  } catch {
    return '[unavailable]';
  }
}

/** Mask recursive context ở UI như lớp phòng thủ cuối nếu API trả DTO sai contract. */
function sanitizeDisplayValue(value: unknown, depth = 0): unknown {
  if (depth > 2) return '[TRUNCATED]';
  if (Array.isArray(value)) return value.slice(0, 20).map(item => sanitizeDisplayValue(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !HIDDEN_CONTEXT_KEYS.test(key))
        .slice(0, 20)
        .map(([key, nestedValue]) => [key, sanitizeDisplayValue(nestedValue, depth + 1)])
    );
  }
  if (typeof value === 'string') return value.slice(0, 500);
  return value;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh',
    dateStyle: 'medium',
    timeStyle: 'medium'
  }).format(date);
}
