import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import SbtMilestoneTimeline from '@/app/components/impactSbt/SbtMilestoneTimeline';
import type { ImpactSbtGalleryEntry } from '@/app/types/impactSbt';

/** Dựng entry tối giản để các test tập trung vào sort và highlight. */
function makeEntry(milestone: number, tokenId: number): ImpactSbtGalleryEntry {
  return {
    onChainTokenId: tokenId,
    projectId: 'project-1',
    projectName: 'Dự án mẫu',
    milestone,
    beneficiaryCount: milestone * 10,
    imageCid: 'QmImage',
    imageGatewayUrl: null,
    onChainTokenStatus: 'ACTIVE',
    confirmedAt: `2026-08-0${milestone}T10:00:00.000Z`
  };
}

describe('SbtMilestoneTimeline', () => {
  it('render milestone theo thứ tự đầu vào và highlight token hiện tại', () => {
    render(
      <SbtMilestoneTimeline
        entries={[makeEntry(1, 10), makeEntry(2, 20), makeEntry(3, 30)]}
        currentTokenId={20}
      />
    );

    expect(screen.getAllByRole('heading', { level: 3 }).map(heading => heading.textContent)).toEqual([
      'Milestone 1',
      'Milestone 2',
      'Milestone 3'
    ]);
    expect(screen.getByText('SBT hiện tại')).toBeInTheDocument();
    expect(screen.getByText('Token #20')).toBeInTheDocument();
  });

  it('hiển thị empty state khi không có milestone', () => {
    render(<SbtMilestoneTimeline entries={[]} currentTokenId={1} />);

    expect(screen.getByText('Chưa có milestone nào được ghi nhận công khai.')).toBeInTheDocument();
  });

  it('không crash và không highlight khi current token bị lọc khỏi list', () => {
    render(<SbtMilestoneTimeline entries={[makeEntry(1, 10)]} currentTokenId={999} />);

    expect(screen.getByText('Milestone 1')).toBeInTheDocument();
    expect(screen.queryByText('SBT hiện tại')).not.toBeInTheDocument();
  });
});
