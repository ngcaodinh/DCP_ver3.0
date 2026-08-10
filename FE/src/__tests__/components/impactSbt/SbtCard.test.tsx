import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import SbtCard from '@/app/components/impactSbt/SbtCard';
import type { ImpactSbtGalleryEntry } from '@/app/types/impactSbt';

function makeEntry(overrides: Partial<ImpactSbtGalleryEntry> = {}): ImpactSbtGalleryEntry {
  return {
    onChainTokenId: 12,
    projectId: 'p-001',
    projectName: 'Dự án mẫu',
    milestone: 2,
    beneficiaryCount: 150,
    imageCid: `Qm${'a'.repeat(44)}`,
    imageGatewayUrl: 'https://ipfs.io/ipfs/image',
    onChainTokenStatus: 'ACTIVE',
    confirmedAt: '2026-08-01T10:00:00.000Z',
    ...overrides
  };
}

describe('SbtCard', () => {
  it('links a confirmed token to the C6 detail route', () => {
    render(<SbtCard entry={makeEntry()} />);

    expect(screen.getByRole('link')).toHaveAttribute('href', '/impact-gallery/12');
  });

  it('does not create a broken null link before tokenId exists', () => {
    render(<SbtCard entry={makeEntry({ onChainTokenId: null })} />);

    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByTestId('sbt-card')).toBeInTheDocument();
  });

  it('shows project fallback, beneficiary count, frozen badge, and hover classes', () => {
    render(
      <SbtCard
        entry={makeEntry({ projectName: null, onChainTokenStatus: 'FROZEN' })}
      />
    );

    const card = screen.getByTestId('sbt-card');
    expect(screen.getByRole('heading', { name: 'p-001' })).toBeInTheDocument();
    expect(screen.getByText('150')).toBeInTheDocument();
    expect(screen.getByText('Đang tạm khoá')).toBeInTheDocument();
    expect(card.className).toContain('hover:scale-[1.02]');
    expect(card.className).toContain('hover:shadow-cyan-500/20');
    expect(card.className).toContain('transition-[transform,box-shadow]');
  });
});
