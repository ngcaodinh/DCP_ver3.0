import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import FeedbackStatusBanner from '@/app/components/feedback/FeedbackStatusBanner';

describe('FeedbackStatusBanner', () => {
  it.each(['success', 'duplicate', 'expired', 'invalid', 'closed', 'ratelimit', 'error'])('renders the whitelisted %s status', (status) => {
    render(<FeedbackStatusBanner projectId="project-001" status={status} />);

    expect(screen.getByRole(status === 'success' ? 'status' : 'alert')).toBeInTheDocument();
  });

  it.each(['<img src=x onerror=alert(1)>', '../../etc'])('ignores an unrecognized status value: %s', (status) => {
    const { container } = render(<FeedbackStatusBanner projectId="project-001" status={status} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('offers a reload link for an expired ticket', () => {
    render(<FeedbackStatusBanner projectId="project-001" status="expired" />);

    expect(screen.getByRole('link', { name: 'Tải lại trang' })).toHaveAttribute('href', '/feedback/project-001');
  });
});
