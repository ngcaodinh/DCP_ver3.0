import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ fetchApi: vi.fn() }));

vi.mock('@/app/utils/apiClient', () => ({
  buildApiUrl: (path: string) => path,
  fetchApi: mocks.fetchApi,
  getApiErrorMessage: (_error: unknown, fallback: string) => fallback
}));
vi.mock('@/app/utils/authSession', () => ({ readAuthSession: () => ({ accessToken: 'governance-token' }) }));

import { ActiveProjectsPanel } from '@/app/components/governance/ActiveProjectsPanel';

const activeProject = {
  projectId: 'project-critical',
  name: 'Dự án vùng xa',
  organizationName: 'Tổ chức minh bạch',
  fieldReportCount: 2,
  pendingDisbursementCount: 1
};

const activeProjectDetail = {
  highestDeviationLevel: 'CRITICAL' as const,
  evidencePhotos: [{
    cid: 'bafy-critical',
    source: 'AUDITOR_FIELD_REPORT',
    deviationLevel: 'CRITICAL' as const,
    distanceMeters: 800,
    accuracyMeters: 10,
    isLowAccuracyOverride: true,
    lowAccuracyReason: 'Thiết bị mất tín hiệu trong nhà.'
  }]
};

describe('ActiveProjectsPanel evidence deviation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchApi.mockImplementation((url: string) => (
      url.includes('/active-projects/project-critical')
        ? Promise.resolve({ data: activeProjectDetail })
        : Promise.resolve({ data: { items: [activeProject], nextCursor: null } })
    ));
  });

  it('đưa cảnh báo CRITICAL vào đầu detail và hiển thị cờ low-accuracy override', async () => {
    render(<ActiveProjectsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: /Dự án vùng xa/i }));

    const detailHeading = await screen.findByText('Chứng cứ hiện trường');
    const detailSection = detailHeading.closest('section');
    expect(detailSection).not.toBeNull();
    expect(within(detailSection as HTMLElement).getAllByText(/Lệch vị trí nghiêm trọng/)).not.toHaveLength(0);
    expect(within(detailSection as HTMLElement).getByText(/Ảnh chụp qua van thoát GPS: Thiết bị mất tín hiệu trong nhà\./)).toBeInTheDocument();
    expect(within(detailSection as HTMLElement).getByText('CID: bafy-critical')).toBeInTheDocument();
  });

  it('gửi access token khi tải danh sách và detail dự án', async () => {
    render(<ActiveProjectsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: /Dự án vùng xa/i }));

    await waitFor(() => expect(mocks.fetchApi).toHaveBeenCalledWith(
      '/api/project-governance/executive/active-projects?limit=20',
      { headers: { Authorization: 'Bearer governance-token' } }
    ));
    await waitFor(() => expect(mocks.fetchApi).toHaveBeenCalledWith(
      '/api/project-governance/executive/active-projects/project-critical',
      { headers: { Authorization: 'Bearer governance-token' } }
    ));
  });
});
