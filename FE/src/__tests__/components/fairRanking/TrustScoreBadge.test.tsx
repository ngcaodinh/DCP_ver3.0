import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import TrustScoreBadge from '@/app/components/fairRanking/TrustScoreBadge';

describe('TrustScoreBadge', () => {
  it.each([
    [0, 'Bronze'],
    [0.29, 'Bronze'],
    [0.3, 'Silver'],
    [0.59, 'Silver'],
    [0.6, 'Gold'],
    [1, 'Gold']
  ] as const)('hien thi tier BE tra ve %s voi nhan %s', (trustScore, tier) => {
    render(<TrustScoreBadge trustScore={trustScore} tier={tier} trustSource="computed" />);
    expect(screen.getByRole('button')).toHaveTextContent(`${tier} · ${String(trustScore)}`);
  });

  it('mo tooltip bang hover, focus, click va dong bang Escape', async () => {
    render(<TrustScoreBadge trustScore={0.72} tier="Gold" trustSource="computed" />);
    const badge = screen.getByRole('button');
    const badgeWrapper = badge.parentElement as HTMLElement;

    fireEvent.mouseEnter(badgeWrapper);
    expect(screen.getByRole('tooltip')).toHaveTextContent('KYC');
    expect(screen.getByRole('tooltip')).toHaveTextContent('Lịch sử quyên góp');
    expect(screen.getByRole('tooltip')).toHaveTextContent('Xác minh MXH');
    expect(screen.getByRole('tooltip')).toHaveTextContent('Tuổi tài khoản');
    expect(screen.getByRole('tooltip')).toHaveTextContent('Liên kết thiết bị');
    expect(screen.getByRole('tooltip')).toHaveTextContent('0.72 (Gold)');

    fireEvent.mouseLeave(badgeWrapper);
    fireEvent.focus(badge);
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    expect(badge).toHaveAttribute('aria-describedby');
    fireEvent.keyDown(badge, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    fireEvent.click(badge);
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
  });

  it('giu tooltip mo khi mot cu cham phat ca mouseEnter va click, sau do dong khi bam ra ngoai', () => {
    render(<TrustScoreBadge trustScore={0.72} tier="Gold" trustSource="computed" />);
    const badge = screen.getByRole('button');
    const badgeWrapper = badge.parentElement as HTMLElement;

    fireEvent.mouseEnter(badgeWrapper);
    fireEvent.click(badge);
    expect(screen.getByRole('tooltip')).toBeInTheDocument();

    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('dung bien the neutral va giai thich cho unknown/fallback', async () => {
    const { rerender } = render(<TrustScoreBadge trustScore={0.3} tier="Bronze" trustSource="unknown" />);
    const badge = screen.getByRole('button');
    expect(badge).toHaveClass('border-dashed');
    fireEvent.click(badge);
    expect(screen.getByRole('tooltip')).toHaveTextContent('chưa liên kết tài khoản đã xác minh');

    rerender(<TrustScoreBadge trustScore={0.5} tier="Silver" trustSource="fallback" />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('tooltip')).toHaveTextContent('điểm mặc định 0.5');
  });
});
