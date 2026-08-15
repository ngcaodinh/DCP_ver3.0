import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import FeedbackForm from '@/app/components/feedback/FeedbackForm';

describe('FeedbackForm', () => {
  it('posts directly to the backend with ticket and progressive-enhancement fields', () => {
    const { container } = render(<FeedbackForm projectId="project-001" submissionTicket="ticket-001" />);
    const form = container.querySelector('form');

    expect(form).toHaveAttribute('method', 'POST');
    expect(form).toHaveAttribute('action', 'http://localhost:3000/api/feedback/single');
    expect(container.querySelector('input[name="submissionTicket"]')).toHaveValue('ticket-001');
    expect(container.querySelector('input[name="projectId"]')).toHaveValue('project-001');
    expect(container.querySelector('input[name="redirect"]')).toHaveValue('1');
    expect(screen.getByRole('textbox', { name: /nhận xét/i })).toHaveAttribute('maxLength', '1000');
  });

  it('keeps the honeypot out of the visual and keyboard flow', () => {
    const { container } = render(<FeedbackForm projectId="project-001" submissionTicket="ticket-001" />);
    const honeypot = container.querySelector('input[name="contactEmail"]');

    expect(honeypot).toHaveAttribute('tabindex', '-1');
    expect(honeypot).toHaveAttribute('autocomplete', 'off');
    expect(honeypot).toHaveStyle({ position: 'absolute', left: '-9999px' });
    expect(honeypot).not.toHaveStyle({ display: 'none' });
  });
});
