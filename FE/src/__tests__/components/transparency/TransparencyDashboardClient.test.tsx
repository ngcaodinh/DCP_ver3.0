/**
 * Tests cho TransparencyDashboardClient — D4.
 * Đây là component điều phối nhiều nhánh nhất trong D4. Mock 3 hook dữ liệu để
 * cô lập logic: gate khi chưa chọn dự án, chọn dự án → hiển thị timeline + donut,
 * nút export disabled khi chưa có dữ liệu, error/retry cho summary.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// Mock 3 hook data-fetching để không cần QueryClient thật.
vi.mock('@/app/hooks/useTransparencyProjects', () => ({
  useTransparencyProjects: vi.fn(),
}));
vi.mock('@/app/hooks/useTransparencyTimeline', () => ({
  useTransparencyTimeline: vi.fn(),
}));
vi.mock('@/app/hooks/useTransparencySummary', () => ({
  useTransparencySummary: vi.fn(),
}));

// Mock helper xuất CSV để verify nút Xuất CSV gọi đúng, không thực sự tạo file.
vi.mock('@/app/components/transparency/exportCsv', () => ({
  downloadTimelineCsv: vi.fn(),
}));

import { useTransparencyProjects } from '@/app/hooks/useTransparencyProjects';
import { useTransparencyTimeline } from '@/app/hooks/useTransparencyTimeline';
import { useTransparencySummary } from '@/app/hooks/useTransparencySummary';
import { downloadTimelineCsv } from '@/app/components/transparency/exportCsv';
import TransparencyDashboardClient from '@/app/components/transparency/TransparencyDashboardClient';

/** Dựng giá trị trả về mặc định cho useTransparencyProjects (đã có 1 dự án). */
function mockProjects() {
  vi.mocked(useTransparencyProjects).mockReturnValue({
    data: [{ projectId: 'project-1', name: 'Dự án A' }],
    isLoading: false,
    isError: false,
    error: null,
  } as never);
}

/** Dựng giá trị trả về mặc định cho useTransparencyTimeline (trống, không loading). */
function mockTimeline(pages: unknown[] = []) {
  vi.mocked(useTransparencyTimeline).mockReturnValue({
    data: pages.length > 0 ? { pages } : undefined,
    isLoading: false,
    isError: false,
    error: null,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
    refetch: vi.fn(),
  } as never);
}

/** Dựng giá trị trả về mặc định cho useTransparencySummary. */
function mockSummary(state: Record<string, unknown>) {
  vi.mocked(useTransparencySummary).mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
    ...state,
  } as never);
}

