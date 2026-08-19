import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const { mockUseFoundationKycStatus } = vi.hoisted(() => ({
  mockUseFoundationKycStatus: vi.fn()
}));

vi.mock('@/app/hooks/useFoundationKycStatus', () => ({
  useFoundationKycStatus: mockUseFoundationKycStatus
}));

import FoundationKycVerifiedBadge from '@/app/components/foundationKyc/FoundationKycVerifiedBadge';

describe('FoundationKycVerifiedBadge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders only for a verified status with a valid timestamp', () => {
    mockUseFoundationKycStatus.mockReturnValue({
      data: {
        status: 'VERIFIED',
        verifiedAt: '2026-08-18T00:00:00.000Z',
        organizationName: 'Quỹ An Tâm'
      },
      isError: false
    });

    render(<FoundationKycVerifiedBadge />);

    expect(screen.getByText(/Quỹ An Tâm/)).toBeInTheDocument();
    expect(screen.getByText(/Tài khoản nhận quyên góp đã được xác minh/)).toBeInTheDocument();
  });

  it.each([
    { data: { status: 'NOT_VERIFIED', verifiedAt: null, organizationName: null }, isError: false },
    { data: { status: 'VERIFIED', verifiedAt: null, organizationName: 'Quỹ An Tâm' }, isError: false },
    { data: { status: 'VERIFIED', verifiedAt: 'invalid-date', organizationName: 'Quỹ An Tâm' }, isError: false },
    { data: undefined, isError: true }
  ])('does not render for an unsafe or incomplete public status', statusQuery => {
    mockUseFoundationKycStatus.mockReturnValue(statusQuery);

    const { container } = render(<FoundationKycVerifiedBadge />);

    expect(container).toBeEmptyDOMElement();
  });
});
