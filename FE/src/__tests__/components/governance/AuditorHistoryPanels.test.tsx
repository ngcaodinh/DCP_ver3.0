import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/app/components/governance/ChallengeEvidenceGallery', () => ({ ChallengeEvidenceGallery: () => <div>Evidence gallery</div> }));

import AuditorFieldReportHistory from '@/app/components/governance/AuditorFieldReportHistory';
import AuditorListingHistory from '@/app/components/governance/AuditorListingHistory';

describe('Auditor history panels', () => {
  it('shows a field-report loading error instead of an empty-history message', async () => {
    const fetchAuditorResource = vi.fn().mockRejectedValueOnce(new Error('network'));

    render(<AuditorFieldReportHistory fetchAuditorResource={fetchAuditorResource} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Không thể tải biên bản đã nộp');
    expect(screen.queryByText(/Bạn chưa nộp biên bản/i)).not.toBeInTheDocument();
  });

  it('shows a listing-history loading error instead of an empty-history message', async () => {
    const fetchAuditorResource = vi.fn().mockRejectedValueOnce(new Error('network'));

    render(<AuditorListingHistory fetchAuditorResource={fetchAuditorResource} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Không thể tải lịch sử xác minh');
    expect(screen.queryByText(/Bạn chưa xác minh dự án/i)).not.toBeInTheDocument();
  });

  it('shows an abusive-challenge marker returned by listing history', async () => {
    const fetchAuditorResource = vi.fn().mockResolvedValueOnce([{
      kind: 'CHALLENGE',
      recordId: 'challenge-1',
      projectId: 'project-1',
      projectName: 'Dự án minh bạch',
      round: 1,
      submittedAt: '2026-08-29T00:00:00.000Z',
      photos: [],
      note: null,
      reason: 'Khiếu nại có căn cứ.',
      arbitration: {
        status: 'RESOLVED',
        verdict: 'UPHOLD_PROJECT',
        deadlineAt: '2026-08-28T00:00:00.000Z',
        resolvedAt: '2026-08-29T00:00:00.000Z',
        isMarkedAbusive: true
      }
    }]);

    render(<AuditorListingHistory fetchAuditorResource={fetchAuditorResource} />);

    expect(await screen.findByRole('heading', { name: /Dự án minh bạch/i })).toBeInTheDocument();
    expect(screen.getByText('Bị đánh dấu khiếu nại lạm dụng')).toBeInTheDocument();
  });
});
