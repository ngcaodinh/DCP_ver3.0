import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const { mockFetchApi, mockReadAuthSession, mockFetch, mockBuildApiUrl } = vi.hoisted(() => ({
  mockFetchApi: vi.fn(),
  mockReadAuthSession: vi.fn(),
  mockFetch: vi.fn(),
  mockBuildApiUrl: vi.fn((pathname: string) => `http://api.test${pathname}`)
}));

vi.mock('@/app/utils/apiClient', () => ({
  buildApiUrl: mockBuildApiUrl,
  fetchApi: mockFetchApi
}));

vi.mock('@/app/utils/authSession', () => ({
  readAuthSession: mockReadAuthSession
}));

vi.mock('@/app/components/common/IpfsEvidencePreviewCard', () => ({
  default: ({ fileName }: { fileName: string }) => <div>{fileName}</div>
}));

vi.mock('@/app/components/regulatoryBodies/tailwind/SybilManagementPanel', () => ({
  default: () => <div>Sybil panel</div>
}));

import NonDashboardPanel from '@/app/components/regulatoryBodies/tailwind/NonDashboardPanel';

/** Tạo hai record cùng response pending để kiểm tra cả queue KYC và bank account. */
function createPendingRecords(): Record<string, unknown>[] {
  return [
    {
      submissionId: 'foundation-001',
      organizationId: 'FOUNDATION:ABC12345',
      organizationName: 'Quỹ An Tâm',
      organizationCategory: 'FOUNDATION',
      legalRegistrationNumber: 'ABC12345',
      submittedAt: '2026-08-18T00:00:00.000Z',
      files: [],
      beneficiaryBankAccount: {
        bankName: 'Vietcombank',
        bankAccountNumber: '1234567890',
        accountHolderName: 'QUY AN TAM',
        branchName: null
      }
    },
    {
      submissionId: 'ngo-001',
      organizationId: 'NGO:001',
      organizationName: 'NGO Legacy',
      organizationCategory: 'NGO',
      legalRegistrationNumber: 'NGO001',
      submittedAt: '2026-08-18T00:00:00.000Z',
      files: [],
      beneficiaryBankAccount: {
        bankName: 'BIDV',
        bankAccountNumber: '9876543210',
        accountHolderName: 'NGO LEGACY',
        branchName: null
      }
    }
  ];
}

describe('legacy regulatory queues', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);
    mockReadAuthSession.mockReturnValue({ accessToken: 'regulatory-token' });
    mockFetchApi.mockResolvedValue({ data: { submissions: createPendingRecords() } });
    mockFetch.mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue({ submissions: createPendingRecords() }) });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps FOUNDATION out of the legacy KYC queue while preserving NGO records', async () => {
    render(<NonDashboardPanel selectedPageKey="kyc" />);

    await waitFor(() => expect(screen.getAllByText('NGO Legacy').length).toBeGreaterThan(0));
    expect(screen.queryByText('Quỹ An Tâm')).not.toBeInTheDocument();
  });

  it('keeps FOUNDATION out of the legacy bank-account queue while preserving NGO records', async () => {
    render(<NonDashboardPanel selectedPageKey="bankAccountApproval" />);

    await waitFor(() => expect(screen.getAllByText('NGO Legacy').length).toBeGreaterThan(0));
    expect(screen.queryByText('Quỹ An Tâm')).not.toBeInTheDocument();
  });

  it('uses the parent verified token when the bank-account tab is mounted again', async () => {
    mockReadAuthSession.mockReturnValue({ accessToken: '' });

    render(<NonDashboardPanel accessToken="verified-regulatory-token" selectedPageKey="bankAccountApproval" />);

    await waitFor(() => expect(screen.getAllByText('NGO Legacy').length).toBeGreaterThan(0));
    expect(screen.queryByText('Bạn cần đăng nhập tài khoản cơ quan giám sát để duyệt tài khoản ngân hàng.')).not.toBeInTheDocument();
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/auth/organization/kyc-submissions/pending'),
      expect.objectContaining({
        headers: { Authorization: 'Bearer verified-regulatory-token' }
      })
    );
  });
});
