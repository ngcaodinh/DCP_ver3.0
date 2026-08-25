import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/app/components/common/evidenceCamera/EvidenceCameraCapture', () => ({
  EvidenceCameraCapture: () => <div data-testid="evidence-camera">Camera minh chứng</div>
}));

import AuditorFieldReportForm from '@/app/components/governance/AuditorFieldReportForm';

describe('AuditorFieldReportForm', () => {
  it('hiển thị trạng thái rỗng khi không có dự án đủ điều kiện', () => {
    render(<AuditorFieldReportForm projects={[]} onSubmitted={vi.fn()} />);

    expect(screen.getByText('Chưa có dự án đủ điều kiện lập biên bản')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Nộp biên bản một lần' })).not.toBeInTheDocument();
  });

  it('hiển thị dự án ACTIVE thiếu mốc cùng lý do không thể lập biên bản', () => {
    render(<AuditorFieldReportForm projects={[{
      projectId: 'project-without-plan',
      name: 'Dự án thiếu kế hoạch',
      milestonePlan: [],
      fieldReport: null
    }]} onSubmitted={vi.fn()} />);

    expect(screen.getByText('Dự án thiếu kế hoạch')).toBeInTheDocument();
    expect(screen.getByText('Chưa có kế hoạch cột mốc để đối chiếu.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Nộp biên bản một lần' })).not.toBeInTheDocument();
  });

  it('cho phép chọn dự án đủ điều kiện rồi hiển thị mốc và camera minh chứng', () => {
    render(<AuditorFieldReportForm projects={[{
      projectId: 'project-1',
      name: 'Trường học vùng cao',
      milestonePlan: [{ milestoneIndex: 1, milestoneKey: 'M1_ADVANCE', description: 'Đối chiếu tạm ứng' }],
      fieldReport: null
    }]} onSubmitted={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('Dự án cần kiểm tra'), { target: { value: 'project-1' } });

    expect(screen.getByRole('checkbox')).toHaveAccessibleName('M1_ADVANCE: Đối chiếu tạm ứng');
    expect(screen.getByTestId('evidence-camera')).toBeInTheDocument();
  });
});
