import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { FeedbackDetailModal } from '@/app/components/adminFeedback/FeedbackDetailModal';
import type { FlaggedFeedbackItem } from '@/app/components/adminFeedback/types';

const dirtyItem = {
  feedbackId: 'fb-detail',
  projectId: 'project-1',
  projectName: 'Project 1',
  rating: 5,
  comment: 'Nội dung đầy đủ không bị cắt trong modal.',
  submittedAt: '2026-08-10T03:12:00.000Z',
  location: 'Quảng Bình',
  riskScore: 9,
  isFlagged: true,
  source: 'public' as const,
  flagReason: { kind: 'MANUAL' as const, indicators: ['extreme_rating:5'], adminReason: 'Cần kiểm tra', flaggedByAdminId: 'admin-1', flaggedAt: '2026-08-14T01:00:00.000Z' },
  beneficiaryNameHash: 'must-not-render',
  submissionIpHash: 'must-not-render',
  uploadedByOrganizationId: 'must-not-render'
} as unknown as FlaggedFeedbackItem;

describe('FeedbackDetailModal', () => {
  it('render full comment/metadata nhưng không render PII kể cả payload bẩn', () => {
    render(<FeedbackDetailModal item={dirtyItem} deletionState="active" onClose={vi.fn()} />);

    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByText(dirtyItem.comment)).toBeInTheDocument();
    expect(screen.getByText('Hệ thống không lưu danh tính người gửi phản hồi.')).toBeInTheDocument();
    expect(screen.getByText('Cần kiểm tra')).toBeInTheDocument();
    expect(screen.queryByText('must-not-render')).not.toBeInTheDocument();
    expect(screen.queryByText('beneficiaryNameHash')).not.toBeInTheDocument();
    expect(screen.queryByText('submissionIpHash')).not.toBeInTheDocument();
  });

  it('render metadata delete và đóng bằng Escape', () => {
    const onClose = vi.fn();
    render(<FeedbackDetailModal item={{ ...dirtyItem, deletedAt: '2026-08-14T00:00:00.000Z', deletedByAdminId: 'admin-delete', deleteReason: 'Lý do xoá', purgeAfter: '2026-09-13T00:00:00.000Z' }} deletionState="deleted" onClose={onClose} />);

    expect(screen.getAllByText('Lý do xoá')).toHaveLength(2);
    expect(screen.getByText('admin-delete')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
