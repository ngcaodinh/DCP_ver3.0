import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ExecutiveCommitteeNavigation } from '@/app/components/governance/ExecutiveCommitteeNavigation';

describe('ExecutiveCommitteeNavigation', () => {
  it('công bố tab đang chọn và cho phép thao tác bằng nút semantic', () => {
    const onSelect = vi.fn();
    render(<ExecutiveCommitteeNavigation activeTab="ACTIVE_PROJECTS" onSelect={onSelect} />);

    expect(screen.getByRole('tab', { name: 'Dự án đang hoạt động' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Dự án đang hoạt động' })).toHaveAttribute('aria-controls', 'executive-ACTIVE_PROJECTS-panel');
    fireEvent.click(screen.getByRole('tab', { name: 'Duyệt giải ngân' }));

    expect(onSelect).toHaveBeenCalledWith('DISBURSEMENT');
  });
});
