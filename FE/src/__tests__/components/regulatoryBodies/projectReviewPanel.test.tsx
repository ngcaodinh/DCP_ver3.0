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

vi.mock('@/app/components/regulatoryBodies/tailwind/SybilManagementPanel', () => ({
  default: () => <div>Sybil panel</div>
}));

vi.mock('@/app/components/regulatoryBodies/tailwind/FoundationKycApprovalPanel', () => ({
  default: () => <div>Foundation KYC panel</div>
}));

import NonDashboardPanel from '@/app/components/regulatoryBodies/tailwind/NonDashboardPanel';

/** Tạo response dự án chờ duyệt có metadata IPFS để kiểm tra preview không phải suy đoán loại file. */
function createPendingProjectResponse(status: "PENDING_APPROVAL" | "ACTIVE" | "REJECTED" = "PENDING_APPROVAL"): { data: unknown[] } {
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
    render(<NonDashboardPanel selectedPageKey="projectReview" />);

    await screen.findAllByText('Hỗ trợ vùng lũ');
    expect(screen.getByText('evidence.jpg image/jpeg')).toBeInTheDocument();

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
    expect(await screen.findByText('Phê duyệt dự án thành công.')).toBeInTheDocument();
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

  it('shows the backend error when on-chain approval cannot complete', async () => {
    mockFetchApi.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return Promise.reject({ message: 'Không thể kích hoạt dự án trên blockchain. Vui lòng thử lại sau.' });
      }

      return Promise.resolve(createPendingProjectResponse());
    });

    render(<NonDashboardPanel selectedPageKey="projectReview" />);

    await screen.findAllByText('Hỗ trợ vùng lũ');
    fireEvent.click(screen.getByRole('button', { name: 'Chấp nhận' }));
    fireEvent.click(screen.getByRole('button', { name: 'Chắc chắn' }));

    expect(await screen.findByText('Không thể kích hoạt dự án trên blockchain. Vui lòng thử lại sau.')).toBeInTheDocument();
  });
});
