import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import LogoutConfirmationDialog from '@/app/components/common/LogoutConfirmationDialog';

describe('LogoutConfirmationDialog', () => {
  it('không hiển thị khi chưa có yêu cầu đăng xuất', () => {
    render(<LogoutConfirmationDialog isOpen={false} onCancel={vi.fn()} onConfirm={vi.fn()} />);

    expect(screen.queryByRole('dialog', { name: 'Xác nhận đăng xuất' })).not.toBeInTheDocument();
  });

  it('chỉ gọi hành động tương ứng khi người dùng hủy hoặc xác nhận', () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(<LogoutConfirmationDialog isOpen onCancel={onCancel} onConfirm={onConfirm} />);

    expect(screen.getByRole('dialog', { name: 'Xác nhận đăng xuất' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Hủy' }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Đóng xác nhận đăng xuất' }));
    expect(onCancel).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getAllByRole('button', { name: 'Đăng xuất' })[0]);
    expect(onConfirm).toHaveBeenCalledOnce();
  });
});
