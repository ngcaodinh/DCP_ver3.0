import { describe, expect, it, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef, useState } from 'react';
import ManualReviewDialog from '@/app/components/adminTransfers/ManualReviewDialog';
import { fetchApi } from '@/app/utils/apiClient';
import { readAuthSession } from '@/app/utils/authSession';

vi.mock('@/app/utils/apiClient', () => ({
  buildApiUrl: vi.fn((path: string) => path),
  fetchApi: vi.fn()
}));

vi.mock('@/app/utils/authSession', () => ({
  readAuthSession: vi.fn()
}));

/** Tạo props action tối thiểu để kiểm tra semantics approve/reject. */
function renderDialog(mode: 'approve' | 'reject', overrides: Partial<React.ComponentProps<typeof ManualReviewDialog>> = {}) {
  const onSuccess = vi.fn();
  const onError = vi.fn();
  render(<ManualReviewDialog requestId="DS-001" projectId="project-001" amount={1000} mode={mode} onClose={vi.fn()} onSuccess={onSuccess} onError={onError} {...overrides} />);
  return { onSuccess, onError };
}

describe('ManualReviewDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readAuthSession).mockReturnValue({ accessToken: 'token-001' });
  });

  it('chặn reason ngoài khoảng 10–1000 ký tự', () => {
    renderDialog('reject');
    const reasonInput = screen.getByLabelText(/Lý do reject/);
    fireEvent.change(reasonInput, { target: { value: '123456789' } });
    expect(screen.getByRole('button', { name: 'Xác nhận Reject' })).toBeDisabled();
    fireEvent.change(reasonInput, { target: { value: '1234567890' } });
    expect(screen.getByRole('button', { name: 'Xác nhận Reject' })).not.toBeDisabled();
    fireEvent.change(reasonInput, { target: { value: 'x'.repeat(1000) } });
    expect(screen.getByRole('button', { name: 'Xác nhận Reject' })).not.toBeDisabled();
    fireEvent.change(reasonInput, { target: { value: 'x'.repeat(1001) } });
    expect(screen.getByRole('button', { name: 'Xác nhận Reject' })).toBeDisabled();
  });

  it('approve hiển thị PROCESSING semantics và gọi success sau response 202', async () => {
    vi.mocked(fetchApi).mockResolvedValue({ success: true, message: '', data: { payosTransferStatus: 'PROCESSING' } } as never);
    const { onSuccess } = renderDialog('approve');
    expect(screen.getByText(/đối soát PayOS trước/)).toBeInTheDocument();
    expect(screen.queryByText(/TRANSFERRED|đã chuyển tiền/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Xác nhận Approve' }));
    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith('DS-001', 'approve'));
  });

  it('reject trim reason, gửi đúng endpoint/body và gọi success sau response', async () => {
    vi.mocked(fetchApi).mockResolvedValue({ success: true, message: '', data: { status: 'REJECTED' } } as never);
    const { onSuccess } = renderDialog('reject');
    fireEvent.change(screen.getByLabelText(/Lý do reject/), { target: { value: '  Không hợp lệ  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Xác nhận Reject' }));

    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith('DS-001', 'reject'));
    expect(fetchApi).toHaveBeenCalledWith(
      '/api/disbursements/DS-001/manual-reject',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer token-001' },
        body: JSON.stringify({ reason: 'Không hợp lệ' })
      }
    );
  });

  it('409 báo chờ webhook và không gọi success', async () => {
    vi.mocked(fetchApi).mockRejectedValue({ statusCode: 409, errorCode: 'CONFLICT', message: 'conflict' });
    const { onSuccess, onError } = renderDialog('approve');
    fireEvent.click(screen.getByRole('button', { name: 'Xác nhận Approve' }));
    await waitFor(() => expect(screen.getByText(/chờ webhook đối soát/)).toBeInTheDocument());
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('chờ webhook đối soát'));
  });

  it.each([
    [{ statusCode: 400, errorCode: 'INVALID_STATUS_TRANSITION', message: 'stale' }, 'Item không còn ở trạng thái manual review.'],
    [{ statusCode: 404, errorCode: 'NOT_FOUND', message: 'missing' }, 'Không tìm thấy item manual review; danh sách sẽ được làm mới.'],
    [{ statusCode: 429, errorCode: 'RATE_LIMITED', message: 'slow down' }, 'vượt giới hạn 20 thao tác/phút'],
    [{ statusCode: 503, errorCode: 'INTERNAL_ERROR', message: 'down' }, 'Dịch vụ tạm thời không khả dụng'],
    [{ statusCode: 400, errorCode: 'VALIDATION_ERROR', message: 'reason không hợp lệ' }, 'reason không hợp lệ'],
    [{ statusCode: 418, errorCode: 'TEAPOT', message: 'teapot' }, 'Thao tác thất bại. Vui lòng thử lại.']
  ])('phân loại lỗi action và refresh với item stale (%s)', async (error, expectedMessage) => {
    vi.mocked(fetchApi).mockRejectedValue(error);
    const onRefresh = vi.fn();
    renderDialog('approve', { onRefresh });
    fireEvent.click(screen.getByRole('button', { name: 'Xác nhận Approve' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(expectedMessage));
    if (error.statusCode === 404 || error.errorCode === 'INVALID_STATUS_TRANSITION') {
      await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
    }
    else expect(onRefresh).not.toHaveBeenCalled();
  });

  it('Escape đóng dialog và focus trap quay focus về trigger', async () => {
    const triggerRef = createRef<HTMLButtonElement>();
    function DialogHarness() {
      const [isOpen, setIsOpen] = useState(true);
      return (
        <>
          <button ref={triggerRef} type="button">Mở dialog</button>
          {isOpen && (
            <ManualReviewDialog
              requestId="DS-001"
              projectId="project-001"
              amount={1000}
              mode="reject"
              onClose={() => setIsOpen(false)}
              onSuccess={vi.fn()}
              returnFocusRef={triggerRef}
            />
          )}
        </>
      );
    }

    render(<DialogHarness />);
    const closeButton = screen.getByRole('button', { name: 'Đóng dialog' });
    fireEvent.change(screen.getByLabelText(/Lý do reject/), { target: { value: '1234567890' } });
    const submitButton = screen.getByRole('button', { name: 'Xác nhận Reject' });
    submitButton.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(closeButton).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(submitButton).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(triggerRef.current).toHaveFocus();
  });

  it('preserves textarea focus when the parent rerenders an open dialog', () => {
    const triggerRef = createRef<HTMLButtonElement>();
    const { rerender } = render(
      <ManualReviewDialog
        requestId="DS-001"
        projectId="project-001"
        amount={1000}
        mode="reject"
        onClose={() => undefined}
        onSuccess={vi.fn()}
        returnFocusRef={triggerRef}
      />
    );

    const reasonInput = screen.getByRole('textbox');
    reasonInput.focus();
    rerender(
      <ManualReviewDialog
        requestId="DS-001"
        projectId="project-001"
        amount={1000}
        mode="reject"
        onClose={() => undefined}
        onSuccess={vi.fn()}
        returnFocusRef={triggerRef}
      />
    );

    expect(reasonInput).toHaveFocus();
  });
});
