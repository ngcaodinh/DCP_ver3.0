import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import SbtStatusBanner from '@/app/components/impactSbt/SbtStatusBanner';

describe('SbtStatusBanner', () => {
  it('hiển thị banner đỏ và lý do khi token bị REVOKED', () => {
    render(<SbtStatusBanner tokenStatus="REVOKED" reason="Minh chứng bị phát hiện giả mạo" />);

    expect(screen.getByRole('alert')).toHaveTextContent('Minh chứng bị phát hiện giả mạo');
  });

  it('dùng lý do fallback khi token bị REVOKED nhưng không có reason', () => {
    render(<SbtStatusBanner tokenStatus="REVOKED" reason={null} />);

    expect(screen.getByRole('alert')).toHaveTextContent('Không có lý do được ghi nhận.');
  });

  it('không hiển thị banner cho các trạng thái khác REVOKED', () => {
    render(<SbtStatusBanner tokenStatus="ACTIVE" reason="Không dùng" />);

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
