'use client';

import { type ReactElement, useEffect, useState } from 'react';
import Link from 'next/link';
import { buildApiUrl, fetchApi } from '@/app/utils/apiClient';

interface PendingProject { projectId: string; name: string; description: string; goalAmount: number; status: 'PENDING_ACTIVATION' | 'DISPUTED'; activationEligibleAt: string | null; milestonePlan: Array<{ milestoneKey: string; percentage: number; description: string }>; }
interface PendingResponse { activeAuditorCount: number; projects: PendingProject[]; }

/** Tính nhãn thời gian còn lại mà không cho phép countdown trở thành nguồn sự thật của backend. */
function formatListingTime(eligibleAt: string | null, status: PendingProject['status']): string {
  if (status === 'DISPUTED') return 'Đang tranh chấp';
  if (!eligibleAt) return 'Đang chờ kích hoạt';
  const remainingHours = Math.ceil((new Date(eligibleAt).getTime() - Date.now()) / 3_600_000);
  return remainingHours > 0 ? `Còn ${remainingHours} giờ` : 'Đang chờ kích hoạt';
}

/** Render danh sách dự án niêm yết công khai, không có hành động quyên góp hay khiếu nại. */
export default function PendingProjectsClient(): ReactElement {
  const [data, setData] = useState<PendingResponse | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  useEffect(() => { void fetchApi<PendingResponse>(buildApiUrl('/api/transparency/pending-activation-projects')).then(response => setData(response.data)).catch((error: { message?: string }) => setErrorMessage(error.message || 'Không thể tải dự án đang niêm yết.')); }, []);
  return <main className="mx-auto max-w-5xl space-y-6 px-4 py-10"><Link href="/" className="text-sm text-teal-700">← Trang chủ</Link><header><p className="text-sm font-semibold text-teal-700">NIÊM YẾT CÔNG KHAI</p><h1 className="text-3xl font-bold text-slate-900">Dự án chờ kích hoạt</h1><p className="mt-2 text-slate-600">Dự án chỉ được mở quỹ sau thời gian rà soát. Trang này không nhận quyên góp.</p></header>{data?.activeAuditorCount === 0 && <p className="rounded-md border border-red-200 bg-red-50 p-4 text-red-800">Hệ thống hiện chưa có Kiểm toán viên hoạt động; cửa sổ rà soát đang không có người giám sát.</p>}{errorMessage && <p role="alert" className="text-red-700">{errorMessage}</p>}<div className="grid gap-4">{data?.projects.map(project => <article key={project.projectId} className="rounded-lg border bg-white p-5 shadow-sm"><div className="flex items-start justify-between gap-4"><div><h2 className="text-xl font-semibold">{project.name}</h2><p className="mt-1 text-slate-600">{project.description}</p></div><span className={project.status === 'DISPUTED' ? 'rounded bg-violet-100 px-3 py-1 text-violet-800' : 'rounded bg-amber-100 px-3 py-1 text-amber-800'}>{formatListingTime(project.activationEligibleAt, project.status)}</span></div><p className="mt-3 text-sm">Mục tiêu: {new Intl.NumberFormat('vi-VN').format(project.goalAmount)}₫</p><ul className="mt-3 list-disc pl-5 text-sm text-slate-700">{project.milestonePlan.map(item => <li key={item.milestoneKey}>{item.milestoneKey}: {item.percentage}% — {item.description}</li>)}</ul><Link href={`/pending-projects/${encodeURIComponent(project.projectId)}`} className="mt-4 inline-block text-sm font-semibold text-teal-700">Xem hồ sơ niêm yết →</Link></article>)}{data && !data.projects.length && <p className="text-slate-600">Chưa có dự án đang niêm yết.</p>}</div></main>;
}
