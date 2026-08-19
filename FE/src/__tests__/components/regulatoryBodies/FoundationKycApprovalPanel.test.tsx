import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const { mockFetchApi, mockReadAuthSession } = vi.hoisted(() => ({
  mockFetchApi: vi.fn(),
  mockReadAuthSession: vi.fn()
}));

vi.mock('@/app/utils/apiClient', () => ({
  buildApiUrl: vi.fn((pathname: string) => `http://api.test${pathname}`),
  fetchApi: mockFetchApi
}));

vi.mock('@/app/utils/authSession', () => ({
  readAuthSession: mockReadAuthSession
}));

vi.mock('@/app/components/common/IpfsEvidencePreviewCard', () => ({
  default: ({ fileName }: { fileName: string }) => <div>{fileName}</div>
}));

import FoundationKycApprovalPanel from '@/app/components/regulatoryBodies/tailwind/FoundationKycApprovalPanel';

/** Tạo response danh sách pháp nhân có dữ liệu ngân hàng để kiểm chứng panel Regulatory. */
function createPendingResponse(): { submissions: unknown[] } {
  return {
      submissions: [
        {
          submissionId: 'foundation-001',
          organizationId: 'FOUNDATION:ABC12345',
          organizationName: 'Quỹ An Tâm',
          legalRegistrationNumber: 'ABC12345',
          taxIdentificationNumber: '0101234567',
          officialWebsite: null,
          organizationDescription: 'Quỹ hỗ trợ cộng đồng trong các chương trình an sinh.',
          organizationCategory: 'FOUNDATION',
          version: 1,
          status: 'PENDING_REVIEW',
          submittedAt: '2026-08-18T00:00:00.000Z',
          files: [{ cid: 'bafy-001', fileName: 'license.pdf', mimeType: 'application/pdf', fileSize: 100, documentType: 'LEGAL_DOCUMENT' }],
          beneficiaryBankAccount: {
            bankName: 'Vietcombank',
            bankAccountNumber: '1234567890',
            accountHolderName: 'QUY AN TAM',
            branchName: 'Ha Noi'
          }
        },
        {
          submissionId: 'ngo-001',
          organizationName: 'NGO Legacy',
          organizationCategory: 'NGO'
        }
      ]
  };
}

describe('FoundationKycApprovalPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadAuthSession.mockReturnValue({ accessToken: 'regulatory-token' });
    mockFetchApi.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') return Promise.resolve({ data: { accountUpdate: null } });
      return Promise.resolve(createPendingResponse());
    });
  });

  it('shows a reviewable FOUNDATION submission and approves without expecting accountUpdate', async () => {
    render(<FoundationKycApprovalPanel />);

    await waitFor(() => expect(screen.getAllByText('Quỹ An Tâm').length).toBeGreaterThan(0));
    expect(mockFetchApi).toHaveBeenCalledWith(
      'http://api.test/auth/organization/kyc-submissions/foundation',
      expect.objectContaining({ headers: { Authorization: 'Bearer regulatory-token' } })
    );
    expect(screen.queryByText('NGO Legacy')).not.toBeInTheDocument();
    expect(screen.getByText('Vietcombank')).toBeInTheDocument();
    expect(screen.getByText('0101234567')).toBeInTheDocument();
    expect(screen.getByText('Kiểm tra thông tin pháp nhân và tài khoản ngân hàng trước khi xác nhận.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Phê duyệt xác minh' }));
    fireEvent.click(screen.getByRole('button', { name: 'Chắc chắn xác minh' }));

    await waitFor(() => expect(mockFetchApi).toHaveBeenCalledWith(
      'http://api.test/auth/organization/kyc-submissions/foundation-001/review',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ action: 'approve', rejectionReason: undefined })
      })
    ));
    expect(await screen.findByText('Đã duyệt pháp nhân đại diện.')).toBeInTheDocument();
    expect(screen.getAllByText('Đã duyệt').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Phê duyệt xác minh' })).not.toBeInTheDocument();
  });

  it('shows approved and pending foundation submissions together', async () => {
    const pendingResponse = createPendingResponse();
    const foundationSubmission = pendingResponse.submissions[0] as Record<string, unknown>;
    mockFetchApi.mockResolvedValue({
      submissions: [
        { ...foundationSubmission, submissionId: 'foundation-approved', status: 'APPROVED' },
        { ...foundationSubmission, submissionId: 'foundation-pending', status: 'PENDING_REVIEW' }
      ]
    });

    render(<FoundationKycApprovalPanel />);

    await waitFor(() => expect(screen.getAllByText('Đã duyệt').length).toBeGreaterThan(0));
    expect(screen.getAllByText('Chờ duyệt').length).toBeGreaterThan(0);
    expect(screen.getByText('foundation-approved')).toBeInTheDocument();
    expect(screen.getByText('foundation-pending')).toBeInTheDocument();
  });

  it('shows approved legacy public submissions identified by the FOUNDATION organization ID', async () => {
    const legacySubmission = createPendingResponse().submissions[0] as Record<string, unknown>;
    const { organizationCategory: _organizationCategory, ...legacyFoundationSubmission } = legacySubmission;
    mockFetchApi.mockResolvedValue({
      submissions: [{ ...legacyFoundationSubmission, submissionId: 'foundation-legacy-approved', status: 'APPROVED' }]
    });

    render(<FoundationKycApprovalPanel />);

    await waitFor(() => expect(screen.getByText('foundation-legacy-approved')).toBeInTheDocument());
    expect(screen.getAllByText('Đã duyệt').length).toBeGreaterThan(0);
  });

  it('shows an approved legal-entity submission without FOUNDATION identifiers', async () => {
    const representativeSubmission = createPendingResponse().submissions[0] as Record<string, unknown>;
    mockFetchApi.mockResolvedValue({
      submissions: [{
        ...representativeSubmission,
        submissionId: '9c7f0a26-34ed-4076-b1c2-73176c97b04c',
        organizationId: 'legacy-organization-001',
        organizationCategory: 'NGO',
        submittedBy: 'legacy-user-001',
        status: 'APPROVED'
      }]
    });

    render(<FoundationKycApprovalPanel />);

    await waitFor(() => expect(screen.getByText('9c7f0a26-34ed-4076-b1c2-73176c97b04c')).toBeInTheDocument());
    expect(screen.getAllByText('Đã duyệt').length).toBeGreaterThan(0);
  });

  it('blocks rejection without a reason before making a PATCH request', async () => {
    render(<FoundationKycApprovalPanel />);
    await waitFor(() => expect(screen.getAllByText('Quỹ An Tâm').length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole('button', { name: 'Từ chối' }));

    expect(screen.getByRole('alert')).toHaveTextContent('Vui lòng nhập lý do từ chối');
    expect(mockFetchApi.mock.calls.some(call => call[1]?.method === 'PATCH')).toBe(false);
  });
});
