import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import FairRankingTable, { formatRankingDelta } from '@/app/components/fairRanking/FairRankingTable';
import type { FairRankingResponse } from '@/app/types/fairRanking';

const response: FairRankingResponse = {
  rankings: [{
    rank: 3,
    originalRank: 5,
    donorAddress: '0xabcd...1234',
    contributionAmount: 150000,
    trustScore: 0.72,
    trustAdjustedMatch: 328.63,
    tier: 'Gold',
    trustSource: 'computed'
  }],
  myRanking: null,
  scores: { projectTrustAdjustedScore: 328.63, originalQfScore: 400, totalDonors: 1, totalDonationRecords: 1, skippedDonors: 0 },
  trustFactors: { averageTrustScore: 0.72, donorsWithTrustScore: 1, donorsWithFallback: 0, donorsWithUnknownStatus: 0 },
  metadata: { projectId: 'project-1', roundId: 'default', totalItems: 1, totalPages: 1, currentPage: 1, pageSize: 20, cachedAt: null, cacheHit: false, sortBy: 'trustAdjusted' }
};

describe('FairRankingTable', () => {
  it('render nguyen van mask address, delta va badge BE tra ve', () => {
    render(<FairRankingTable response={response} sortBy="trustAdjusted" isLoading={false} isError={false} onRetry={vi.fn()} />);
    expect(screen.getByText('0xabcd...1234')).toBeInTheDocument();
    expect(screen.getByText('↑2')).toBeInTheDocument();
    expect(screen.getByText('Gold · 0.72')).toBeInTheDocument();
    expect(screen.getByText('150.000₫')).toBeInTheDocument();
    expect(screen.getByText('328,63')).toBeInTheDocument();
  });

  it('hien chu thich cho donor bi loai vi vuot nguong an toan', () => {
    render(
      <FairRankingTable
        response={{ ...response, scores: { ...response.scores, skippedDonors: 2 } }}
        sortBy="trustAdjusted"
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
      />
    );

    expect(screen.getByTestId('skipped-donors-notice')).toHaveTextContent(
      '2 nhà hảo tâm bị loại khỏi bảng do giá trị quyên góp vượt ngưỡng an toàn tính toán.'
    );
  });

  it('co skeleton, empty state va error retry', () => {
    const onRetry = vi.fn();
    const { rerender } = render(<FairRankingTable response={undefined} sortBy="original" isLoading isError={false} onRetry={onRetry} />);
    expect(screen.getByLabelText('Đang tải bảng xếp hạng nhà hảo tâm')).toBeInTheDocument();

    rerender(<FairRankingTable response={{ ...response, rankings: [] }} sortBy="original" isLoading={false} isError={false} onRetry={onRetry} />);
    expect(screen.getByText('Chưa có nhà hảo tâm nào trong 30 ngày gần nhất.')).toBeInTheDocument();

    rerender(<FairRankingTable response={undefined} sortBy="original" isLoading={false} isError onRetry={onRetry} />);
    screen.getByRole('button', { name: 'Thử lại' }).click();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('format delta dung cho tang giam va khong doi', () => {
    expect(formatRankingDelta({ ...response.rankings[0], rank: 3, originalRank: 5 })).toBe('↑2');
    expect(formatRankingDelta({ ...response.rankings[0], rank: 5, originalRank: 3 })).toBe('↓2');
    expect(formatRankingDelta({ ...response.rankings[0], rank: 3, originalRank: 3 })).toBe('—');
  });
});
