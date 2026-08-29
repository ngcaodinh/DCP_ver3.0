import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({ submitConfirmed: vi.fn(), fetchApi: vi.fn(), refreshAuthSession: vi.fn(), readAuthSession: vi.fn() }));

vi.mock('@/app/utils/authSession', () => ({ readAuthSession: mocks.readAuthSession }));
vi.mock('@/app/utils/authSessionRefresh', () => ({ refreshAuthSession: mocks.refreshAuthSession }));
vi.mock('@/app/utils/apiClient', () => ({ buildApiUrl: (path: string) => path, buildSameOriginApiUrl: (path: string) => path, fetchApi: mocks.fetchApi }));
vi.mock('@/app/utils/auditorPortalApi', () => ({ submitAuditorListingVerification: mocks.submitConfirmed }));
vi.mock('@/app/components/common/evidenceCamera/EvidenceCameraCapture', () => ({
  EvidenceCameraCapture: ({ onChange }: { onChange: (photos: any[]) => void }) => <button type="button" onClick={() => onChange([{ localId: 'photo-1', previewObjectUrl: 'blob:photo', cid: 'cid-1' }])}>Add camera photo</button>
}));

import AuditorListingVerificationForm from '@/app/components/governance/AuditorListingVerificationForm';

describe('AuditorListingVerificationForm', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.readAuthSession.mockReturnValue({ accessToken: 'auditor-token' });
  });

  it('requires a camera photo before either conclusion can be submitted', () => {
    render(<AuditorListingVerificationForm projectId="project-1" projectName="Project 1" onCompleted={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText(/Dự án đúng với sự thật/i));
    expect(screen.getByRole('button', { name: /Gửi xác minh/i })).toBeDisabled();
    fireEvent.click(screen.getByText('Add camera photo'));
    expect(screen.getByRole('button', { name: /Gửi xác minh/i })).toBeEnabled();
  });

  it('requires a reason of at least thirty characters for the challenge branch', () => {
    render(<AuditorListingVerificationForm projectId="project-1" projectName="Project 1" onCompleted={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText(/Dự án sai sự thật/i));
    fireEvent.click(screen.getByText('Add camera photo'));
    expect(screen.getByRole('button', { name: /Gửi xác minh/i })).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Lý do khiếu nại/i), { target: { value: 'a'.repeat(30) } });
    expect(screen.getByRole('button', { name: /Gửi xác minh/i })).toBeEnabled();
  });

  it('submits the confirmed verdict only to listing-verification without a reason', async () => {
    mocks.submitConfirmed.mockResolvedValueOnce(undefined);
    render(<AuditorListingVerificationForm projectId="project-1" projectName="Project 1" onCompleted={vi.fn().mockResolvedValue(undefined)} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText(/Dự án đúng với sự thật/i));
    expect(screen.queryByLabelText(/Lý do khiếu nại/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Add camera photo'));
    fireEvent.click(screen.getByRole('button', { name: /Gửi xác minh/i }));

    await waitFor(() => expect(mocks.submitConfirmed).toHaveBeenCalledOnce());
    expect(mocks.submitConfirmed).toHaveBeenCalledWith('auditor-token', expect.not.objectContaining({ reason: expect.anything() }));
    expect(mocks.fetchApi).not.toHaveBeenCalled();
  });

  it('shows a success popup and closes the form after confirmation', async () => {
    const onClose = vi.fn();
    mocks.submitConfirmed.mockResolvedValueOnce(undefined);
    render(<AuditorListingVerificationForm projectId="project-1" projectName="Project 1" onCompleted={vi.fn().mockResolvedValue(undefined)} onClose={onClose} />);
    fireEvent.click(screen.getByText(/Dự án đúng với sự thật/i));
    fireEvent.click(screen.getByText('Add camera photo'));
    fireEvent.click(screen.getByRole('button', { name: /Gửi xác minh/i }));

    const popup = await screen.findByRole('dialog');
    expect(popup).toHaveTextContent('Gửi xác minh thành công');
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Đóng' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('submits the challenge verdict only to the existing challenges endpoint', async () => {
    mocks.fetchApi.mockResolvedValueOnce({ data: {} });
    render(<AuditorListingVerificationForm projectId="project-1" projectName="Project 1" onCompleted={vi.fn().mockResolvedValue(undefined)} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText(/Dự án sai sự thật/i));
    fireEvent.change(screen.getByLabelText(/Lý do khiếu nại/i), { target: { value: 'a'.repeat(30) } });
    fireEvent.click(screen.getByText('Add camera photo'));
    fireEvent.click(screen.getByRole('button', { name: /Gửi xác minh/i }));

    await waitFor(() => expect(mocks.fetchApi).toHaveBeenCalledWith('/api/project-governance/challenges', expect.objectContaining({ method: 'POST' })));
    expect(mocks.submitConfirmed).not.toHaveBeenCalled();
  });

  it('shows a dismissible popup when field verification submission fails', async () => {
    mocks.submitConfirmed.mockRejectedValueOnce({ message: 'Không thể ghi nhận xác minh thực địa.', errorCode: 'INTERNAL_ERROR' });
    render(<AuditorListingVerificationForm projectId="project-1" projectName="Project 1" onCompleted={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText(/Dự án đúng với sự thật/i));
    fireEvent.click(screen.getByText('Add camera photo'));
    fireEvent.click(screen.getByRole('button', { name: /Gửi xác minh/i }));

    const popup = await screen.findByRole('alertdialog');
    expect(popup).toHaveTextContent('Không thể ghi nhận xác minh thực địa.');
    fireEvent.click(screen.getByRole('button', { name: 'Đã hiểu' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('uses the field-verification fallback message when the API error has no message', async () => {
    mocks.submitConfirmed.mockRejectedValueOnce({ errorCode: 'INTERNAL_ERROR' });
    render(<AuditorListingVerificationForm projectId="project-1" projectName="Project 1" onCompleted={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText(/Dự án đúng với sự thật/i));
    fireEvent.click(screen.getByText('Add camera photo'));
    fireEvent.click(screen.getByRole('button', { name: /Gửi xác minh/i }));

    expect(await screen.findByRole('alertdialog')).toHaveTextContent('Không thể ghi nhận xác minh thực địa.');
  });

  it('refreshes the access token and retries once after unauthenticated submission', async () => {
    mocks.submitConfirmed
      // Reverse proxy có thể chuyển lỗi xác thực thành 500 nhưng vẫn giữ errorCode chuẩn.
      .mockRejectedValueOnce({ message: 'Thiếu access token hợp lệ.', errorCode: 'UNAUTHENTICATED', statusCode: 500 })
      .mockResolvedValueOnce(undefined);
    mocks.refreshAuthSession.mockResolvedValueOnce({ status: 'REFRESHED', accessToken: 'refreshed-token' });
    render(<AuditorListingVerificationForm projectId="project-1" projectName="Project 1" onCompleted={vi.fn().mockResolvedValue(undefined)} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText(/Dự án đúng với sự thật/i));
    fireEvent.click(screen.getByText('Add camera photo'));
    fireEvent.click(screen.getByRole('button', { name: /Gửi xác minh/i }));

    await waitFor(() => expect(mocks.submitConfirmed).toHaveBeenCalledTimes(2));
    expect(mocks.submitConfirmed).toHaveBeenNthCalledWith(1, 'auditor-token', expect.any(Object));
    expect(mocks.submitConfirmed).toHaveBeenNthCalledWith(2, 'refreshed-token', expect.any(Object));
    expect(mocks.refreshAuthSession).toHaveBeenCalledOnce();
  });

  it('refreshes before the first request when the access token is missing in storage', async () => {
    mocks.readAuthSession.mockReturnValue({ accessToken: '' });
    mocks.refreshAuthSession.mockResolvedValueOnce({ status: 'REFRESHED', accessToken: 'refreshed-token' });
    mocks.submitConfirmed.mockResolvedValueOnce(undefined);
    render(<AuditorListingVerificationForm projectId="project-1" projectName="Project 1" onCompleted={vi.fn().mockResolvedValue(undefined)} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText(/Dự án đúng với sự thật/i));
    fireEvent.click(screen.getByText('Add camera photo'));
    fireEvent.click(screen.getByRole('button', { name: /Gửi xác minh/i }));

    await waitFor(() => expect(mocks.submitConfirmed).toHaveBeenCalledOnce());
    expect(mocks.submitConfirmed).toHaveBeenCalledWith('refreshed-token', expect.any(Object));
    expect(mocks.refreshAuthSession).toHaveBeenCalledOnce();
  });
});
