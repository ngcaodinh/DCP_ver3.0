import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const { mockFetchApi } = vi.hoisted(() => ({ mockFetchApi: vi.fn() }));

interface Deferred<T> { promise: Promise<T>; resolve: (value: T) => void; }

/** Tạo promise điều khiển được thứ tự hoàn tất để kiểm tra phản hồi mạng về trễ. */
function createDeferred<T>(): Deferred<T> {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>(resolve => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}

vi.mock('@/app/utils/apiClient', () => ({
  buildApiUrl: (path: string) => path,
  fetchApi: mockFetchApi,
  getApiErrorMessage: () => 'Không thể tải dữ liệu.'
}));
vi.mock('@/app/utils/authSession', () => ({ readAuthSession: () => ({ accessToken: 'token' }) }));
vi.mock('@/app/components/oracle/GeofenceMapLazy', () => ({ GeofenceMapLazy: () => <div>GPS map</div> }));

import { ActiveProjectsPanel } from '@/app/components/governance/ActiveProjectsPanel';
import { DisbursementVotingPanel } from '@/app/components/governance/DisbursementVotingPanel';

describe('ExecutiveCommitteePanels', () => {
  beforeEach(() => {
    mockFetchApi.mockReset();
  });

  it('hiển thị empty state thay vì coi danh sách dự án đang tải là lỗi', async () => {
    mockFetchApi.mockResolvedValueOnce({ data: { items: [], nextCursor: null } });

    render(<ActiveProjectsPanel />);

    expect(await screen.findByText('Chưa có dự án cần theo dõi')).toBeInTheDocument();
  });

  it('thông báo lỗi tải danh sách dự án cho người dùng', async () => {
    mockFetchApi.mockRejectedValueOnce(new Error('network failure'));

    render(<ActiveProjectsPanel />);

    expect(await screen.findByRole('status')).toHaveTextContent('Không thể tải dữ liệu.');
  });

  it('hiển thị empty state cho hàng chờ giải ngân', async () => {
    mockFetchApi.mockResolvedValueOnce({ data: [] });

    render(<DisbursementVotingPanel />);

    expect(await screen.findByText('Không có yêu cầu cần biểu quyết')).toBeInTheDocument();
  });

  it('không gửi phiếu giải ngân khi lý do chưa đạt độ dài tối thiểu', async () => {
    mockFetchApi.mockResolvedValueOnce({
      data: [{
        committeeCase: { requestId: 'request-1', votes: [] },
        disbursement: { requestId: 'request-1', amount: 100, usagePurpose: 'Mua thiết bị y tế', requestMode: 'STANDARD', timeoutDeadline: null },
        monitoring: { projectId: 'project-1', highestDeviationLevel: 'INSIDE', evidencePhotos: [] }
      }]
    });

    render(<DisbursementVotingPanel />);

    fireEvent.click(await screen.findByRole('button', { name: 'Đồng ý giải ngân' }));

    await waitFor(() => expect(screen.getByText(/ít nhất 10 ký tự/i)).toBeInTheDocument());
    expect(mockFetchApi).toHaveBeenCalledTimes(1);
  });

  it('requests the server-issued signing payload before posting a valid disbursement vote', async () => {
    const pendingCase = {
      committeeCase: { requestId: 'request-1', votes: [] },
      disbursement: { requestId: 'request-1', amount: 100, usagePurpose: 'Medical equipment', requestMode: 'STANDARD', timeoutDeadline: null },
      monitoring: { projectId: 'project-1', highestDeviationLevel: 'INSIDE', evidencePhotos: [] }
    };
    mockFetchApi.mockImplementation((url: string) => {
      if (url.includes('/signing-payload')) return Promise.resolve({ data: null });
      if (url.endsWith('/vote')) return Promise.resolve({ data: {} });
      return Promise.resolve({ data: [pendingCase] });
    });

    render(<DisbursementVotingPanel />);

    fireEvent.change(await screen.findByRole('textbox'), { target: { value: 'Sufficient vote reason' } });
    fireEvent.click(screen.getAllByRole('button')[0]);

    await waitFor(() => expect(mockFetchApi).toHaveBeenCalledWith(
      '/api/disbursement/executive/request-1/signing-payload',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ decision: 'APPROVE', reason: 'Sufficient vote reason' }) })
    ));
    await waitFor(() => expect(mockFetchApi).toHaveBeenCalledWith(
      '/api/disbursement/executive/request-1/vote',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ decision: 'APPROVE', reason: 'Sufficient vote reason', gpsRiskAcknowledged: false })
      })
    ));
  });

  it('chỉ hiển thị bằng chứng của dự án được chọn gần nhất khi response về không theo thứ tự', async () => {
    type ProjectDetail = { evidencePhotos: Array<{ cid: string; source: string; deviationLevel: 'INSIDE'; distanceMeters: number | null; accuracyMeters: number; isLowAccuracyOverride: boolean; lowAccuracyReason: string | null }>; highestDeviationLevel: 'INSIDE' };
    const firstDetail = createDeferred<{ data: ProjectDetail }>();
    const secondDetail = createDeferred<{ data: ProjectDetail }>();
    mockFetchApi.mockImplementation((url: string) => {
      if (url.includes('active-projects?')) return Promise.resolve({ data: { items: [
        { projectId: 'project-one', name: 'Dự án Một', organizationName: 'Tổ chức A', fieldReportCount: 0, pendingDisbursementCount: 0 },
        { projectId: 'project-two', name: 'Dự án Hai', organizationName: 'Tổ chức B', fieldReportCount: 0, pendingDisbursementCount: 0 }
      ], nextCursor: null } });
      return url.endsWith('/project-one') ? firstDetail.promise : secondDetail.promise;
    });

    render(<ActiveProjectsPanel />);

    fireEvent.click(await screen.findByRole('button', { name: /Dự án Một/i }));
    fireEvent.click(screen.getByRole('button', { name: /Dự án Hai/i }));
    secondDetail.resolve({ data: { highestDeviationLevel: 'INSIDE', evidencePhotos: [{ cid: 'cid-second', source: 'AUDITOR_FIELD_REPORT', deviationLevel: 'INSIDE', distanceMeters: null, accuracyMeters: 0, isLowAccuracyOverride: false, lowAccuracyReason: null }] } });
    expect(await screen.findByText(/CID: cid-second/i)).toBeInTheDocument();

    firstDetail.resolve({ data: { highestDeviationLevel: 'INSIDE', evidencePhotos: [{ cid: 'cid-first', source: 'AUDITOR_FIELD_REPORT', deviationLevel: 'INSIDE', distanceMeters: null, accuracyMeters: 0, isLowAccuracyOverride: false, lowAccuracyReason: null }] } });
    await waitFor(() => expect(screen.queryByText(/CID: cid-first/i)).not.toBeInTheDocument());
  });
});
