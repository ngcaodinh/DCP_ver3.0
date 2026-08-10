import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRef, useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import DlqDetailModal from '@/app/components/adminSbtRetry/DlqDetailModal';
import type { SbtMintDlqEntry } from '@/app/types/sbtRetry';

/** Tạo entry có lỗi dài và context đầy đủ cho test detail modal. */
function createEntry(overrides: Partial<SbtMintDlqEntry> = {}): SbtMintDlqEntry {
  return {
    dlqId: 'DLQ-1',
    mintRequestId: 'MINT-1',
    sbtId: 'SBT-1',
    projectId: 'PROJECT-1',
    projectName: 'Project One',
    organizationId: 'ORG-1',
    beneficiaryAddress: '0xbeneficiary',
    attemptNumber: 6,
    lastErrorMessage: `RPC failed ${'x'.repeat(300)}`,
    firstAttemptedAt: '2026-08-01T00:00:00.000Z',
    dlqAt: '2026-08-02T00:00:00.000Z',
    recoveredAt: null,
    recoveredBy: null,
    recoveryAttemptNumber: 0,
    status: 'OPEN',
    createdAt: '2026-08-02T00:00:00.000Z',
    updatedAt: '2026-08-02T00:00:00.000Z',
    ...overrides
  };
}

describe('DlqDetailModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('hiển thị đầy đủ lỗi dài và context của DLQ', () => {
    const entry = createEntry();
    render(<DlqDetailModal entry={entry} isSubmitting={false} onClose={vi.fn()} onConfirm={vi.fn()} />);

    expect(screen.getByText(entry.lastErrorMessage)).toBeInTheDocument();
    expect(screen.getByText('PROJECT-1')).toBeInTheDocument();
    expect(screen.getByText('SBT-1')).toBeInTheDocument();
    expect(screen.getByText('0xbeneficiary')).toBeInTheDocument();
    expect(screen.getByText(/lỗi của lần vào DLQ đầu tiên/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Chạy lại' })).toBeInTheDocument();
  });

  it('click Chạy lại chuyển sang confirm và chỉ confirm mới gọi callback', () => {
    const onConfirm = vi.fn();
    render(<DlqDetailModal entry={createEntry()} isSubmitting={false} onClose={vi.fn()} onConfirm={onConfirm} />);

    fireEvent.click(screen.getByRole('button', { name: 'Chạy lại' }));
    expect(screen.getByRole('button', { name: 'Xác nhận chạy lại' })).toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Xác nhận chạy lại' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('status khác OPEN không render retry, Escape đóng và trả focus về trigger', async () => {
    const triggerRef = createRef<HTMLButtonElement>();
    function ModalHarness() {
      const [isOpen, setIsOpen] = useState(true);
      return (
        <>
          <button ref={triggerRef} type="button">Mở modal</button>
          {isOpen && <DlqDetailModal entry={createEntry({ status: 'RECOVERED' })} isSubmitting={false} onClose={() => setIsOpen(false)} onConfirm={vi.fn()} returnFocusRef={triggerRef} />}
        </>
      );
    }

    render(<ModalHarness />);
    expect(screen.queryByRole('button', { name: 'Chạy lại' })).not.toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(triggerRef.current).toHaveFocus();
  });

  it('giữ Tab trong modal và khóa nút khi đang submit', () => {
    render(<DlqDetailModal entry={createEntry()} initialPhase="confirm" isSubmitting={false} onClose={vi.fn()} onConfirm={vi.fn()} />);

    const cancelButton = screen.getByRole('button', { name: 'Hủy' });
    const submitButton = screen.getByRole('button', { name: 'Xác nhận chạy lại' });
    const closeButton = screen.getByRole('button', { name: 'Đóng dialog' });
    submitButton.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(closeButton).toHaveFocus();
    expect(cancelButton).not.toBeDisabled();

    const submittingView = render(<DlqDetailModal entry={createEntry()} initialPhase="confirm" isSubmitting onClose={vi.fn()} onConfirm={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Đang xử lý...' })).toBeDisabled();
    submittingView.unmount();
  });
});
