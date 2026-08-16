import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import SbtPolygonScanLink from '@/app/components/impactSbt/SbtPolygonScanLink';

describe('SbtPolygonScanLink', () => {
  it('hiển thị text mờ khi chưa có transaction hash', () => {
    render(<SbtPolygonScanLink transactionHash={null} />);

    expect(screen.getByTestId('sbt-polygon-scan-missing')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('dựng link Amoy PolygonScan và encode transaction hash', () => {
    render(<SbtPolygonScanLink transactionHash="0xabc/def" />);

    expect(screen.getByRole('link', { name: 'Xem trên PolygonScan' })).toHaveAttribute(
      'href',
      'https://amoy.polygonscan.com/tx/0xabc%2Fdef'
    );
  });
});
