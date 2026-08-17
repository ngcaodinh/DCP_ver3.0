'use client';

import { useEffect, useRef, useState, type ChangeEvent, type ReactElement } from 'react';
import { MY_RANKING_VISIBLE_THRESHOLD, TRUST_SCORE_FALLBACK_VALUE } from '@/app/constants/fairRanking';
import type { FairRankingProject, FairRankingSortBy } from '@/app/types/fairRanking';
import { useFairRanking } from '@/app/hooks/useFairRanking';
import FairRankingTable from './FairRankingTable';
import MyRankingCard from './MyRankingCard';

interface FairRankingTabProps {
  projects: FairRankingProject[];
}

type FairRankingTabKey = 'original' | 'fair';

/** Khối ranking donor độc lập với bảng ranking dự án hiện có trên homepage. */
export function FairRankingTab({ projects }: FairRankingTabProps): ReactElement | null {
  const [selectedProjectId, setSelectedProjectId] = useState(projects[0]?.projectId ?? '');
  const [activeTab, setActiveTab] = useState<FairRankingTabKey>('original');
  const [page, setPage] = useState(1);
  const [isFading, setIsFading] = useState(false);
  const fadeResetTimerRef = useRef<number | null>(null);

  /** Giữ project đã chọn hợp lệ khi snapshot phía trên thay đổi sau polling. */
  useEffect(() => {
    if (projects.length === 0) return;
    if (!projects.some(project => project.projectId === selectedProjectId)) {
      setSelectedProjectId(projects[0].projectId);
      setPage(1);
    }
  }, [projects, selectedProjectId]);

  const originalQuery = useFairRanking({
    projectId: selectedProjectId,
    sortBy: 'original',
    page,
    enabled: activeTab === 'original'
  });
  const fairQuery = useFairRanking({
    projectId: selectedProjectId,
    sortBy: 'trustAdjusted',
    page,
    enabled: activeTab === 'fair'
  });

  const activeSortBy: FairRankingSortBy = activeTab === 'fair' ? 'trustAdjusted' : 'original';
  const activeQuery = activeTab === 'fair' ? fairQuery : originalQuery;
  const response = activeQuery.data;
  const totalPages = Math.max(1, response?.metadata.totalPages ?? 1);

  /** Tự quay về trang đầu khi polling làm tổng số trang nhỏ hơn trang hiện tại. */
  useEffect(() => {
    const responseTotalPages = response?.metadata.totalPages ?? 0;
    if (responseTotalPages > 0 && page > responseTotalPages) {
      setPage(1);
    }
  }, [page, response]);

  /** Hủy timer animation khi component bị tháo để không cập nhật state ngoài vòng đời. */
  useEffect(() => () => {
    if (fadeResetTimerRef.current !== null) {
      window.clearTimeout(fadeResetTimerRef.current);
    }
  }, []);

  if (projects.length === 0) {
    return null;
  }

  const shouldShowBanner = Boolean(
    response
    && response.scores.totalDonors > 0
    && response.trustFactors.donorsWithTrustScore - response.trustFactors.donorsWithUnknownStatus === 0
  );

  /** Đổi project và quay về trang đầu để không giữ page vượt quá tổng trang mới. */
  const handleProjectChange = (event: ChangeEvent<HTMLSelectElement>): void => {
    setSelectedProjectId(event.target.value);
    setPage(1);
  };

  /** Đổi tab sort và reset pagination theo tập dữ liệu active. */
  const handleTabChange = (nextTab: FairRankingTabKey): void => {
    if (fadeResetTimerRef.current !== null) {
      window.clearTimeout(fadeResetTimerRef.current);
    }
    setIsFading(true);
    setActiveTab(nextTab);
    setPage(1);
    fadeResetTimerRef.current = window.setTimeout(() => {
      setIsFading(false);
      fadeResetTimerRef.current = null;
    }, 0);
  };

  return (
    <div className="mt-10 rounded-xl border border-slate-200 bg-white/80 p-4 shadow-sm sm:p-6" data-testid="fair-ranking-tab">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="section-label">Trust-weighted QF</div>
          <h3 className="section-title text-xl">Xếp hạng nhà hảo tâm — trust-weighted</h3>
          <p className="section-sub">Dữ liệu 30 ngày gần nhất</p>
        </div>
        <label className="flex min-w-0 flex-col gap-1 text-xs font-semibold text-slate-600">
          Chọn dự án
          <select
            className="min-w-[220px] rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-normal text-slate-800 outline-none focus:border-[#0e7c6b] focus:ring-2 focus:ring-[#b9e5de]"
            value={selectedProjectId}
            onChange={handleProjectChange}
          >
            {projects.map(project => <option key={project.projectId} value={project.projectId}>{project.projectName}</option>)}
          </select>
        </label>
      </div>

      <div className="mt-5 border-b border-slate-200" role="tablist" aria-label="Kiểu xếp hạng nhà hảo tâm">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'original'}
          aria-controls="fair-ranking-panel"
          className={`mr-4 border-b-2 px-1 pb-2 text-sm font-semibold transition-colors ${activeTab === 'original' ? 'border-[#0e7c6b] text-[#0a5c50]' : 'border-transparent text-slate-500 hover:text-slate-800'}`}
          onClick={() => handleTabChange('original')}
        >
          QF gốc
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'fair'}
          aria-controls="fair-ranking-panel"
          className={`border-b-2 px-1 pb-2 text-sm font-semibold transition-colors ${activeTab === 'fair' ? 'border-[#0e7c6b] text-[#0a5c50]' : 'border-transparent text-slate-500 hover:text-slate-800'}`}
          onClick={() => handleTabChange('fair')}
        >
          Danh sách công bằng
        </button>
      </div>

      <div
        id="fair-ranking-panel"
        role="tabpanel"
        className={`min-h-[360px] pt-4 transition-opacity duration-200 motion-reduce:transition-none ${isFading ? 'opacity-0' : 'opacity-100'}`}
      >
        {shouldShowBanner && (
          <div className="mb-4 rounded-lg border border-[#b9e5de] bg-[#f2fbf9] p-3 text-sm text-[#0a5c50]" role="status">
            Hệ thống điểm tin cậy đang được kích hoạt. Toàn bộ nhà hảo tâm tạm dùng điểm mặc định {TRUST_SCORE_FALLBACK_VALUE}, thứ hạng công bằng hiện trùng với QF gốc.
          </div>
        )}
        <FairRankingTable
          response={response}
          sortBy={activeSortBy}
          isLoading={activeQuery.isLoading}
          isError={activeQuery.isError}
          onRetry={() => void activeQuery.refetch()}
        />
        {response?.myRanking && response.myRanking.rank > MY_RANKING_VISIBLE_THRESHOLD && <MyRankingCard ranking={response.myRanking} />}

        {response && totalPages > 1 && (
          <nav className="mt-4 flex items-center justify-between gap-3 text-xs text-slate-600" aria-label="Phân trang ranking nhà hảo tâm">
            <button
              type="button"
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 font-semibold hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
              disabled={page <= 1}
              onClick={() => setPage(currentPage => Math.max(1, currentPage - 1))}
            >
              Trước
            </button>
            <span>Trang {page} / {totalPages}</span>
            <button
              type="button"
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 font-semibold hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
              disabled={page >= totalPages}
              onClick={() => setPage(currentPage => Math.min(totalPages, currentPage + 1))}
            >
              Sau
            </button>
          </nav>
        )}
      </div>
    </div>
  );
}

export default FairRankingTab;
