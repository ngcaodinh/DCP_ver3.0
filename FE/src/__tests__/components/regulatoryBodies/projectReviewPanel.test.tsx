import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const { mockFetchApi, mockReadAuthSession } = vi.hoisted(() => ({
  mockFetchApi: vi.fn(),
  mockReadAuthSession: vi.fn()
}));

vi.mock('@/app/utils/apiClient', () => ({
  buildApiUrl: vi.fn((pathname: string) => `http://api.test${pathname}`),
  fetchApi: mockFetchApi
}));

vi.mock('@/app/utils/authSession', () => ({
  readAuthSession: mockReadAuthSession
}));

vi.mock('@/app/components/common/IpfsEvidencePreviewCard', () => ({
  default: ({ fileName, mimeType }: { fileName: string; mimeType?: string }) => (
    <div>{`${fileName} ${mimeType || ''}`}</div>
  )
}));

vi.mock('@/app/components/oracle/GeofenceMapLazy', () => ({
  GeofenceMapLazy: ({ projectId }: { projectId: string }) => (
    <div data-testid="review-geofence-map" data-project-id={projectId} />
  )
}));

vi.mock('@/app/components/regulatoryBodies/tailwind/SybilManagementPanel', () => ({
  default: () => <div>Sybil panel</div>
}));

vi.mock('@/app/components/regulatoryBodies/tailwind/FoundationKycApprovalPanel', () => ({
  default: () => <div>Foundation KYC panel</div>
}));

import NonDashboardPanel from '@/app/components/regulatoryBodies/tailwind/NonDashboardPanel';

const mockPushToast = vi.fn();

/** Tạo response dự án chờ duyệt có metadata IPFS để kiểm tra preview không phải suy đoán loại file. */
function createPendingProjectResponse(status: "PENDING_APPROVAL" | "PENDING_ACTIVATION" | "DISPUTED" | "ACTIVE" | "REJECTED" = "PENDING_APPROVAL"): { data: unknown[] } {
  return {
    data: [
      {
        projectId: '202608180000000001',
        organizationId: 'organization-1',
        name: 'Hỗ trợ vùng lũ',
        description: 'Cung cấp nhu yếu phẩm cho người dân vùng lũ.',
        goalAmount: 50_000_000,
        deadline: '2026-12-31T00:00:00.000Z',
        submittedAt: '2026-08-18T00:00:00.000Z',
        status,
        reviewedAt: status === 'PENDING_APPROVAL' ? null : '2026-08-18T01:00:00.000Z',
        reviewedBy: status === 'PENDING_APPROVAL' ? null : 'regulatory-1',
        rejectionReason: status === 'REJECTED' ? 'Không đáp ứng tiêu chí hỗ trợ.' : null,
        milestonePlan: [
          { milestoneIndex: 1, milestoneKey: 'M1_ADVANCE', percentage: 20, description: 'Tạm ứng để chuẩn bị mặt bằng và vật tư.' },
          { milestoneIndex: 2, milestoneKey: 'M2_CONSTRUCTION', percentage: 50, description: 'Thi công các hạng mục chính theo hồ sơ dự án.' },
          { milestoneIndex: 3, milestoneKey: 'M3_HANDOVER', percentage: 30, description: 'Nghiệm thu và bàn giao công trình cho cộng đồng.' }
        ],
        evidenceCids: ['Qm12345678901234567890123456789012345678901234'],
        evidenceFiles: [
          {
            cid: 'Qm12345678901234567890123456789012345678901234',
            fileName: 'evidence.jpg',
            mimeType: 'image/jpeg'
          }
        ]
      }
    ]
  };
}

