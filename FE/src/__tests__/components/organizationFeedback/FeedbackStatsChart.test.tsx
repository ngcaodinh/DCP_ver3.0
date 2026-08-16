import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FeedbackStatsChart } from '@/app/components/organizationFeedback/FeedbackStatsChart';

describe('FeedbackStatsChart', () => {
  it('hiển thị empty state khi chưa có feedback mà không phát NaN', () => {
    render(<FeedbackStatsChart stats={{ totalCount: 0, visibleCount: 0, pendingCount: 0, avgRating: null, distribution: {} }} />);

    expect(screen.getByText('Chưa có dữ liệu thống kê.')).toBeInTheDocument();
    expect(screen.getByText('Điểm trung bình:')).toBeInTheDocument();
    expect(screen.queryByText(/NaN/)).not.toBeInTheDocument();
  });

  it('hiển thị đủ năm thanh rating và aria label chứa số lượng', () => {
    render(<FeedbackStatsChart stats={{
      totalCount: 10,
      visibleCount: 8,
      pendingCount: 2,
      avgRating: 4.32,
      distribution: { '1': 1, '2': 1, '3': 1, '4': 2, '5': 5 }
    }} />);

    expect(screen.getByText('4.32★')).toBeInTheDocument();
    expect(screen.getByLabelText('5 sao: 5 phản hồi')).toBeInTheDocument();
    expect(screen.getByLabelText('1 sao: 1 phản hồi')).toBeInTheDocument();
  });
});
