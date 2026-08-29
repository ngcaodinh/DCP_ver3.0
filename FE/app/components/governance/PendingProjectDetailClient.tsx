'use client';

import Link from 'next/link';
import { type ReactElement, useEffect, useState } from 'react';
import { buildApiUrl, fetchApi } from '@/app/utils/apiClient';

type ProjectDetail = { projectId: string; name: string; description: string; organizationName: string; status: string; activationEligibleAt: string | null; milestonePlan: Array<{ milestoneKey: string; percentage: number; description: string }>; evidenceCids: string[]; challenges: Array<{ challengerLabel: string; reason: string; submittedAt: string }> };

/** Hiển thị dữ liệu public đã redaction của một dự án trong cửa sổ niêm yết. */
export default function PendingProjectDetailClient({ projectId }: { projectId: string }): ReactElement {
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { void fetchApi<ProjectDetail>(buildApiUrl(`/api/transparency/pending-activation-projects/${encodeURIComponent(projectId)}`)).then(response => setProject(response.data)).catch((reason: { message?: string }) => setError(reason.message || 'Không thể tải dự án niêm yết.')); }, [projectId]);
  if (error) return <main className="mx-auto max-w-3xl p-8"><Link href="/pending-projects" className="text-teal-700">← Danh sách</Link><p role="alert" className="mt-5 text-red-700">{error}</p></main>;
  if (!project) return <main className="mx-auto max-w-3xl p-8">Đang tải dự án niêm yết…</main>;
  return <main className="mx-auto max-w-3xl space-y-5 p-8"><Link href="/pending-projects" className="text-teal-700">← Danh sách</Link><header><p className="text-sm font-semibold text-teal-700">NIÊM YẾT CÔNG KHAI</p><h1 className="mt-1 text-3xl font-bold">{project.name}</h1><p className="mt-2 text-slate-600">Tổ chức: {project.organizationName}</p><p className="mt-1 text-sm">{project.status === 'DISPUTED' ? 'Dự án đang tranh chấp.' : `Dự kiến kích hoạt: ${project.activationEligibleAt ? new Date(project.activationEligibleAt).toLocaleString('vi-VN') : 'đang chờ'}`}</p></header><p>{project.description}</p><section><h2 className="font-semibold">Kế hoạch cột mốc</h2><ul className="mt-2 list-disc pl-5">{project.milestonePlan.map(item => <li key={item.milestoneKey}>{item.milestoneKey}: {item.percentage}% — {item.description}</li>)}</ul></section><section><h2 className="font-semibold">Minh chứng IPFS</h2><ul className="mt-2 list-disc pl-5 text-sm">{project.evidenceCids.map(cid => <li key={cid}>{cid}</li>)}</ul></section><section><h2 className="font-semibold">Khiếu nại đã công bố</h2>{project.challenges.length ? <div className="mt-2 space-y-2">{project.challenges.map(item => <article key={`${item.challengerLabel}-${item.submittedAt}`} className="rounded border p-3"><p className="text-sm font-medium">{item.challengerLabel}</p><p className="text-sm">{item.reason}</p><time className="text-xs text-slate-500">{new Date(item.submittedAt).toLocaleString('vi-VN')}</time></article>)}</div> : <p className="mt-2 text-sm text-slate-600">Chưa có khiếu nại.</p>}</section></main>;
}
