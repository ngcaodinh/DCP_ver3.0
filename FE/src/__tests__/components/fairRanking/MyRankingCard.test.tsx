import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import MyRankingCard from '@/app/components/fairRanking/MyRankingCard';

describe('MyRankingCard', () => {
  it('hien thi rank day du, contribution, fair score va trust badge', () => {
    render(<MyRankingCard ranking={{
      rank: 128,
      originalRank: 111,
      donorAddress: '0xabcd...1234',
      contributionAmount: 1250000,
      trustScore: 0.3,
      trustAdjustedMatch: 612.37,
      tier: 'Bronze',
      trustSource: 'unknown'
    }} />);

    expect(screen.getByText('Xếp hạng của bạn: #128')).toBeInTheDocument();
    expect(screen.getByText(/1\.250\.000₫ đóng góp/)).toBeInTheDocument();
    expect(screen.getByText(/điểm công bằng 612,37/)).toBeInTheDocument();
    expect(screen.getByText('Bronze · 0.3')).toBeInTheDocument();
  });
});
