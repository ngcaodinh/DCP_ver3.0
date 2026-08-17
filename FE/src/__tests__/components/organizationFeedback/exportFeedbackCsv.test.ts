import { describe, expect, it } from 'vitest';
import { buildFeedbackCsvContent } from '@/app/components/organizationFeedback/exportFeedbackCsv';
import type { OrganizationFeedbackItem } from '@/app/components/organizationFeedback/types';

describe('buildFeedbackCsvContent', () => {
  it('xuất đúng 9 cột public-safe, RFC 4180 và BOM', () => {
    const item: OrganizationFeedbackItem = {
      feedbackId: 'FB-1',
      projectId: 'DA-1',
      projectName: 'Dự án một',
      rating: 5,
      comment: '=SUM(A1:A2), "nháy kép"\nvà nội dung',
      submittedAt: '2026-08-01T00:00:00Z',
      location: 'Quảng Bình',
      source: 'batch',
      isFlagged: true
    };

    const content = buildFeedbackCsvContent([item]);
    const header = content.slice(1).split('\r\n')[0].split(',');

    expect(content.startsWith('\uFEFF')).toBe(true);
    expect(header).toHaveLength(9);
    expect(content).toContain("'=SUM(A1:A2)");
    expect(content).toContain('Đang chờ duyệt');
    expect(content).not.toContain('riskScore');
    expect(content).not.toContain('beneficiaryNameHash');
    expect(content).not.toContain('submissionIpHash');
  });

  it('không formula-escape lần hai giá trị đã bắt đầu bằng khoảng trắng', () => {
    const item: OrganizationFeedbackItem = {
      feedbackId: 'FB-2',
      projectId: 'DA-2',
      projectName: null,
      rating: 3,
      comment: ' =SUM(A1:A2)',
      submittedAt: '2026-08-01T00:00:00Z',
      source: 'public',
      isFlagged: false
    };

    const content = buildFeedbackCsvContent([item]);
    expect(content).toContain(' =SUM(A1:A2)');
    expect(content).not.toContain("' =SUM(A1:A2)");
  });

  it('neutralize đủ các prefix formula nguy hiểm ở đầu cell', () => {
    const item: OrganizationFeedbackItem = {
      feedbackId: 'FB-3',
      projectId: 'DA-3',
      projectName: '+Project',
      rating: 1,
      comment: '-10+20',
      submittedAt: '2026-08-01T00:00:00Z',
      location: '@A1',
      source: 'batch',
      isFlagged: false
    };

    const content = buildFeedbackCsvContent([item]);

    expect(content).toContain("'+Project");
    expect(content).toContain("'-10+20");
    expect(content).toContain("'@A1");
  });
});
