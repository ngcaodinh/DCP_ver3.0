import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import FairRankingTab from '@/app/components/fairRanking/FairRankingTab';
import type { FairRankingResponse } from '@/app/types/fairRanking';

const mocks = vi.hoisted(() => ({ useFairRanking: vi.fn() }));

vi.mock('@/app/hooks/useFairRanking', () => ({
  useFairRanking: mocks.useFairRanking
}));

const originalResponse: FairRankingResponse = {
  rankings: [],
  myRanking: { rank: 128, originalRank: 100, donorAddress: '0xabcd...1234', contributionAmount: 100, trustScore: 0.3, trustAdjustedMatch: 5.47, tier: 'Bronze', trustSource: 'unknown' },
  scores: { projectTrustAdjustedScore: 10, originalQfScore: 20, totalDonors: 128, totalDonationRecords: 128, skippedDonors: 0 },
  trustFactors: { averageTrustScore: 0.3, donorsWithTrustScore: 1, donorsWithFallback: 0, donorsWithUnknownStatus: 127 },
  metadata: { projectId: 'p1', roundId: 'default', totalItems: 0, totalPages: 1, currentPage: 1, pageSize: 20, cachedAt: null, cacheHit: false, sortBy: 'original' }
};

const fairResponse: FairRankingResponse = {
  ...originalResponse,
  trustFactors: { ...originalResponse.trustFactors, donorsWithTrustScore: 0, donorsWithFallback: 128, donorsWithUnknownStatus: 0 },
  metadata: { ...originalResponse.metadata, sortBy: 'trustAdjusted' }
};

describe('FairRankingTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useFairRanking.mockImplementation(({ sortBy, enabled }: { sortBy: 'original' | 'trustAdjusted'; enabled: boolean }) => ({
      data: enabled ? (sortBy === 'original' ? originalResponse : fairResponse) : undefined,
      isLoading: false,
      isError: false,
      refetch: vi.fn()
    }));
  });

  it('mac dinh QF goc, khong fetch tab fair cho den khi toggle', () => {
    render(<FairRankingTab projects={[{ projectId: 'p1', projectName: 'Project 1' }]} />);
    expect(screen.getByRole('tab', { name: 'QF gốc' })).toHaveAttribute('aria-selected', 'true');
    expect(mocks.useFairRanking).toHaveBeenCalledWith(expect.objectContaining({ sortBy: 'trustAdjusted', enabled: false }));
    expect(mocks.useFairRanking).toHaveBeenCalledWith(expect.objectContaining({ sortBy: 'original', enabled: true }));

    fireEvent.click(screen.getByRole('tab', { name: 'Danh sách công bằng' }));
    expect(mocks.useFairRanking).toHaveBeenLastCalledWith(expect.objectContaining({ sortBy: 'trustAdjusted', enabled: true, page: 1 }));
  });

  it('hien banner fallback va myRanking khi donor ngoai top 50', () => {
    render(<FairRankingTab projects={[{ projectId: 'p1', projectName: 'Project 1' }]} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Danh sách công bằng' }));
    expect(screen.getByRole('status')).toHaveTextContent('điểm mặc định 0.5');
    expect(screen.getByText('Xếp hạng của bạn: #128')).toBeInTheDocument();
  });

  it('hien banner khi tat ca record trust deu la unknown', () => {
    mocks.useFairRanking.mockImplementation(({ enabled }: { enabled: boolean }) => ({
      data: enabled ? {
        ...originalResponse,
        trustFactors: { averageTrustScore: 0.3, donorsWithTrustScore: 128, donorsWithFallback: 0, donorsWithUnknownStatus: 128 }
      } : undefined,
      isLoading: false,
      isError: false,
      refetch: vi.fn()
    }));

    render(<FairRankingTab projects={[{ projectId: 'p1', projectName: 'Project 1' }]} />);
    expect(screen.getByRole('status')).toHaveTextContent('điểm mặc định 0.5');
  });

  it('thuc su doi opacity khi chuyen tab va giu transition giam chuyen dong', () => {
    vi.useFakeTimers();
    try {
      render(<FairRankingTab projects={[{ projectId: 'p1', projectName: 'Project 1' }]} />);
      const panel = screen.getByRole('tabpanel');
      expect(panel).toHaveClass('transition-opacity', 'motion-reduce:transition-none', 'opacity-100');

      fireEvent.click(screen.getByRole('tab', { name: 'Danh sách công bằng' }));
      expect(panel).toHaveClass('opacity-0');

      act(() => {
        vi.runAllTimers();
      });
      expect(panel).toHaveClass('opacity-100');
    } finally {
      vi.useRealTimers();
    }
  });

  it('khong render gi khi khong co project', () => {
    const { container } = render(<FairRankingTab projects={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('doi project reset pagination ve trang 1 va an card neu rank nam trong top 50', () => {
    mocks.useFairRanking.mockImplementation(({ sortBy, enabled }: { sortBy: 'original' | 'trustAdjusted'; enabled: boolean }) => ({
      data: enabled ? {
        ...(sortBy === 'original' ? originalResponse : fairResponse),
        myRanking: { ...(originalResponse.myRanking as NonNullable<FairRankingResponse['myRanking']>), rank: 12 },
        metadata: { ...(sortBy === 'original' ? originalResponse.metadata : fairResponse.metadata), totalPages: 3 }
      } : undefined,
      isLoading: false,
      isError: false,
      refetch: vi.fn()
    }));
    render(<FairRankingTab projects={[{ projectId: 'p1', projectName: 'Project 1' }, { projectId: 'p2', projectName: 'Project 2' }]} />);

    fireEvent.click(screen.getByRole('button', { name: 'Sau' }));
    expect(mocks.useFairRanking).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Chọn dự án' }), { target: { value: 'p2' } });
    expect(mocks.useFairRanking).toHaveBeenLastCalledWith(expect.objectContaining({ projectId: 'p2', page: 1 }));
    expect(screen.queryByRole('complementary', { name: 'Xếp hạng của bạn' })).not.toBeInTheDocument();
  });

  it('tu reset ve trang 1 khi polling lam tong so trang giam', () => {
    mocks.useFairRanking.mockImplementation(({ page, sortBy, enabled }: { page: number; sortBy: 'original' | 'trustAdjusted'; enabled: boolean }) => ({
      data: enabled ? {
        ...(sortBy === 'original' ? originalResponse : fairResponse),
        metadata: { ...(sortBy === 'original' ? originalResponse.metadata : fairResponse.metadata), totalPages: page === 1 ? 2 : 1 }
      } : undefined,
      isLoading: false,
      isError: false,
      refetch: vi.fn()
    }));
    render(<FairRankingTab projects={[{ projectId: 'p1', projectName: 'Project 1' }]} />);

    fireEvent.click(screen.getByRole('button', { name: 'Sau' }));
    expect(mocks.useFairRanking).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1 }));
  });
});
