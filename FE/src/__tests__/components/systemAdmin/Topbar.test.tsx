import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import Topbar from '@/app/components/systemAdmin/tailwind/Topbar';

const walletAddress = '0x902130ceaf01d52523c38166fbdbaf31bd40f302';

describe('System Admin Topbar', () => {
  it('rút gọn ví trong tên và không lặp email định danh tự sinh từ cùng ví', () => {
    render(
      <Topbar
        breadcrumbTitle="Tổng quan hệ thống"
        userDisplayName={`Quản trị gốc ${walletAddress}`}
        userEmail={`${walletAddress}@wallet.dcp.local`}
        userWalletAddress={walletAddress}
        notificationContent={<span>Thông báo</span>}
        onLogout={() => undefined}
      />,
    );

    expect(screen.getByText('Quản trị gốc 0x902130...f302')).toBeInTheDocument();
    expect(screen.getByText('0x902130...f302')).toBeInTheDocument();
    expect(screen.queryByText(`${walletAddress}@wallet.dcp.local`)).not.toBeInTheDocument();
  });

  it('mở menu điều hướng từ topbar ở màn hình nhỏ', () => {
    const onOpenMobileMenu = vi.fn();
    render(
      <Topbar
        breadcrumbTitle="Ghế Ủy ban"
        userDisplayName="Quản trị gốc"
        userEmail=""
        userWalletAddress=""
        notificationContent={<span>Thông báo</span>}
        onOpenMobileMenu={onOpenMobileMenu}
        onLogout={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Mở menu điều hướng' }));
    expect(onOpenMobileMenu).toHaveBeenCalledOnce();
  });
});
