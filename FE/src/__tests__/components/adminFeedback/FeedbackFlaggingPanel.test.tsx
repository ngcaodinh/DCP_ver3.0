import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { FeedbackFlaggingPanel } from '@/app/components/adminFeedback/FeedbackFlaggingPanel';
import type { FlaggedFeedbackItem } from '@/app/components/adminFeedback/types';

function item(overrides: Partial<FlaggedFeedbackItem> = {}): FlaggedFeedbackItem {
  return {
    feedbackId: 'fb-1',
    projectId: 'project-1',
    projectName: 'Dự án cộng đồng',
    rating: 5,
    comment: 'Một comment ngắn',
    submittedAt: '2026-08-10T03:12:00.000Z',
    location: 'Quảng Bình',
    riskScore: 7,
    isFlagged: true,
    source: 'public',
    flagReason: { kind: 'AUTO', indicators: ['extreme_rating:5', 'gibberish_detected'], adminReason: null, flaggedByAdminId: null, flaggedAt: null },
    ...overrides
  };
}

describe('FeedbackFlaggingPanel', () => {
  it('render đủ 4 cột, 3 nhánh reason và chỉ tô đỏ risk > 8', () => {
    const onViewDetail = vi.fn();
    const onAction = vi.fn();
    render(
      <FeedbackFlaggingPanel
        items={[
          item({ feedbackId: 'fb-9', riskScore: 9 }),
          item({ feedbackId: 'fb-8', riskScore: 8, flagReason: { kind: 'MANUAL', indicators: [], adminReason: 'Admin reason', flaggedByAdminId: 'admin-1', flaggedAt: '2026-08-14T01:00:00.000Z' } }),
          item({ feedbackId: 'fb-7', riskScore: 7, flagReason: { kind: 'UNKNOWN', indicators: [], adminReason: null, flaggedByAdminId: null, flaggedAt: null } })
        ]}
        deletionState="active"
        isLoading={false}
        onViewDetail={onViewDetail}
        onAction={onAction}
      />
    );

    expect(screen.getByText('Project')).toBeInTheDocument();
    expect(screen.getByText('Risk score')).toBeInTheDocument();
    expect(screen.getByText('Flag reason')).toBeInTheDocument();
    expect(screen.getByText('Comment preview')).toBeInTheDocument();
    expect(screen.getByText(/Rating cực đoan \(5 sao\)/)).toBeInTheDocument();
    expect(screen.getByText('Admin reason')).toBeInTheDocument();
    expect(screen.getByText('Không xác định')).toBeInTheDocument();
    expect(screen.getByText('9/10').closest('tr')).toHaveClass('bg-red-50');
    expect(screen.getByText('8/10').closest('tr')).not.toHaveClass('bg-red-50');
    expect(screen.getByText('7/10').closest('tr')).not.toHaveClass('bg-red-50');
    expect(screen.queryAllByRole('button', { name: 'Khôi phục' })).toHaveLength(0);
  });

  it('render tab deleted với countdown cảnh báo và nút Khôi phục', () => {
    const onAction = vi.fn();
    render(
      <FeedbackFlaggingPanel
        items={[item({ daysUntilPurge: 2, isRestorable: true, deletedAt: '2026-08-14T00:00:00.000Z', deleteReason: 'Lý do xoá', deletedByAdminId: 'admin-2' })]}
        deletionState="deleted"
        isLoading={false}
        onViewDetail={vi.fn()}
        onAction={onAction}
      />
    );

    expect(screen.getByText('Còn 2 ngày')).toHaveClass('bg-red-100');
    fireEvent.click(screen.getByRole('button', { name: 'Khôi phục' }));
    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ feedbackId: 'fb-1' }), 'restore', expect.any(HTMLButtonElement));
    expect(screen.queryByRole('button', { name: 'Xoá' })).not.toBeInTheDocument();
  });

  it('vô hiệu hóa khôi phục và hiển thị hết hạn khi server xác định đã quá cửa sổ', () => {
    render(
      <FeedbackFlaggingPanel
        items={[item({ daysUntilPurge: 0, isRestorable: false, deletedAt: '2026-07-01T00:00:00.000Z' })]}
        deletionState="deleted"
        isLoading={false}
        onViewDetail={vi.fn()}
        onAction={vi.fn()}
      />
    );

    expect(screen.getByText('Hết hạn khôi phục')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Khôi phục' })).toBeDisabled();
  });

  it('có empty state khác nhau giữa active/deleted và cắt preview dài ở FE', () => {
    const longComment = 'a'.repeat(121);
    const view = render(<FeedbackFlaggingPanel items={[item({ comment: longComment })]} deletionState="active" isLoading={false} onViewDetail={vi.fn()} onAction={vi.fn()} />);
    expect(screen.getByText(`${'a'.repeat(120)}…`)).toBeInTheDocument();
    view.unmount();

    render(<FeedbackFlaggingPanel items={[]} deletionState="active" isLoading={false} onViewDetail={vi.fn()} onAction={vi.fn()} />);
    expect(screen.getByText('Không có feedback nào đang bị flag.')).toBeInTheDocument();
    render(<FeedbackFlaggingPanel items={[]} deletionState="deleted" isLoading={false} onViewDetail={vi.fn()} onAction={vi.fn()} />);
    expect(screen.getByText('Không có feedback nào đang trong cửa sổ khôi phục.')).toBeInTheDocument();
  });
});
