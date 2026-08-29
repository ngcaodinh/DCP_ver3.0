import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const { mockFetchApi } = vi.hoisted(() => ({ mockFetchApi: vi.fn() }));
vi.mock('@/app/utils/apiClient', () => ({ buildApiUrl: (path: string) => path, fetchApi: mockFetchApi }));

import PendingProjectsClient from '@/app/components/governance/PendingProjectsClient';

/** Tạo một project niêm yết để kiểm tra badge không biến thành hành động quyên góp. */
function response(activeAuditorCount: number, status: 'PENDING_ACTIVATION' | 'DISPUTED') {
  return { data: { activeAuditorCount, projects: [{ projectId: 'project-1', name: 'Cầu dân sinh', description: 'Mô tả công khai', goalAmount: 1000000, status, activationEligibleAt: status === 'DISPUTED' ? null : new Date(Date.now() + 31 * 60 * 60 * 1000).toISOString(), milestonePlan: [{ milestoneKey: 'M1_ADVANCE', percentage: 25, description: 'Chuẩn bị hạng mục' }] }] } };
}

describe('PendingProjectsClient', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shows a red supervision warning when there are no active auditors', async () => {
    mockFetchApi.mockResolvedValue(response(0, 'PENDING_ACTIVATION'));
    render(<PendingProjectsClient />);
    await waitFor(() => expect(screen.getByText(/chưa có Kiểm toán viên hoạt động/i)).toBeInTheDocument());
    expect(screen.getByText(/Còn 31 giờ/i)).toBeInTheDocument();
  });

  it('replaces the countdown by the disputed badge', async () => {
    mockFetchApi.mockResolvedValue(response(3, 'DISPUTED'));
    render(<PendingProjectsClient />);
    await waitFor(() => expect(screen.getByText('Đang tranh chấp')).toBeInTheDocument());
    expect(screen.queryByText(/Còn 31 giờ/i)).not.toBeInTheDocument();
  });
});
