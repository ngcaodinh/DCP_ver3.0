import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/app/components/common/IpfsEvidencePreviewCard', () => ({
  default: () => null
}));

import { CreateProjectModal } from '@/app/components/organizations/OrganizationsSections';

describe('CreateProjectModal', () => {
  it('hiển thị nhãn chọn thời điểm kết thúc ngay trước ô ngày giờ', () => {
    render(<CreateProjectModal onClose={vi.fn()} onProjectCreated={vi.fn()} />);

    const deadlineInput = screen.getByLabelText('Chọn thời điểm kết thúc');

    expect(deadlineInput).toHaveAttribute('type', 'datetime-local');
    expect(deadlineInput.previousElementSibling).toHaveTextContent('Chọn thời điểm kết thúc');
    expect(screen.getByRole('dialog')).toContainElement(deadlineInput);
  });

  it('giới hạn chiều cao modal và tách vùng cuộn của form khỏi nền phía sau', () => {
    const { unmount } = render(<CreateProjectModal onClose={vi.fn()} onProjectCreated={vi.fn()} />);
    const dialog = screen.getByRole('dialog');
    const form = dialog.querySelector('form');

    expect(dialog).toHaveClass('max-h-[calc(100vh-1rem)]', 'flex-col', 'overflow-hidden');
    expect(form).toHaveClass('min-h-0', 'overflow-y-auto', 'overscroll-contain');
    expect(document.body.style.overflow).toBe('hidden');

    unmount();

    expect(document.body.style.overflow).toBe('');
  });

  it('ẩn trạng thái tổng khi chưa nhập và chỉ báo phần còn thiếu khi tổng chưa đủ', () => {
    render(<CreateProjectModal onClose={vi.fn()} onProjectCreated={vi.fn()} />);

    expect(screen.queryByText(/Tổng phân bổ:/i)).not.toBeInTheDocument();

    fireEvent.change(screen.getAllByPlaceholderText('%')[0], { target: { value: '99' } });

    expect(screen.getByText('Tổng phân bổ: 99% · Còn thiếu 1%')).toBeInTheDocument();
    expect(screen.getByText('Nhập tỷ lệ cho đủ 3 mốc.')).toBeInTheDocument();
  });

  it('ẩn thông báo tổng và lỗi kế hoạch khi ba mốc đã hợp lệ', () => {
    render(<CreateProjectModal onClose={vi.fn()} onProjectCreated={vi.fn()} />);

    const percentageInputList = screen.getAllByPlaceholderText('%');
    const descriptionInputList = screen.getAllByPlaceholderText('Mô tả hạng mục (10–500 ký tự)');

    ['25', '25', '50'].forEach((value, index) => {
      fireEvent.change(percentageInputList[index], { target: { value } });
      fireEvent.change(descriptionInputList[index], { target: { value: 'Mô tả mốc hợp lệ' } });
    });

    expect(screen.queryByText(/Tổng phân bổ:/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Mỗi mô tả cần từ 10–500 ký tự/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Nhập tỷ lệ cho đủ 3 mốc/i)).not.toBeInTheDocument();
  });
});
