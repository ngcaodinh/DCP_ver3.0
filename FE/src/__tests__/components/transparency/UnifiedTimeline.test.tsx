/**
 * Tests cho UnifiedTimeline — D4.
 * Tập trung vào: render theo eventType (DEPOSIT/DONATION), che walletAddress +
 * link PolygonScan, empty state, error state (nút thử lại), và nút "Xem thêm".
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import UnifiedTimeline from '@/app/components/transparency/UnifiedTimeline';
import type { TimelineEvent } from '@/app/components/transparency/types';

/** Hàm factory tạo sự kiện timeline mẫu. Mục đích: gom dữ liệu test một chỗ, dễ tùy biến. */
function makeEvent(overrides: Partial<TimelineEvent> = {}): TimelineEvent {
  return {
    eventId: 'evt-1',
    correlationId: 'donation:0xabc',
    eventType: 'DONATION',
    timestamp: '2026-01-15T10:30:00.000Z',
    amountVnd: 50000,
    chainStatus: 'CONFIRMED',
    chainTxHash: '0xabcdef1234567890abcdef1234567890abcdef12',
    chainBlockNumber: 12345678,
    payosStatus: null,
    payosOrderCode: null,
    walletAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0E8eD',
    projectId: 'project-1',
    source: 'blockchain',
    ...overrides
  };
}

const noop = () => {};

