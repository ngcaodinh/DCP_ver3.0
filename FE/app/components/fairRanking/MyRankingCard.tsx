'use client';

import type { ReactElement } from 'react';
import type { FairRankingEntry } from '@/app/types/fairRanking';
import TrustScoreBadge from './TrustScoreBadge';

interface MyRankingCardProps {
  ranking: FairRankingEntry;
}

/** Hiển thị thứ hạng đầy đủ của ví hiện tại khi donor nằm ngoài top 50. */
export function MyRankingCard({ ranking }: MyRankingCardProps): ReactElement {
  return (
    <aside className="mt-5 rounded-lg border border-[#b9e5de] bg-[#f2fbf9] p-4" aria-label="Xếp hạng của bạn">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-[#0a5c50]">Xếp hạng của bạn: #{ranking.rank}</p>
          <p className="mt-1 text-xs text-slate-600">{ranking.contributionAmount.toLocaleString('vi-VN')}₫ đóng góp · điểm công bằng {ranking.trustAdjustedMatch.toLocaleString('vi-VN')}</p>
        </div>
        <TrustScoreBadge trustScore={ranking.trustScore} tier={ranking.tier} trustSource={ranking.trustSource} />
      </div>
    </aside>
  );
}

export default MyRankingCard;
