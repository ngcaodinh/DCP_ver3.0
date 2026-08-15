import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import FeedbackStatsSummary from '@/app/components/feedback/FeedbackStatsSummary';

describe('FeedbackStatsSummary', () => {
  it('renders the F3 summary when the average and count are valid', () => {
    render(<FeedbackStatsSummary stats={{ avgRating: 4.6, totalCount: 87 }} />);

    expect(screen.getByText('4.6★ · 87 phản hồi')).toBeInTheDocument();
  });

  it.each([
    [null],
    [{ avgRating: null, totalCount: 0 }],
    [{ avgRating: 4.6, totalCount: 0 }],
    [{ avgRating: Number.NaN, totalCount: 3 }],
    [{ avgRating: 0, totalCount: 3 }],
    [{ avgRating: 6, totalCount: 3 }]
  ])('does not render a misleading summary for %s', (stats) => {
    render(<FeedbackStatsSummary stats={stats as never} />);

    expect(screen.queryByText(/phản hồi/)).not.toBeInTheDocument();
  });
});