describe('UnifiedTimeline', () => {
  it('error state → hiển thị thông báo lỗi và nút thử lại kích hoạt onRetry', () => {
    const onRetry = vi.fn();
    render(
      <UnifiedTimeline
        events={[]}
        isLoading={false}
        isError
        errorMessage="Lỗi mạng"
        onRetry={onRetry}
        hasNextPage={false}
        isFetchingNextPage={false}
        onLoadMore={noop}
      />
    );
    expect(screen.getByText('Lỗi mạng')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Thử lại'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('không có sự kiện → hiển thị empty state', () => {
    render(
      <UnifiedTimeline
        events={[]}
        isLoading={false}
        isError={false}
        onRetry={noop}
        hasNextPage={false}
        isFetchingNextPage={false}
        onLoadMore={noop}
      />
    );
    expect(screen.getByText('Chưa có giao dịch nào')).toBeInTheDocument();
  });

  it('DONATION → che địa chỉ ví và render link PolygonScan', () => {
    render(
      <UnifiedTimeline
        events={[makeEvent()]}
        isLoading={false}
        isError={false}
        onRetry={noop}
        hasNextPage={false}
        isFetchingNextPage={false}
        onLoadMore={noop}
      />
    );
    // Ví được che dạng 0x742d...E8eD
    expect(screen.getByText('0x742d...E8eD')).toBeInTheDocument();
    const link = screen.getByText('Xem trên PolygonScan').closest('a');
    expect(link?.getAttribute('href')).toContain('0xabcdef1234567890abcdef1234567890abcdef12');
  });

  it('DEPOSIT → hiển thị mã đơn PayOS thay vì ví', () => {
    render(
      <UnifiedTimeline
        events={[makeEvent({ eventType: 'DEPOSIT', payosOrderCode: 'ORDER-99', chainTxHash: null })]}
        isLoading={false}
        isError={false}
        onRetry={noop}
        hasNextPage={false}
        isFetchingNextPage={false}
        onLoadMore={noop}
      />
    );
    expect(screen.getByText('ORDER-99')).toBeInTheDocument();
    expect(screen.getByText('Nạp tiền')).toBeInTheDocument();
  });

  it('hasNextPage → hiển thị nút Xem thêm và gọi onLoadMore', () => {
    const onLoadMore = vi.fn();
    render(
      <UnifiedTimeline
        events={[makeEvent()]}
        isLoading={false}
        isError={false}
        onRetry={noop}
        hasNextPage
        isFetchingNextPage={false}
        onLoadMore={onLoadMore}
      />
    );
    fireEvent.click(screen.getByText('Xem thêm'));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it('DISBURSEMENT → hiển thị trạng thái chuyển khoản (payosStatus) và mã đơn PayOS', () => {
    render(
      <UnifiedTimeline
        events={[makeEvent({ eventType: 'DISBURSEMENT', payosStatus: 'PAYMENT_CONFIRMED', payosOrderCode: 'DIS-42', chainTxHash: null })]}
        isLoading={false}
        isError={false}
        onRetry={noop}
        hasNextPage={false}
        isFetchingNextPage={false}
        onLoadMore={noop}
      />
    );
    expect(screen.getByText('Giải ngân')).toBeInTheDocument();
    expect(screen.getByText('PAYMENT_CONFIRMED')).toBeInTheDocument();
    expect(screen.getByText('DIS-42')).toBeInTheDocument();
  });

  it('MINT → nhãn Phát hành token và link PolygonScan khi có tx hash', () => {
    render(
      <UnifiedTimeline
        events={[makeEvent({ eventType: 'MINT' })]}
        isLoading={false}
        isError={false}
        onRetry={noop}
        hasNextPage={false}
        isFetchingNextPage={false}
        onLoadMore={noop}
      />
    );
    expect(screen.getByText('Phát hành token')).toBeInTheDocument();
    expect(screen.getByText('Xem trên PolygonScan')).toBeInTheDocument();
  });

  it('UNKNOWN → nhãn Không xác định, không crash', () => {
    render(
      <UnifiedTimeline
        events={[makeEvent({ eventType: 'UNKNOWN', chainTxHash: null })]}
        isLoading={false}
        isError={false}
        onRetry={noop}
        hasNextPage={false}
        isFetchingNextPage={false}
        onLoadMore={noop}
      />
    );
    expect(screen.getByText('Không xác định')).toBeInTheDocument();
  });

  it('isFetchingNextPage=true → nút hiển thị "Đang tải thêm..." và bị disable', () => {
    render(
      <UnifiedTimeline
        events={[makeEvent()]}
        isLoading={false}
        isError={false}
        onRetry={noop}
        hasNextPage
        isFetchingNextPage
        onLoadMore={noop}
      />
    );
    const loadMoreButton = screen.getByText('Đang tải thêm...').closest('button');
    expect(loadMoreButton).toBeDisabled();
  });

  it('isLoading=true → hiển thị trạng thái đang tải (ưu tiên hơn empty state)', () => {
    render(
      <UnifiedTimeline
        events={[]}
        isLoading
        isError={false}
        onRetry={noop}
        hasNextPage={false}
        isFetchingNextPage={false}
        onLoadMore={noop}
      />
    );
    expect(screen.getByText('Đang tải dòng tiền...')).toBeInTheDocument();
    expect(screen.queryByText('Chưa có giao dịch nào')).not.toBeInTheDocument();
  });

  it('error state ưu tiên hơn loading khi cả hai cùng bật', () => {
    render(
      <UnifiedTimeline
        events={[]}
        isLoading
        isError
        errorMessage="Lỗi tải"
        onRetry={noop}
        hasNextPage={false}
        isFetchingNextPage={false}
        onLoadMore={noop}
      />
    );
    expect(screen.getByText('Lỗi tải')).toBeInTheDocument();
    expect(screen.queryByText('Đang tải dòng tiền...')).not.toBeInTheDocument();
  });

  it('error state không có errorMessage → dùng thông báo mặc định', () => {
    render(
      <UnifiedTimeline
        events={[]}
        isLoading={false}
        isError
        onRetry={noop}
        hasNextPage={false}
        isFetchingNextPage={false}
        onLoadMore={noop}
      />
    );
    expect(screen.getByText('Không thể tải dòng tiền. Vui lòng thử lại.')).toBeInTheDocument();
  });

  it('DONATION không có tx hash → hiển thị "Chưa có mã giao dịch on-chain", không có link', () => {
    render(
      <UnifiedTimeline
        events={[makeEvent({ eventType: 'DONATION', chainTxHash: null })]}
        isLoading={false}
        isError={false}
        onRetry={noop}
        hasNextPage={false}
        isFetchingNextPage={false}
        onLoadMore={noop}
      />
    );
    expect(screen.getByText('Chưa có mã giao dịch on-chain')).toBeInTheDocument();
    expect(screen.queryByText('Xem trên PolygonScan')).not.toBeInTheDocument();
  });

  it('ví ngắn (≤10 ký tự) → giữ nguyên, không che', () => {
    render(
      <UnifiedTimeline
        events={[makeEvent({ eventType: 'DONATION', walletAddress: '0x123456' })]}
        isLoading={false}
        isError={false}
        onRetry={noop}
        hasNextPage={false}
        isFetchingNextPage={false}
        onLoadMore={noop}
      />
    );
    expect(screen.getByText('0x123456')).toBeInTheDocument();
  });

  it('DEPOSIT không có payosOrderCode → hiển thị dấu gạch "—"', () => {
    render(
      <UnifiedTimeline
        events={[makeEvent({ eventType: 'DEPOSIT', payosOrderCode: null, chainTxHash: null })]}
        isLoading={false}
        isError={false}
        onRetry={noop}
        hasNextPage={false}
        isFetchingNextPage={false}
        onLoadMore={noop}
      />
    );
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('DISBURSEMENT không có payosStatus → fallback nhãn trạng thái on-chain', () => {
    render(
      <UnifiedTimeline
        events={[makeEvent({ eventType: 'DISBURSEMENT', payosStatus: null, chainStatus: 'PENDING', chainTxHash: null })]}
        isLoading={false}
        isError={false}
        onRetry={noop}
        hasNextPage={false}
        isFetchingNextPage={false}
        onLoadMore={noop}
      />
    );
    // payosStatus null → dùng nhãn tiếng Việt của chainStatus. "Đang chờ" xuất hiện ở cả badge lẫn dòng trạng thái.
    expect(screen.getAllByText('Đang chờ').length).toBeGreaterThanOrEqual(1);
  });

  it('badge trạng thái on-chain hiển thị đúng nhãn tiếng Việt theo chainStatus', () => {
    render(
      <UnifiedTimeline
        events={[makeEvent({ chainStatus: 'FAILED' })]}
        isLoading={false}
        isError={false}
        onRetry={noop}
        hasNextPage={false}
        isFetchingNextPage={false}
        onLoadMore={noop}
      />
    );
    expect(screen.getByText('Thất bại')).toBeInTheDocument();
  });

  it('nhiều sự kiện cùng correlationId → render đủ tất cả (đường nối nhóm tương quan)', () => {
    render(
      <UnifiedTimeline
        events={[
          makeEvent({ eventId: 'e1', correlationId: 'group-1', eventType: 'DEPOSIT', payosOrderCode: 'ORD-1', chainTxHash: null }),
          makeEvent({ eventId: 'e2', correlationId: 'group-1', eventType: 'DONATION' })
        ]}
        isLoading={false}
        isError={false}
        onRetry={noop}
        hasNextPage={false}
        isFetchingNextPage={false}
        onLoadMore={noop}
      />
    );
    // Cả hai sự kiện cùng nhóm đều render.
    expect(screen.getByText('Nạp tiền')).toBeInTheDocument();
    expect(screen.getByText('Quyên góp')).toBeInTheDocument();
  });

  it('hasNextPage=false → KHÔNG hiển thị nút Xem thêm', () => {
    render(
      <UnifiedTimeline
        events={[makeEvent()]}
        isLoading={false}
        isError={false}
        onRetry={noop}
        hasNextPage={false}
        isFetchingNextPage={false}
        onLoadMore={noop}
      />
    );
    expect(screen.queryByText('Xem thêm')).not.toBeInTheDocument();
  });

  it('timestamp không hợp lệ → hiển thị nguyên chuỗi gốc (không crash)', () => {
    render(
      <UnifiedTimeline
        events={[makeEvent({ timestamp: 'not-a-date' })]}
        isLoading={false}
        isError={false}
        onRetry={noop}
        hasNextPage={false}
        isFetchingNextPage={false}
        onLoadMore={noop}
      />
    );
    expect(screen.getByText('not-a-date')).toBeInTheDocument();
  });
});
