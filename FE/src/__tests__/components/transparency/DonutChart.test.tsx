/**
 * Tests cho DonutChart — D4.
 * Tập trung vào edge case: tổng = 0 (vẽ vòng nền, aria-label "chưa có dữ liệu")
 * và remaining < 0 (kẹp về 0, không vỡ dasharray).
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import DonutChart from '@/app/components/transparency/DonutChart';

describe('DonutChart', () => {
  it('tổng = 0 → aria-label báo chưa có dữ liệu và không vẽ segment màu', () => {
    const { container } = render(
      <DonutChart totalRaised={0} totalDisbursed={0} remaining={0} />
    );
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('aria-label')).toContain('chưa có dữ liệu');
    // Chỉ có 1 vòng nền (track), không có circle segment nào có strokeDasharray.
    const dashedCircles = container.querySelectorAll('circle[stroke-dasharray]');
    expect(dashedCircles).toHaveLength(0);
  });

  it('có dữ liệu → aria-label chứa số liệu huy động/giải ngân/còn lại', () => {
    const { container } = render(
      <DonutChart totalRaised={1000000} totalDisbursed={400000} remaining={600000} />
    );
    const svg = container.querySelector('svg');
    const label = svg?.getAttribute('aria-label') ?? '';
    expect(label).toContain('huy động');
    expect(label).toContain('1.000.000');
    // Hai segment (giải ngân + còn lại) đều > 0 → có 2 cung dasharray.
    const dashedCircles = container.querySelectorAll('circle[stroke-dasharray]');
    expect(dashedCircles).toHaveLength(2);
  });

  it('remaining < 0 → kẹp về 0, chỉ vẽ segment giải ngân', () => {
    const { container } = render(
      <DonutChart totalRaised={500000} totalDisbursed={800000} remaining={-300000} />
    );
    // remaining bị kẹp 0 → chú giải "Còn lại" hiển thị 0.
    expect(screen.getByText('Còn lại')).toBeInTheDocument();
    // Chỉ segment giải ngân > 0 → 1 cung dasharray.
    const dashedCircles = container.querySelectorAll('circle[stroke-dasharray]');
    expect(dashedCircles).toHaveLength(1);
  });

  it('totalRaised = 0 nhưng totalDisbursed > 0 → fallback chartTotal, vẫn vẽ segment giải ngân', () => {
    // Nhánh chartTotal = Math.max(totalRaised, segmentSum): raised=0 nhưng segmentSum>0 → không rỗng.
    const { container } = render(
      <DonutChart totalRaised={0} totalDisbursed={200000} remaining={0} />
    );
    const svg = container.querySelector('svg');
    // Có dữ liệu segment → aria-label KHÔNG phải "chưa có dữ liệu".
    expect(svg?.getAttribute('aria-label')).not.toContain('chưa có dữ liệu');
    const dashedCircles = container.querySelectorAll('circle[stroke-dasharray]');
    expect(dashedCircles).toHaveLength(1);
  });

  it('disbursed = 0 nhưng remaining > 0 → chỉ vẽ segment còn lại', () => {
    const { container } = render(
      <DonutChart totalRaised={1000000} totalDisbursed={0} remaining={1000000} />
    );
    // Chỉ segment "còn lại" > 0 → 1 cung dasharray.
    const dashedCircles = container.querySelectorAll('circle[stroke-dasharray]');
    expect(dashedCircles).toHaveLength(1);
  });

  it('totalDisbursed < 0 → kẹp về 0, chú giải giải ngân hiển thị 0', () => {
    const { container } = render(
      <DonutChart totalRaised={1000000} totalDisbursed={-500000} remaining={1000000} />
    );
    // disbursed âm bị kẹp 0 → chỉ còn segment "còn lại".
    const dashedCircles = container.querySelectorAll('circle[stroke-dasharray]');
    expect(dashedCircles).toHaveLength(1);
    // Nhãn chú giải "Đã giải ngân" vẫn render (giá trị 0).
    expect(screen.getByText('Đã giải ngân')).toBeInTheDocument();
  });

  it('render đủ 3 mục chú giải màu (huy động, giải ngân, còn lại)', () => {
    render(<DonutChart totalRaised={1000000} totalDisbursed={400000} remaining={600000} />);
    expect(screen.getByText('Đã huy động')).toBeInTheDocument();
    expect(screen.getByText('Đã giải ngân')).toBeInTheDocument();
    expect(screen.getByText('Còn lại')).toBeInTheDocument();
  });
});
