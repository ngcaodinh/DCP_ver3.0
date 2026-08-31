import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EvidenceDeviationBadge } from '@/app/components/governance/EvidenceDeviationBadge';

describe('EvidenceDeviationBadge', () => {
  it.each([
    ['INSIDE', 'Trong vùng dự án', 'border-emerald-200'],
    ['WITHIN_ACCURACY', 'Trong phạm vi sai số thiết bị', 'border-amber-200'],
    ['DEVIATED', 'Ảnh chụp lệch vùng dự án', 'border-orange-200'],
    ['CRITICAL', 'Lệch vị trí nghiêm trọng', 'border-rose-200'],
    ['NO_GEOFENCE', 'Chưa thiết lập vùng địa lý', 'border-slate-200']
  ] as const)('render đúng metadata màu cho mức %s', (deviationLevel, label, className) => {
    const { unmount } = render(<EvidenceDeviationBadge deviationLevel={deviationLevel} distanceMeters={42.4} accuracyMeters={7.6} />);

    const badge = screen.getByText(new RegExp(label));
    expect(badge).toHaveClass(className);
    unmount();
  });

  it('chỉ trình bày deviationLevel backend gửi, không tự phân loại lại theo distance', () => {
    render(<EvidenceDeviationBadge deviationLevel="INSIDE" distanceMeters={9999} accuracyMeters={0} />);

    expect(screen.getByText(/Trong vùng dự án/)).toHaveClass('border-emerald-200');
    expect(screen.queryByText(/Lệch vị trí nghiêm trọng/)).not.toBeInTheDocument();
  });

  it('không hiển thị khoảng cách 0 m tới ranh giới khi ảnh nằm trong vùng dự án', () => {
    render(<EvidenceDeviationBadge deviationLevel="INSIDE" distanceMeters={0} accuracyMeters={88} />);

    expect(screen.getByText(/Trong vùng dự án/)).not.toHaveTextContent('0 m');
  });
});
