import { describe, expect, it, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import TransferDetailPage from '@/app/admin/transfers/[transferId]/page';
import { fetchApi } from '@/app/utils/apiClient';
import { readAuthSession } from '@/app/utils/authSession';

const routerMock = { push: vi.fn(), replace: vi.fn(), back: vi.fn() };

vi.mock('next/navigation', () => ({
  useParams: () => ({ transferId: 'DS/request-001' }),
  useRouter: () => routerMock
}));

vi.mock('@/app/utils/apiClient', () => ({
  buildApiUrl: vi.fn((path: string) => path),
  fetchApi: vi.fn()
}));

vi.mock('@/app/utils/authSession', () => ({
  readAuthSession: vi.fn()
}));

/** Tạo detail DTO có queue/SLA và timeline retry đủ để kiểm tra render contract. */
function createDetail() {
  return {
    requestId: 'DS/request-001',
    projectId: 'project-001',
    organizationId: 'org-001',
    amount: 1000,
    requestMode: 'NORMAL' as const,
    emergencyReason: null,
    status: 'APPROVED',
    payosTransferStatus: 'MANUAL_REVIEW',
    payosTransferAttemptCount: 2,
    payosTransferLastError: null,
    queueId: 'MRQ-001',
    reviewCycle: 2,
    assignedAdminId: 'admin-001',
    assignmentMethod: 'ROUND_ROBIN' as const,
    slaDeadline: '2026-08-01T00:00:00.000Z',
    escalatedAt: null,
    nextRetryAt: null,
    beneficiaryBankAccount: {
      bankName: 'VCB',
      bankAccountNumber: '******7890',
      accountHolderName: 'Ng**********'
    },
    updatedAt: '2026-08-01T00:00:00.000Z',
    createdAt: '2026-08-01T00:00:00.000Z',
    transferLogs: [
      { transferLogId: 'log-2', attemptNumber: 2, payosTransferId: null, amount: 1000, status: 'FAILED', errorMessage: 'failed', startedAt: '2026-08-01T00:02:00.000Z', completedAt: '2026-08-01T00:03:00.000Z', durationMs: 1000 },
      { transferLogId: 'log-1', attemptNumber: 1, payosTransferId: null, amount: 1000, status: 'PROCESSING', errorMessage: null, startedAt: '2026-08-01T00:00:00.000Z', completedAt: '2026-08-01T00:01:00.000Z', durationMs: 1000 }
    ],
    auditLogs: []
  };
}

describe('TransferDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readAuthSession).mockReturnValue({ accessToken: 'token-001', userRole: 'admin' });
    vi.mocked(fetchApi).mockResolvedValue({ success: true, message: '', data: createDetail() } as never);
  });

  it('guard non-admin trước API detail', async () => {
    vi.mocked(readAuthSession).mockReturnValue({ accessToken: 'token-001', userRole: 'donor' });
    render(<TransferDetailPage />);

    await waitFor(() => expect(routerMock.replace).toHaveBeenCalledWith('/unauthorized'));
    expect(fetchApi).not.toHaveBeenCalled();
  });

  it('redirect login trước API detail khi thiếu access token', async () => {
    vi.mocked(readAuthSession).mockReturnValue({ accessToken: '' });
    render(<TransferDetailPage />);

    await waitFor(() => expect(routerMock.replace).toHaveBeenCalledWith('/login'));
    expect(fetchApi).not.toHaveBeenCalled();
  });

  it('encode requestId trong endpoint và render queue/SLA/timeline theo attemptNumber', async () => {
    render(<TransferDetailPage />);

    await waitFor(() => expect(screen.getByText('MRQ-001')).toBeInTheDocument());
    expect(fetchApi).toHaveBeenCalledWith(
      '/api/disbursements/DS%2Frequest-001/detail',
      { headers: { Authorization: 'Bearer token-001' } }
    );
    expect(screen.getByText('Quá hạn SLA')).toBeInTheDocument();
    expect(screen.getByText('2 lần thử')).toBeInTheDocument();
  });

  it('chỉ gọi reveal sau confirm audit', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<TransferDetailPage />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Hiện số tài khoản' })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Hiện số tài khoản' }));
    expect(fetchApi).toHaveBeenCalledTimes(1);
    confirmSpy.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Hiện số tài khoản' }));
    await waitFor(() => expect(fetchApi).toHaveBeenCalledTimes(2));
    expect(fetchApi).toHaveBeenLastCalledWith(
      '/api/disbursements/DS%2Frequest-001/detail?revealBankAccount=true',
      { headers: { Authorization: 'Bearer token-001' } }
    );
    fireEvent.click(screen.getByRole('button', { name: 'Ẩn số tài khoản' }));
    await waitFor(() => expect(fetchApi).toHaveBeenCalledTimes(3));
    expect(fetchApi).toHaveBeenLastCalledWith(
      '/api/disbursements/DS%2Frequest-001/detail',
      { headers: { Authorization: 'Bearer token-001' } }
    );
    expect(screen.getByRole('button', { name: 'Hiện số tài khoản' })).toBeInTheDocument();
    confirmSpy.mockRestore();
  });

  it.each([
    [{ statusCode: 400, errorCode: 'INVALID_STATUS_TRANSITION' }, 'dữ liệu chưa backfill A3'],
    [{ statusCode: 404, errorCode: 'NOT_FOUND' }, 'Không tìm thấy disbursement này.'],
    [{ statusCode: 401, errorCode: 'UNAUTHORIZED' }, 'authVersion'],
    [{ statusCode: 403, errorCode: 'FORBIDDEN' }, 'không còn quyền admin'],
    [{ statusCode: 503, errorCode: 'INTERNAL_ERROR' }, 'tạm thời không khả dụng'],
    [{ statusCode: 418, errorCode: 'TEAPOT' }, 'Không thể tải chi tiết transfer.']
  ])('phân loại lỗi detail %s', async (error, expectedMessage) => {
    vi.mocked(fetchApi).mockRejectedValue(error);
    render(<TransferDetailPage />);

    await waitFor(() => expect(screen.getByText(new RegExp(expectedMessage, 'i'))).toBeInTheDocument());
  });
});
