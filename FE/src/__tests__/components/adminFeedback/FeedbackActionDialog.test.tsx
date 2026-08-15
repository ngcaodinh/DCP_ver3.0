import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import FeedbackActionDialog, { getFeedbackActionErrorMessage } from '@/app/components/adminFeedback/FeedbackActionDialog';

const mocks = vi.hoisted(() => ({
  fetchApi: vi.fn(),
  buildApiUrl: vi.fn((path: string) => path),
  readAuthSession: vi.fn(() => ({ accessToken: 'token-1' }))
}));

vi.mock('@/app/utils/apiClient', () => ({ fetchApi: mocks.fetchApi, buildApiUrl: mocks.buildApiUrl }));
vi.mock('@/app/utils/authSession', () => ({ readAuthSession: mocks.readAuthSession }));

describe('FeedbackActionDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchApi.mockResolvedValue({ success: true, message: 'ok', data: {} });
  });

  it('render đúng confirmation text của 3 mode và disable khi reason dưới 10', () => {
    const { rerender } = render(<FeedbackActionDialog feedbackId="fb-1" mode="unflag" onClose={vi.fn()} onSuccess={vi.fn()} onRefresh={vi.fn()} onForbidden={vi.fn()} />);
    expect(screen.getByText('Bạn có chắc muốn bỏ flag?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Xác nhận bỏ flag' })).toBeDisabled();

    rerender(<FeedbackActionDialog feedbackId="fb-1" mode="delete" onClose={vi.fn()} onSuccess={vi.fn()} onRefresh={vi.fn()} onForbidden={vi.fn()} />);
    expect(screen.getByText('Hành động không thể hoàn tác')).toBeInTheDocument();
    expect(screen.getByText('Bản ghi được giữ 30 ngày rồi xoá vĩnh viễn.')).toBeInTheDocument();

    rerender(<FeedbackActionDialog feedbackId="fb-1" mode="restore" onClose={vi.fn()} onSuccess={vi.fn()} onRefresh={vi.fn()} onForbidden={vi.fn()} />);
    expect(screen.getByText('Khôi phục feedback này?')).toBeInTheDocument();
    expect(screen.getByText('Feedback sẽ quay lại danh sách đang bị flag, chưa hiển thị công khai.')).toBeInTheDocument();
  });

  it('gửi DELETE/POST đúng endpoint, reason đã trim và callback success', async () => {
    const onClose = vi.fn();
    const onSuccess = vi.fn();
    render(<FeedbackActionDialog feedbackId="fb/1" mode="delete" onClose={onClose} onSuccess={onSuccess} onRefresh={vi.fn()} onForbidden={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/Lý do/), { target: { value: '  Có bằng chứng spam  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Xác nhận xoá' }));

    await waitFor(() => expect(mocks.fetchApi).toHaveBeenCalledWith('/api/feedback/fb%2F1', expect.objectContaining({
      method: 'DELETE',
      body: JSON.stringify({ reason: 'Có bằng chứng spam' })
    })));
    expect(onSuccess).toHaveBeenCalledWith('delete');
    expect(onClose).toHaveBeenCalled();
  });

  it('409 info tự refresh/đóng và 404 restore dùng cảnh báo quá hạn riêng', async () => {
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    const onNotice = vi.fn();
    mocks.fetchApi.mockRejectedValueOnce({ statusCode: 409, errorCode: 'CONFLICT', message: 'conflict' });
    render(<FeedbackActionDialog feedbackId="fb-1" mode="unflag" onClose={onClose} onSuccess={vi.fn()} onRefresh={onRefresh} onForbidden={vi.fn()} onNotice={onNotice} />);
    fireEvent.change(screen.getByLabelText(/Lý do/), { target: { value: 'Reason cạnh tranh' } });
    fireEvent.click(screen.getByRole('button', { name: 'Xác nhận bỏ flag' }));
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalled();
    expect(onNotice).toHaveBeenCalledWith('Feedback đã được admin khác xử lý. Danh sách đã được làm mới.', 'info');

    expect(getFeedbackActionErrorMessage({ statusCode: 404, errorCode: 'NOT_FOUND' }, 'restore')).toContain('quá hạn 30 ngày');
    expect(getFeedbackActionErrorMessage({ statusCode: 404, errorCode: 'NOT_FOUND' }, 'delete')).toBe('Feedback không còn tồn tại.');
    expect(getFeedbackActionErrorMessage({ statusCode: 403, errorCode: 'FORBIDDEN' }, 'delete')).toContain('không còn quyền admin');
    expect(getFeedbackActionErrorMessage({ statusCode: 429, errorCode: 'RATE_LIMIT_EXCEEDED' }, 'delete')).toContain('30 thao tác/phút');
  });
});
