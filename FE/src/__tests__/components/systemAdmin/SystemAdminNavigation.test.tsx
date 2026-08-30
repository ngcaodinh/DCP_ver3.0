import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import Sidebar from '@/app/components/systemAdmin/tailwind/Sidebar';
import { getNavigationItems } from '@/app/components/systemAdmin/tailwind/data';

describe('System Admin navigation', () => {
  it('chỉ cấu hình các chức năng có quyền hoặc trang vận hành Admin tương ứng', () => {
    const navigationKeys = getNavigationItems().map(item => item.key);

    expect(navigationKeys).toEqual([
      'dashboard',
      'systemErrorLog',
      'sybilManagement',
      'transferQueue',
      'committeeSeats',
      'feedbackFlagging',
    ]);
    expect(navigationKeys).not.toContain('report');
    expect(navigationKeys).not.toContain('disbursement');
    expect(navigationKeys).not.toContain('transparency');
    expect(navigationKeys).not.toContain('kyc');
    expect(navigationKeys).not.toContain('bankAccountApproval');
  });

  it('giữ người dùng trong shell Admin khi chọn hàng chờ và feedback', () => {
    const onSelectPage = vi.fn();
    render(<Sidebar selectedPageKey="dashboard" navigationItemList={getNavigationItems()} onSelectPage={onSelectPage} />);

    fireEvent.click(screen.getByRole('button', { name: 'Hàng chờ chuyển khoản' }));
    expect(onSelectPage).toHaveBeenCalledWith('transferQueue');

    fireEvent.click(screen.getByRole('button', { name: 'Feedback bị gắn cờ' }));
    expect(onSelectPage).toHaveBeenCalledWith('feedbackFlagging');

    expect(screen.queryByRole('button', { name: 'Duyệt hồ sơ KYC' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Duyệt tài khoản ngân hàng' })).not.toBeInTheDocument();
  });
});
