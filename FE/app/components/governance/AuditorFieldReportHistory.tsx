'use client';

import { type ReactElement, useEffect, useState } from 'react';
import { ChallengeEvidenceGallery } from './ChallengeEvidenceGallery';
import type { AuditorFieldReportHistoryItem } from '@/app/utils/auditorPortalApi';

interface AuditorFieldReportHistoryProps {
  fetchAuditorResource: <T>(pathname: string) => Promise<T | null>;
}

/** Hiển thị các biên bản hiện trường của chính Auditor, gồm ảnh và mốc đã xác nhận. */
export default function AuditorFieldReportHistory({ fetchAuditorResource }: AuditorFieldReportHistoryProps): ReactElement {
  const [reports, setReports] = useState<AuditorFieldReportHistoryItem[] | null>(null);
  const [errorMessage, setErrorMessage] = useState('');

  /** Tải lịch sử một lần khi khối được mount và báo đúng lỗi thay vì đánh đồng với danh sách rỗng. */
  useEffect(() => {
    void fetchAuditorResource<AuditorFieldReportHistoryItem[]>('/api/project-governance/auditor/my-field-reports?limit=50')
      .then(response => setReports(Array.isArray(response) ? response : []))
      .catch(() => {
        setErrorMessage('Không thể tải biên bản đã nộp. Vui lòng thử lại sau.');
        setReports([]);
      });
  }, [fetchAuditorResource]);

  if (reports === null) return <div className="mt-6 border-t border-slate-100 pt-6 text-sm text-slate-500">Đang tải biên bản đã nộp…</div>;

  return (
    <section className="mt-6 min-w-0 border-t border-slate-100 pt-6">
      <h3 className="break-words text-xl font-bold text-slate-950">Biên bản tôi đã nộp</h3>
      {errorMessage && <p role="alert" className="mt-3 rounded-xl bg-red-50 p-3 text-sm text-red-800">{errorMessage}</p>}
      {reports.length ? <div className="mt-4 min-w-0 space-y-4">{reports.map(report => <article key={report.reportId} className="min-w-0 rounded-2xl border border-slate-200 p-4"><h4 className="break-words font-bold text-slate-900">{report.projectName}</h4><p className="mt-1 text-sm text-slate-600">{new Date(report.submittedAt).toLocaleString('vi-VN')}</p><p className="mt-3 break-words text-sm text-slate-700">{report.note}</p><div className="mt-3 flex flex-wrap gap-2">{report.verifiedMilestoneIndexes.map(index => <span key={index} className="rounded-full bg-emerald-50 px-2 py-1 text-xs font-bold text-emerald-800">Mốc {index}</span>)}</div><div className="mt-4"><ChallengeEvidenceGallery photos={report.photos} /></div></article>)}</div> : !errorMessage && <p className="mt-3 text-sm text-slate-600">Bạn chưa nộp biên bản hiện trường nào. Mỗi dự án chỉ nhận đúng một biên bản.</p>}
    </section>
  );
}
