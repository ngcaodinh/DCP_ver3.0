'use client';

import type { ReactElement } from 'react';
import { useState } from 'react';
import { buildApiUrl, fetchApi, getApiErrorMessage } from '@/app/utils/apiClient';
import { readAuthSession } from '@/app/utils/authSession';

/** Cung cấp retry vận hành đã tồn tại cho Chủ tịch mà không trao quyền vote cho admin. */
export function ChairActionsPanel(): ReactElement {
  const [projectId, setProjectId] = useState('');
  const [notice, setNotice] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  /** Gọi retry activation có xác nhận ở tầng UI để tránh gửi nhầm dự án. */
  const retryActivation = async (): Promise<void> => {
    if (!projectId.trim()) {
      setNotice('Nhập projectId trước khi đồng bộ lại.');
      return;
    }
    if (!window.confirm('Đồng bộ lại blockchain cho dự án ' + projectId.trim() + '?')) return;
    setIsSubmitting(true);
    try {
      const token = readAuthSession().accessToken;
      await fetchApi(buildApiUrl('/api/project-governance/executive/retry-activation'), { method: 'POST', headers: token ? { Authorization: 'Bearer ' + token } : {}, body: JSON.stringify({ projectId: projectId.trim() }) });
      setNotice('Đã gửi yêu cầu đồng bộ lại blockchain.');
    } catch (error) {
      setNotice(getApiErrorMessage(error, 'Không thể đồng bộ lại dự án.'));
    } finally {
      setIsSubmitting(false);
    }
  };

  return <section aria-labelledby="chair-actions-title" className="rounded-2xl border border-violet-200 bg-gradient-to-r from-violet-50 via-white to-indigo-50 p-4 shadow-sm sm:p-5">
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0"><p className="text-xs font-bold uppercase tracking-[0.14em] text-violet-700">Công cụ vận hành</p><h2 id="chair-actions-title" className="mt-1 text-lg font-bold text-violet-950">Đồng bộ kích hoạt blockchain</h2><p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">Chỉ dùng khi kích hoạt dự án thất bại. Thao tác này không thay đổi hay thay thế quyền biểu quyết giải ngân.</p></div>
      <span className="w-fit shrink-0 rounded-full bg-violet-100 px-3 py-1.5 text-xs font-bold text-violet-800">Chỉ dành cho Chủ tịch</span>
    </div>
    <div className="mt-4 flex flex-col gap-2 sm:flex-row"><input aria-label="Project ID cần đồng bộ" value={projectId} onChange={event => setProjectId(event.target.value)} placeholder="Nhập projectId cần đồng bộ" className="min-h-11 min-w-0 flex-1 rounded-xl border border-violet-200 bg-white px-3 py-2 text-sm outline-none transition-colors placeholder:text-slate-400 focus:border-violet-500 focus:ring-2 focus:ring-violet-100" /><button type="button" disabled={isSubmitting} onClick={() => void retryActivation()} className="min-h-11 rounded-xl bg-violet-700 px-4 py-2 text-sm font-bold text-white transition-colors hover:bg-violet-800 disabled:cursor-wait disabled:opacity-60">{isSubmitting ? 'Đang gửi yêu cầu…' : 'Đồng bộ lại'}</button></div>
    {notice ? <p role="status" className="mt-3 break-words rounded-xl bg-white/80 px-3 py-2 text-sm text-slate-700">{notice}</p> : null}
  </section>;
}
