import { describe, expect, it, afterEach, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import CountdownTimer from '@/app/components/adminTransfers/CountdownTimer';

describe('CountdownTimer', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('đếm giảm theo SLA server và đổi trạng thái khi quá hạn', () => {
    vi.useFakeTimers();
    const now = new Date('2026-08-08T00:00:00.000Z');
    vi.setSystemTime(now);
    render(<CountdownTimer deadline={new Date(now.getTime() + 2_000).toISOString()} escalatedAt={null} />);

    expect(screen.getByText('0g 0p 2s')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(2_000));
    expect(screen.getByText('Quá hạn SLA')).toBeInTheDocument();
  });

  it('đổi sang cảnh báo urgent khi SLA còn dưới hai giờ', () => {
    vi.useFakeTimers();
    const now = new Date('2026-08-08T00:00:00.000Z');
    vi.setSystemTime(now);
    render(<CountdownTimer deadline={new Date(now.getTime() + 60 * 60 * 1000).toISOString()} escalatedAt={null} />);

    expect(screen.getByText('1g 0p 0s')).toHaveClass('text-red-600');
  });

  it('hiển thị mốc escalate từ server và không giữ interval sau unmount', () => {
    vi.useFakeTimers();
    const now = new Date('2026-08-08T00:00:00.000Z');
    vi.setSystemTime(now);
    const { unmount } = render(
      <CountdownTimer deadline={new Date(now.getTime() + 60_000).toISOString()} escalatedAt={now.toISOString()} />
    );

    expect(screen.getByText(/Đã escalate lúc/)).toBeInTheDocument();
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('dọn interval đang chạy khi component bị unmount trước khi SLA hết hạn', () => {
    vi.useFakeTimers();
    const now = new Date('2026-08-08T00:00:00.000Z');
    vi.setSystemTime(now);
    const { unmount } = render(
      <CountdownTimer deadline={new Date(now.getTime() + 60_000).toISOString()} escalatedAt={null} />
    );

    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shows a safe fallback when the server deadline is invalid', () => {
    vi.useFakeTimers();
    render(<CountdownTimer deadline="invalid-deadline" escalatedAt={null} />);

    expect(screen.getByText('SLA không hợp lệ')).toBeInTheDocument();
    expect(screen.queryByText(/NaN/)).not.toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(0);
  });
});
