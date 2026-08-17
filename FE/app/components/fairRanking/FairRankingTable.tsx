'use client';

import type { ReactElement } from 'react';
import type { FairRankingEntry, FairRankingResponse, FairRankingSortBy } from '@/app/types/fairRanking';
import TrustScoreBadge from './TrustScoreBadge';

interface FairRankingTableProps {
  response: FairRankingResponse | undefined;
  sortBy: FairRankingSortBy;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
}

/** Format số tiền VND theo locale hiện có của sản phẩm. */
function formatContributionAmount(amount: number): string {
  return `${new Intl.NumberFormat('vi-VN').format(amount)}₫`;
}

/** Tính delta thứ hạng từ hai rank BE đã trả về, không tự suy diễn rank ở FE. */
export function formatRankingDelta(entry: FairRankingEntry): string {
  const delta = entry.originalRank - entry.rank;
  if (delta > 0) return `↑${delta}`;
  if (delta < 0) return `↓${Math.abs(delta)}`;
  return '—';
}

/** Bảng donor ranking có loading, empty, error, responsive overflow và trust badge. */
export function FairRankingTable({
  response,
  sortBy,
  isLoading,
  isError,
  onRetry
}: FairRankingTableProps): ReactElement {
  if (isLoading && !response) {
    return <FairRankingTableSkeleton />;
  }

  if (isError && !response) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-8 text-center text-sm text-red-700" role="alert">
        <p>Không thể tải bảng xếp hạng nhà hảo tâm.</p>
        <button
          type="button"
          className="mt-3 rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-semibold hover:bg-red-100"
          onClick={onRetry}
        >
          Thử lại
        </button>
      </div>
    );
  }

  const rankings = response?.rankings ?? [];
  const skippedDonorsNotice = response && response.scores.skippedDonors > 0
    ? (
      <p className="mt-2 text-xs text-slate-500" data-testid="skipped-donors-notice">
        {response.scores.skippedDonors} nhà hảo tâm bị loại khỏi bảng do giá trị quyên góp vượt ngưỡng an toàn tính toán.
      </p>
    )
    : null;

  if (rankings.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-slate-300 bg-white p-10 text-center text-sm text-slate-500">
        Chưa có nhà hảo tâm nào trong 30 ngày gần nhất.
        {skippedDonorsNotice}
      </div>
    );
  }

  return (
    <>
      <div className="rank-table-wrapper overflow-x-auto">
        <table className="rank-table min-w-[760px]">
          <caption className="sr-only">
            {sortBy === 'original' ? 'Bảng xếp hạng QF gốc của nhà hảo tâm' : 'Bảng xếp hạng công bằng của nhà hảo tâm'}
          </caption>
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">Nhà hảo tâm</th>
              <th scope="col">Δ hạng</th>
              <th scope="col">QF gốc</th>
              <th scope="col">Điểm công bằng</th>
              <th scope="col">Trust</th>
            </tr>
          </thead>
          <tbody>
            {rankings.map(entry => (
              <tr key={`${entry.donorAddress}-${entry.rank}`}>
                <td className="rank-number">{entry.rank}</td>
                <td>
                  <span className="font-mono whitespace-nowrap text-xs">{entry.donorAddress}</span>
                </td>
                <td>
                  <span aria-label={`Chênh lệch thứ hạng ${formatRankingDelta(entry)}`} className="font-mono text-xs font-semibold">
                    {formatRankingDelta(entry)}
                  </span>
                </td>
                <td className={sortBy === 'original' ? 'font-semibold' : undefined}>{formatContributionAmount(entry.contributionAmount)}</td>
                <td className={sortBy === 'trustAdjusted' ? 'font-semibold' : undefined}>{entry.trustAdjustedMatch.toLocaleString('vi-VN')}</td>
                <td>
                  <TrustScoreBadge trustScore={entry.trustScore} tier={entry.tier} trustSource={entry.trustSource} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {skippedDonorsNotice}
    </>
  );
}

/** Hiển thị skeleton có chiều cao ổn định trong lúc ranking đang tải. */
function FairRankingTableSkeleton(): ReactElement {
  return (
    <div aria-label="Đang tải bảng xếp hạng nhà hảo tâm" className="space-y-2 rounded-lg border border-slate-200 bg-white p-4">
      {Array.from({ length: 5 }, (_, index) => <div key={index} className="h-12 animate-pulse rounded bg-slate-100" />)}
    </div>
  );
}

export default FairRankingTable;
