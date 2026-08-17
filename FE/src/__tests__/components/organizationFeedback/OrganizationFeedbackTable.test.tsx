import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { OrganizationFeedbackTable } from '@/app/components/organizationFeedback/OrganizationFeedbackTable';
import type { OrganizationFeedbackItem } from '@/app/components/organizationFeedback/types';

describe('OrganizationFeedbackTable', () => {
  it('hiển thị hai trạng thái và không render field nội bộ kể cả khi payload có thêm key', () => {
    const items: OrganizationFeedbackItem[] = [
      {
        feedbackId: 'FB-1', projectId: 'DA-1', projectName: 'Dự án 1', rating: 5, comment: 'Hiển thị',
        submittedAt: '2026-08-01T00:00:00Z', source: 'batch', isFlagged: false
      },
      {
        feedbackId: 'FB-2', projectId: 'DA-2', projectName: null, rating: 2, comment: 'Chờ duyệt',
        submittedAt: '2026-08-01T00:00:00Z', source: 'public', isFlagged: true
      }
    ];

    render(<OrganizationFeedbackTable items={items} />);

    expect(screen.getByText('Đang hiển thị')).toBeInTheDocument();
    expect(screen.getByText('Đang chờ duyệt')).toBeInTheDocument();
    expect(screen.queryByText('riskScore')).not.toBeInTheDocument();
    expect(screen.queryByText('beneficiaryNameHash')).not.toBeInTheDocument();
    expect(screen.getByRole('table')).toHaveTextContent('Dự án 1');
  });
});