describe('TransparencyDashboardClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('chưa chọn dự án → hiển thị hướng dẫn, không render timeline/donut', () => {
    mockProjects();
    mockTimeline();
    mockSummary({});

    render(<TransparencyDashboardClient />);

    expect(screen.getByText(/Vui lòng chọn dự án để xem/)).toBeInTheDocument();
    expect(screen.queryByText('Dòng thời gian giao dịch')).not.toBeInTheDocument();
  });

  it('nút Xuất PDF/CSV bị disable khi chưa chọn dự án (chưa có dữ liệu)', () => {
    mockProjects();
    mockTimeline();
    mockSummary({});

    render(<TransparencyDashboardClient />);

    expect(screen.getByText('Xuất PDF').closest('button')).toBeDisabled();
    expect(screen.getByText('Xuất CSV').closest('button')).toBeDisabled();
  });

  it('chọn dự án → render timeline + số liệu, kích hoạt export', () => {
    mockProjects();
    mockTimeline([
      {
        timeline: [
          {
            eventId: 'e1',
            correlationId: 'c1',
            eventType: 'DONATION',
            timestamp: '2026-01-15T10:30:00.000Z',
            amountVnd: 50000,
            chainStatus: 'CONFIRMED',
            chainTxHash: null,
            chainBlockNumber: null,
            payosStatus: null,
            payosOrderCode: null,
            walletAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0E8eD',
            projectId: 'project-1',
            source: 'blockchain',
          },
        ],
      },
    ]);
    mockSummary({
      data: {
        projectId: 'project-1',
        totalRaised: 1000000,
        totalDisbursed: 400000,
        remaining: 600000,
        donorCount: 5,
        transactionCount: 5,
         disbursementCount: 2,
         disbursedAmounts: [],
         excludedReorgedVnd: 0,
         excludedReorgedCount: 0,
         overDisbursed: false,
         cached: false,
        fallbackMode: false,
      },
    });

    render(<TransparencyDashboardClient />);
    // Chọn dự án qua dropdown.
    fireEvent.change(screen.getByLabelText('Chọn dự án'), { target: { value: 'project-1' } });

    expect(screen.getByText('Dòng thời gian giao dịch')).toBeInTheDocument();
    expect(screen.getByText('Tổng quan phân bổ')).toBeInTheDocument();
    // Có dữ liệu → nút export bật.
    expect(screen.getByText('Xuất CSV').closest('button')).not.toBeDisabled();
  });

  it('summary lỗi → hiển thị thông báo và nút thử lại gọi refetch', () => {
    mockProjects();
    mockTimeline();
    const refetch = vi.fn();
    mockSummary({ isError: true, error: { message: 'Lỗi tải số liệu' }, refetch });

    render(<TransparencyDashboardClient />);
    fireEvent.change(screen.getByLabelText('Chọn dự án'), { target: { value: 'project-1' } });

    expect(screen.getByText('Lỗi tải số liệu')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Thử lại'));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('click Xuất CSV → gọi downloadTimelineCsv với đúng các sự kiện đang hiển thị', () => {
    mockProjects();
    const event = {
      eventId: 'e1',
      correlationId: 'c1',
      eventType: 'DONATION',
      timestamp: '2026-01-15T10:30:00.000Z',
      amountVnd: 50000,
      chainStatus: 'CONFIRMED',
      chainTxHash: null,
      chainBlockNumber: null,
      payosStatus: null,
      payosOrderCode: null,
      walletAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0E8eD',
      projectId: 'project-1',
      source: 'blockchain',
    };
    mockTimeline([{ timeline: [event] }]);
    mockSummary({
      data: {
        projectId: 'project-1',
        totalRaised: 1000000,
        totalDisbursed: 400000,
        remaining: 600000,
        donorCount: 5,
        transactionCount: 5,
         disbursementCount: 2,
         disbursedAmounts: [],
         excludedReorgedVnd: 0,
         excludedReorgedCount: 0,
         overDisbursed: false,
         cached: false,
        fallbackMode: false,
      },
    });

    render(<TransparencyDashboardClient />);
    fireEvent.change(screen.getByLabelText('Chọn dự án'), { target: { value: 'project-1' } });
    fireEvent.click(screen.getByText('Xuất CSV'));

    expect(downloadTimelineCsv).toHaveBeenCalledTimes(1);
    // Tham số đầu là mảng sự kiện đã flatten từ các trang timeline.
    const firstCallArgs = vi.mocked(downloadTimelineCsv).mock.calls[0];
    expect((firstCallArgs[0] as unknown[]).length).toBe(1);
  });

  it('click Xuất PDF → gọi window.print', () => {
    mockProjects();
    mockTimeline([
      {
        timeline: [
          {
            eventId: 'e1',
            correlationId: 'c1',
            eventType: 'DONATION',
            timestamp: '2026-01-15T10:30:00.000Z',
            amountVnd: 50000,
            chainStatus: 'CONFIRMED',
            chainTxHash: null,
            chainBlockNumber: null,
            payosStatus: null,
            payosOrderCode: null,
            walletAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0E8eD',
            projectId: 'project-1',
            source: 'blockchain',
          },
        ],
      },
    ]);
    mockSummary({
      data: {
        projectId: 'project-1',
        totalRaised: 1000000,
        totalDisbursed: 400000,
        remaining: 600000,
        donorCount: 5,
        transactionCount: 5,
         disbursementCount: 2,
         disbursedAmounts: [],
         excludedReorgedVnd: 0,
         excludedReorgedCount: 0,
         overDisbursed: false,
         cached: false,
        fallbackMode: false,
      },
    });

    const printSpy = vi.spyOn(window, 'print').mockImplementation(() => {});

    render(<TransparencyDashboardClient />);
    fireEvent.change(screen.getByLabelText('Chọn dự án'), { target: { value: 'project-1' } });
    fireEvent.click(screen.getByText('Xuất PDF'));

    expect(printSpy).toHaveBeenCalledTimes(1);
    printSpy.mockRestore();
  });

  it('danh sách dự án đang tải → dropdown disabled và hiện "Đang tải dự án..."', () => {
    vi.mocked(useTransparencyProjects).mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      error: null,
    } as never);
    mockTimeline();
    mockSummary({});

    render(<TransparencyDashboardClient />);

    const select = screen.getByLabelText('Chọn dự án');
    expect(select).toBeDisabled();
    expect(screen.getByText('Đang tải dự án...')).toBeInTheDocument();
  });

  it('lỗi tải danh sách dự án → hiển thị thông báo lỗi và dropdown disabled', () => {
    vi.mocked(useTransparencyProjects).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: { message: 'Không thể tải danh sách dự án.' },
    } as never);
    mockTimeline();
    mockSummary({});

    render(<TransparencyDashboardClient />);

    expect(screen.getByText('Không thể tải danh sách dự án.')).toBeInTheDocument();
    expect(screen.getByLabelText('Chọn dự án')).toBeDisabled();
  });

  it('summary đang tải → hiển thị "Đang tải số liệu..."', () => {
    mockProjects();
    mockTimeline();
    mockSummary({ isLoading: true });

    render(<TransparencyDashboardClient />);
    fireEvent.change(screen.getByLabelText('Chọn dự án'), { target: { value: 'project-1' } });

    expect(screen.getByText('Đang tải số liệu...')).toBeInTheDocument();
  });

  it('timeline đang tải → UnifiedTimeline hiển thị trạng thái tải dòng tiền', () => {
    mockProjects();
    vi.mocked(useTransparencyTimeline).mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      error: null,
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: vi.fn(),
      refetch: vi.fn(),
    } as never);
    mockSummary({});

    render(<TransparencyDashboardClient />);
    fireEvent.change(screen.getByLabelText('Chọn dự án'), { target: { value: 'project-1' } });

    expect(screen.getByText('Đang tải dòng tiền...')).toBeInTheDocument();
  });

  it('nhiều trang timeline → flatMap gộp sự kiện từ mọi trang khi xuất CSV', () => {
    mockProjects();
    /** Dựng một sự kiện timeline tối thiểu với eventId riêng cho từng trang. */
    const makeEvent = (eventId: string) => ({
      eventId,
      correlationId: `corr-${eventId}`,
      eventType: 'DONATION',
      timestamp: '2026-01-15T10:30:00.000Z',
      amountVnd: 50000,
      chainStatus: 'CONFIRMED',
      chainTxHash: null,
      chainBlockNumber: null,
      payosStatus: null,
      payosOrderCode: null,
      walletAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0E8eD',
      projectId: 'project-1',
      source: 'blockchain',
    });
    // Hai trang, mỗi trang 2 sự kiện → flatMap phải gộp thành 4.
    mockTimeline([
      { timeline: [makeEvent('e1'), makeEvent('e2')] },
      { timeline: [makeEvent('e3'), makeEvent('e4')] },
    ]);
    mockSummary({
      data: {
        projectId: 'project-1',
        totalRaised: 1000000,
        totalDisbursed: 400000,
        remaining: 600000,
        donorCount: 5,
        transactionCount: 5,
         disbursementCount: 2,
         disbursedAmounts: [],
         excludedReorgedVnd: 0,
         excludedReorgedCount: 0,
         overDisbursed: false,
         cached: false,
        fallbackMode: false,
      },
    });

    render(<TransparencyDashboardClient />);
    fireEvent.change(screen.getByLabelText('Chọn dự án'), { target: { value: 'project-1' } });
    fireEvent.click(screen.getByText('Xuất CSV'));

    // flatMap gộp 2 trang → downloadTimelineCsv nhận đủ 4 sự kiện.
    const firstCallArgs = vi.mocked(downloadTimelineCsv).mock.calls[0];
    expect((firstCallArgs[0] as unknown[]).length).toBe(4);
  });
});
