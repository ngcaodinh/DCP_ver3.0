'use client';

import { type ReactElement, useEffect, useMemo, useState } from 'react';
import { ARBITRATION_OUTCOME_LABEL } from '@/app/constants/auditorPortal';
import { ChallengeEvidenceGallery } from './ChallengeEvidenceGallery';
import type { AuditorListingRecord } from '@/app/utils/auditorPortalApi';

type ListingFilter = 'ALL' | 'CONFIRMED' | 'CHALLENGE';

interface AuditorListingHistoryProps {
  fetchAuditorResource: <T>(pathname: string) => Promise<T | null>;
}

/** Hiển thị lịch sử kết luận niêm yết của Auditor mà không suy diễn trạng thái từ bản ghi khiếu nại. */
export default function AuditorListingHistory({ fetchAuditorResource }: AuditorListingHistoryProps): ReactElement {
  const [records, setRecords] = useState<AuditorListingRecord[] | null>(null);
  const [filter, setFilter] = useState<ListingFilter>('ALL');
  const [errorMessage, setErrorMessage] = useState('');

  /** Tải lịch sử khi khối mount và giữ riêng trạng thái lỗi để không che giấu sự cố API. */
  useEffect(() => {
    void fetchAuditorResource<AuditorListingRecord[]>('/api/project-governance/auditor/my-listing-records?limit=50')
      .then(response => setRecords(Array.isArray(response) ? response : []))
      .catch(() => {
        setErrorMessage('Không thể tải lịch sử xác minh. Vui lòng thử lại sau.');
        setRecords([]);
      });
  }, [fetchAuditorResource]);

  const visibleRecords = useMemo(() => (records || []).filter(record => filter === 'ALL' || record.kind === filter), [filter, records]);
  if (records === null) return <div className="mt-6 border-t border-slate-100 pt-6 text-sm text-slate-500">Đang tải lịch sử xác minh…</div>;

  return (
    <section className="mt-6 min-w-0 border-t border-slate-100 pt-6">
      <h3 className="break-words text-xl font-bold text-slate-950">Lịch sử xác minh niêm yết</h3>
      {errorMessage && <p role="alert" className="mt-3 rounded-xl bg-red-50 p-3 text-sm text-red-800">{errorMessage}</p>}
      <div className="mt-3 flex flex-wrap gap-2">{(['ALL', 'CONFIRMED', 'CHALLENGE'] as ListingFilter[]).map(item => <button key={item} type="button" onClick={() => setFilter(item)} className={`min-h-10 rounded-full px-3 py-1 text-xs font-bold ${filter === item ? 'bg-[#0e7c6b] text-white' : 'bg-slate-100 text-slate-700'}`}>{item === 'ALL' ? 'Tất cả' : item === 'CONFIRMED' ? 'Đã xác nhận' : 'Đã khiếu nại'}</button>)}</div>
      {visibleRecords.length ? <div className="mt-4 min-w-0 space-y-4">{visibleRecords.map(record => <article key={record.recordId} className="min-w-0 rounded-2xl border border-slate-200 p-4"><div className="flex min-w-0 flex-wrap items-center gap-2"><h4 className="min-w-0 break-words font-bold text-slate-900">{record.projectName} · Vòng {record.round}</h4><span className={`rounded-full px-2 py-1 text-xs font-bold ${record.kind === 'CONFIRMED' ? 'bg-emerald-50 text-emerald-800' : 'bg-amber-50 text-amber-800'}`}>{record.kind === 'CONFIRMED' ? 'Đã xác nhận đúng sự thật' : ARBITRATION_OUTCOME_LABEL[record.arbitration?.status === 'PENDING' ? 'PENDING' : record.arbitration?.verdict || 'NONE']}</span>{record.arbitration?.isMarkedAbusive && <span className="rounded-full bg-red-50 px-2 py-1 text-xs font-bold text-red-700">Bị đánh dấu khiếu nại lạm dụng</span>}</div><p className="mt-1 text-sm text-slate-500">{new Date(record.submittedAt).toLocaleString('vi-VN')}</p>{record.note && <p className="mt-3 break-words text-sm text-slate-700">{record.note}</p>}{record.reason && <p className="mt-3 break-words whitespace-pre-line text-sm text-slate-700">{record.reason}</p>}{record.arbitration?.status === 'PENDING' && <p className="mt-2 text-sm text-amber-800">Hạn xét xử: {new Date(record.arbitration.deadlineAt).toLocaleString('vi-VN')}</p>}<div className="mt-4"><ChallengeEvidenceGallery photos={record.photos} /></div></article>)}</div> : !errorMessage && <p className="mt-3 text-sm text-slate-600">Bạn chưa xác minh dự án niêm yết nào. Mỗi vòng niêm yết chỉ nộp được một kết luận.</p>}
    </section>
  );
}