describe('Regulatory project review panel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadAuthSession.mockReturnValue({ accessToken: 'regulatory-token' });
    let isApproved = false;
    mockFetchApi.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        isApproved = true;
        return Promise.resolve({ data: {} });
      }

      return Promise.resolve(createPendingProjectResponse(isApproved ? 'ACTIVE' : 'PENDING_APPROVAL'));
    });
  });

  it('approves a pending project with the verified review payload', async () => {
    render(<NonDashboardPanel selectedPageKey="projectReview" onPushToast={mockPushToast} />);

    await screen.findAllByText('Hỗ trợ vùng lũ');
    expect(screen.getByText('evidence.jpg image/jpeg')).toBeInTheDocument();
    expect(screen.getByTestId('project-review-milestone-plan')).toBeInTheDocument();
    expect(screen.getByTestId('project-review-milestone-1')).toHaveTextContent('20%');
    expect(screen.getByTestId('project-review-milestone-2')).toHaveTextContent('Thi công');
    expect(screen.getByTestId('project-review-milestone-3')).toHaveTextContent('Nghiệm thu và bàn giao');
    expect(screen.getByTestId('project-review-milestone-plan')).toHaveTextContent('100%');
    expect(screen.getByTestId('project-review-geofence')).toBeInTheDocument();
    expect(screen.getByTestId('review-geofence-map')).toHaveAttribute('data-project-id', '202608180000000001');

    fireEvent.click(screen.getByRole('button', { name: 'Chấp nhận' }));
    fireEvent.click(screen.getByRole('button', { name: 'Chắc chắn' }));

    await waitFor(() => expect(mockFetchApi).toHaveBeenCalledWith(
      'http://api.test/projects/review',
      expect.objectContaining({
        method: 'POST',
        headers: { Authorization: 'Bearer regulatory-token' },
        body: JSON.stringify({
          projectId: '202608180000000001',
          action: 'APPROVE',
          rejectionReason: undefined
        })
      })
    ));
    await waitFor(() => expect(mockPushToast).toHaveBeenCalledWith(
      'Duyệt dự án thành công',
      expect.stringMatching(/Đã niêm yết công khai/i),
      'success'
    ));
    expect(screen.queryByText(/Đã niêm yết công khai/i)).not.toBeInTheDocument();
  });

  it('shows approved and rejected projects while hiding review actions for processed items', async () => {
    mockFetchApi.mockImplementation(() => Promise.resolve({
      data: [
        {
          ...createPendingProjectResponse('ACTIVE').data[0] as Record<string, unknown>,
          name: 'Approved project'
        },
        {
          ...createPendingProjectResponse('REJECTED').data[0] as Record<string, unknown>,
          projectId: '202608180000000002',
          name: 'Rejected project',
          rejectionReason: 'Không đáp ứng tiêu chí hỗ trợ.'
        }
      ]
    }));

    render(<NonDashboardPanel selectedPageKey="projectReview" />);

    expect((await screen.findAllByText('Approved project')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Đã chấp nhận').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Chấp nhận' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Từ chối' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Rejected project/i }));

    expect(await screen.findByText('Không đáp ứng tiêu chí hỗ trợ.')).toBeInTheDocument();
    expect(screen.getAllByText('Đã từ chối').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Chấp nhận' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Từ chối' })).not.toBeInTheDocument();
  });

  it('orders pending projects first, rejected projects next, and accepted projects last', async () => {
    const activeProject = {
      ...createPendingProjectResponse('ACTIVE').data[0] as Record<string, unknown>,
      projectId: '202608180000000003',
      name: 'Accepted project'
    };
    const rejectedProject = {
      ...createPendingProjectResponse('REJECTED').data[0] as Record<string, unknown>,
      projectId: '202608180000000002',
      name: 'Rejected project'
    };
    const pendingProject = {
      ...createPendingProjectResponse('PENDING_APPROVAL').data[0] as Record<string, unknown>,
      projectId: '202608180000000001',
      name: 'Pending project'
    };
    const listingProject = {
      ...createPendingProjectResponse('PENDING_ACTIVATION').data[0] as Record<string, unknown>,
      projectId: '202608180000000004',
      name: 'Listing project'
    };
    const disputedProject = {
      ...createPendingProjectResponse('DISPUTED').data[0] as Record<string, unknown>,
      projectId: '202608180000000005',
      name: 'Disputed project'
    };

    mockFetchApi.mockResolvedValue({ data: [activeProject, rejectedProject, disputedProject, pendingProject, listingProject] });

    render(<NonDashboardPanel selectedPageKey="projectReview" />);

    await screen.findByTestId('project-review-list-item-202608180000000001');

    const orderedProjectItems = screen
      .getAllByTestId(/project-review-list-item-/)
      .map((item) => item.textContent || '');

    expect(orderedProjectItems).toEqual([
      expect.stringContaining('Pending project'),
      expect.stringContaining('Listing project'),
      expect.stringContaining('Disputed project'),
      expect.stringContaining('Rejected project'),
      expect.stringContaining('Accepted project')
    ]);
  });

  it('emits an error toast when on-chain approval cannot complete', async () => {
    mockFetchApi.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return Promise.reject({ message: 'Không thể kích hoạt dự án trên blockchain. Vui lòng thử lại sau.' });
      }

      return Promise.resolve(createPendingProjectResponse());
    });

    render(<NonDashboardPanel selectedPageKey="projectReview" onPushToast={mockPushToast} />);

    await screen.findAllByText('Hỗ trợ vùng lũ');
    fireEvent.click(screen.getByRole('button', { name: 'Chấp nhận' }));
    fireEvent.click(screen.getByRole('button', { name: 'Chắc chắn' }));

    await waitFor(() => expect(mockPushToast).toHaveBeenCalledWith(
      'Không thể cập nhật kết quả duyệt',
      'Không thể kích hoạt dự án trên blockchain. Vui lòng thử lại sau.',
      'error'
    ));
    expect(screen.queryByText('Không thể kích hoạt dự án trên blockchain. Vui lòng thử lại sau.')).not.toBeInTheDocument();
  });

  it('shows a clear fallback when the project has no valid milestone plan', async () => {
    const projectWithoutMilestones = createPendingProjectResponse().data[0] as Record<string, unknown>;
    delete projectWithoutMilestones.milestonePlan;
    mockFetchApi.mockResolvedValue({ data: [projectWithoutMilestones] });

    render(<NonDashboardPanel selectedPageKey="projectReview" onPushToast={mockPushToast} />);

    await screen.findAllByText('Hỗ trợ vùng lũ');
    expect(screen.getByTestId('project-review-milestone-plan-empty')).toBeInTheDocument();
  });

  it('shows the no-auditor warning returned by regulatory approval', async () => {
    let isApproved = false;
    mockFetchApi.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') { isApproved = true; return Promise.resolve({ data: { warning: 'NO_ACTIVE_AUDITOR' } }); }
      return Promise.resolve(createPendingProjectResponse(isApproved ? 'ACTIVE' : 'PENDING_APPROVAL'));
    });

    render(<NonDashboardPanel selectedPageKey="projectReview" onPushToast={mockPushToast} />);
    await screen.findAllByText('Hỗ trợ vùng lũ');
    fireEvent.click(screen.getByRole('button', { name: 'Chấp nhận' }));
    fireEvent.click(screen.getByRole('button', { name: 'Chắc chắn' }));

    await waitFor(() => expect(mockPushToast).toHaveBeenCalledWith(
      'Duyệt dự án thành công',
      expect.stringMatching(/chưa có Kiểm toán viên giám sát/i),
      'success'
    ));
    expect(screen.queryByText(/chưa có Kiểm toán viên giám sát/i)).not.toBeInTheDocument();
  });
});
