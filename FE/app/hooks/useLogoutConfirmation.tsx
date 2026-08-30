'use client';

import { useCallback, useState, type ReactElement } from 'react';
import LogoutConfirmationDialog from '@/app/components/common/LogoutConfirmationDialog';

type ConfirmLogoutHandler = () => void | Promise<void>;

interface UseLogoutConfirmationResult {
  requestLogout: () => void;
  logoutConfirmationDialog: ReactElement;
}

/** Cung cấp cùng một bước xác nhận cho mọi thao tác đăng xuất do người dùng chủ động kích hoạt. */
export function useLogoutConfirmation(onConfirmLogout: ConfirmLogoutHandler): UseLogoutConfirmationResult {
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);

  /** Mở hộp thoại thay vì xóa phiên ngay khi người dùng bấm nút đăng xuất. */
  const requestLogout = useCallback((): void => {
    setIsDialogOpen(true);
  }, []);

  /** Hủy yêu cầu đăng xuất để giữ nguyên phiên và công việc đang mở. */
  const cancelLogout = useCallback((): void => {
    if (!isConfirming) {
      setIsDialogOpen(false);
    }
  }, [isConfirming]);

  /** Thực hiện callback kết thúc phiên sau khi người dùng đã xác nhận rõ ràng. */
  const confirmLogout = useCallback((): void => {
    setIsConfirming(true);
    void Promise.resolve(onConfirmLogout()).finally(() => {
      setIsConfirming(false);
      setIsDialogOpen(false);
    });
  }, [onConfirmLogout]);

  return {
    requestLogout,
    logoutConfirmationDialog: (
      <LogoutConfirmationDialog
        isOpen={isDialogOpen}
        isConfirming={isConfirming}
        onCancel={cancelLogout}
        onConfirm={confirmLogout}
      />
    ),
  };
}
