import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ExecutiveCommitteeNavigation } from '@/app/components/governance/ExecutiveCommitteeNavigation';

describe('ExecutiveCommitteeNavigation', () => {
  it('công bố tab đang chọn và cho phép thao tác bằng sidebar semantic', () => {
    const onSelect = vi.fn();
    render(<ExecutiveCommitteeNavigation activeTab="ACTIVE_PROJECTS" viewerRole="CHAIR" onSelect={onSelect} onLogout={vi.fn()} />);

    expect(screen.getByRole('complementary')).toHaveClass('min-h-screen', 'h-[100dvh]', 'w-[min(252px,calc(100vw-1rem))]', 'lg:sticky', 'lg:top-0', 'lg:h-screen', 'lg:self-start');
    const tabList = screen.getByRole('tablist', { name: 'Điều hướng Ủy ban' });
    expect(tabList).toHaveAttribute('aria-orientation', 'vertical');
    expect(tabList.tagName).toBe('DIV');
    expect(tabList).toHaveClass('min-h-0');
    const activeTab = screen.getByRole('tab', { name: 'Dự án đang hoạt động' });
    expect(activeTab).toHaveAttribute('aria-selected', 'true');
    expect(activeTab).toHaveAttribute('aria-controls', 'executive-ACTIVE_PROJECTS-panel');
    expect(activeTab).toHaveClass('min-w-0');
    expect(activeTab.querySelector('span')).toHaveClass('truncate');
    fireEvent.click(screen.getByRole('tab', { name: 'Dự án chờ công bố' }));
    expect(onSelect).toHaveBeenCalledWith('PENDING_PUBLICATION');
    fireEvent.click(screen.getByRole('tab', { name: 'Duyệt giải ngân' }));

    expect(onSelect).toHaveBeenCalledWith('DISBURSEMENT');
  });

  it('hiển thị vai trò và chuyển yêu cầu đăng xuất từ sidebar', () => {
    const onLogout = vi.fn();
    render(<ExecutiveCommitteeNavigation activeTab="PROJECT_VERDICT" viewerRole="CHAIR" onSelect={vi.fn()} onLogout={onLogout} />);

    expect(screen.getByText('Chủ tịch DAO')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Đăng xuất' }));

    expect(onLogout).toHaveBeenCalledOnce();
  });
});
