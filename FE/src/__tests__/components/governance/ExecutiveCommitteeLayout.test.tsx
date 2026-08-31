import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readAuthSession: vi.fn(),
  clearAuthSession: vi.fn(),
  replace: vi.fn()
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: mocks.replace }) }));
vi.mock('@/app/utils/authSession', () => ({ readAuthSession: mocks.readAuthSession, clearAuthSession: mocks.clearAuthSession }));
vi.mock('@/app/components/governance/ActiveProjectsPanel', () => ({ ActiveProjectsPanel: () => <div>Active projects content</div> }));
vi.mock('@/app/components/governance/PendingPublicationProjectsPanel', () => ({ PendingPublicationProjectsPanel: () => <div>Pending publication content</div> }));
vi.mock('@/app/components/governance/DisbursementVotingPanel', () => ({ DisbursementVotingPanel: () => <div>Disbursement content</div> }));
vi.mock('@/app/components/governance/ExecutivePortalClient', () => ({ default: () => <div>Project verdict content</div> }));
vi.mock('@/app/components/governance/ChairActionsPanel', () => ({ ChairActionsPanel: () => <div>Chair retry controls</div> }));

import { ExecutiveCommitteeLayout } from '@/app/components/governance/ExecutiveCommitteeLayout';

describe('ExecutiveCommitteeLayout role separation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readAuthSession.mockReturnValue({ userRole: 'executive_chair', userWalletAddress: '0x111' });
  });

  it('Chair thấy đúng bốn tab và công cụ retry vận hành bắt buộc của Chair', async () => {
    render(<ExecutiveCommitteeLayout viewerRole="CHAIR" />);

    expect(await screen.findByRole('tablist', { name: 'Điều hướng Ủy ban' })).toBeInTheDocument();
    expect(screen.getAllByRole('tab')).toHaveLength(4);
    expect(screen.getByText('Chair retry controls')).toBeInTheDocument();
    expect(screen.queryByText(/GPS override/i)).not.toBeInTheDocument();
  });

  it('Member vẫn có bốn tab nhưng không được render action retry của Chair', async () => {
    mocks.readAuthSession.mockReturnValue({ userRole: 'executive_member', userWalletAddress: '0x222' });

    render(<ExecutiveCommitteeLayout viewerRole="MEMBER" />);

    expect(await screen.findByRole('tablist', { name: 'Điều hướng Ủy ban' })).toBeInTheDocument();
    expect(screen.getAllByRole('tab')).toHaveLength(4);
    expect(screen.queryByText('Chair retry controls')).not.toBeInTheDocument();
  });

  it('giữ khu vực dự án chờ công bố giống Member, không chen công cụ vận hành riêng của Chair', async () => {
    render(<ExecutiveCommitteeLayout viewerRole="CHAIR" />);

    fireEvent.click(await screen.findByRole('tab', { name: 'Dự án chờ công bố' }));

    expect(screen.getByText('Pending publication content')).toBeInTheDocument();
    expect(screen.queryByText('Chair retry controls')).not.toBeInTheDocument();
  });

  it('redirect role ngoài committee sang unauthorized trước khi render dữ liệu portal', async () => {
    mocks.readAuthSession.mockReturnValue({ userRole: 'donor', userWalletAddress: '0x333' });

    render(<ExecutiveCommitteeLayout viewerRole="MEMBER" />);

    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith('/unauthorized'));
    expect(screen.queryByText('Active projects content')).not.toBeInTheDocument();
  });

  it('đăng xuất Ủy viên sau khi xác nhận và quay về cổng Governance', async () => {
    mocks.readAuthSession.mockReturnValue({ userRole: 'executive_member', userWalletAddress: '0x222' });
    render(<ExecutiveCommitteeLayout viewerRole="MEMBER" />);

    await screen.findByRole('tablist', { name: 'Điều hướng Ủy ban' });
    fireEvent.click(screen.getByRole('button', { name: 'Đăng xuất' }));

    const confirmationDialog = screen.getByRole('dialog', { name: 'Xác nhận đăng xuất' });
    fireEvent.click(within(confirmationDialog).getByRole('button', { name: 'Đăng xuất' }));

    expect(mocks.clearAuthSession).toHaveBeenCalledOnce();
    expect(mocks.replace).toHaveBeenCalledWith('/governance/login');
  });

  it('mở và đóng drawer điều hướng bằng thao tác mobile mà không làm đổi quyền Chair', async () => {
    render(<ExecutiveCommitteeLayout viewerRole="CHAIR" />);

    await screen.findByRole('tablist', { name: 'Điều hướng Ủy ban' });
    fireEvent.click(screen.getByRole('button', { name: 'Mở menu điều hướng' }));

    const mobileMenu = screen.getByRole('dialog', { name: 'Menu điều hướng Ủy ban' });
    fireEvent.click(within(mobileMenu).getByRole('tab', { name: 'Duyệt giải ngân' }));

    expect(screen.queryByRole('dialog', { name: 'Menu điều hướng Ủy ban' })).not.toBeInTheDocument();
    expect(screen.getByText('Chair retry controls')).toBeInTheDocument();
  });

  it('đóng drawer điều hướng khi nhấn Escape', async () => {
    render(<ExecutiveCommitteeLayout viewerRole="CHAIR" />);

    await screen.findByRole('tablist', { name: 'Điều hướng Ủy ban' });
    fireEvent.click(screen.getByRole('button', { name: 'Mở menu điều hướng' }));
    expect(screen.getByRole('dialog', { name: 'Menu điều hướng Ủy ban' })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('dialog', { name: 'Menu điều hướng Ủy ban' })).not.toBeInTheDocument();
  });

  it('công bố trạng thái drawer qua aria-expanded và cho phép đóng bằng nút toggle', async () => {
    render(<ExecutiveCommitteeLayout viewerRole="CHAIR" />);

    const menuButton = await screen.findByRole('button', { name: 'Mở menu điều hướng' });
    expect(menuButton).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('main')).toHaveClass('overflow-x-clip', 'lg:flex', 'lg:items-start');
    expect(screen.queryByRole('dialog', { name: 'Menu điều hướng Ủy ban' })).not.toBeInTheDocument();
    expect(screen.getByRole('complementary').parentElement).toHaveClass('lg:sticky', 'lg:top-0', 'lg:h-screen');
    expect(screen.getByTitle('Chủ tịch DAO')).toHaveClass('max-w-[8rem]', 'truncate');

    fireEvent.click(menuButton);
    expect(menuButton).toHaveAccessibleName('Đóng menu điều hướng');
    expect(menuButton).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(menuButton);

    expect(screen.queryByRole('dialog', { name: 'Menu điều hướng Ủy ban' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mở menu điều hướng' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('tự đóng drawer khi viewport chuyển sang desktop', async () => {
    render(<ExecutiveCommitteeLayout viewerRole="CHAIR" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Mở menu điều hướng' }));
    expect(screen.getByRole('dialog', { name: 'Menu điều hướng Ủy ban' })).toBeInTheDocument();

    const originalInnerWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
    fireEvent(window, new Event('resize'));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Menu điều hướng Ủy ban' })).not.toBeInTheDocument());
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalInnerWidth });
  });
});
