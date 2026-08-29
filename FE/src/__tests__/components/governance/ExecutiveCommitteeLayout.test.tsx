import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readAuthSession: vi.fn(),
  clearAuthSession: vi.fn(),
  replace: vi.fn()
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: mocks.replace }) }));
vi.mock('@/app/utils/authSession', () => ({ readAuthSession: mocks.readAuthSession, clearAuthSession: mocks.clearAuthSession }));
vi.mock('@/app/components/governance/ActiveProjectsPanel', () => ({ ActiveProjectsPanel: () => <div>Active projects content</div> }));
vi.mock('@/app/components/governance/DisbursementVotingPanel', () => ({ DisbursementVotingPanel: () => <div>Disbursement content</div> }));
vi.mock('@/app/components/governance/ExecutivePortalClient', () => ({ default: () => <div>Project verdict content</div> }));
vi.mock('@/app/components/governance/ChairActionsPanel', () => ({ ChairActionsPanel: () => <div>Chair retry controls</div> }));

import { ExecutiveCommitteeLayout } from '@/app/components/governance/ExecutiveCommitteeLayout';

describe('ExecutiveCommitteeLayout role separation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readAuthSession.mockReturnValue({ userRole: 'executive_chair', userWalletAddress: '0x111' });
  });

  it('Chair thấy đúng ba tab và công cụ retry vận hành bắt buộc của Chair', async () => {
    render(<ExecutiveCommitteeLayout viewerRole="CHAIR" />);

    expect(await screen.findByRole('tablist', { name: '' })).toBeInTheDocument();
    expect(screen.getAllByRole('tab')).toHaveLength(3);
    expect(screen.getByText('Chair retry controls')).toBeInTheDocument();
    expect(screen.queryByText(/GPS override/i)).not.toBeInTheDocument();
  });

  it('Member vẫn có ba tab nhưng không được render action retry của Chair', async () => {
    mocks.readAuthSession.mockReturnValue({ userRole: 'executive_member', userWalletAddress: '0x222' });

    render(<ExecutiveCommitteeLayout viewerRole="MEMBER" />);

    expect(await screen.findByRole('tablist', { name: '' })).toBeInTheDocument();
    expect(screen.getAllByRole('tab')).toHaveLength(3);
    expect(screen.queryByText('Chair retry controls')).not.toBeInTheDocument();
  });

  it('redirect role ngoài committee sang unauthorized trước khi render dữ liệu portal', async () => {
    mocks.readAuthSession.mockReturnValue({ userRole: 'donor', userWalletAddress: '0x333' });

    render(<ExecutiveCommitteeLayout viewerRole="MEMBER" />);

    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith('/unauthorized'));
    expect(screen.queryByText('Active projects content')).not.toBeInTheDocument();
  });
});
