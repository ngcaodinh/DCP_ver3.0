import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  useGallery: vi.fn(),
  replace: vi.fn()
}));

vi.mock('@/app/hooks/useImpactSbtGallery', () => ({
  useImpactSbtGallery: mocks.useGallery
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mocks.replace })
}));

import ImpactNFTGallery from '@/app/components/impactSbt/ImpactNFTGallery';
import type { ImpactSbtGalleryEntry, ImpactSbtGalleryResponse } from '@/app/types/impactSbt';

function makeEntry(id: number, projectId = `p-00${id}`): ImpactSbtGalleryEntry {
  return {
    onChainTokenId: id,
    projectId,
    projectName: `Dự án ${id}`,
    milestone: id,
    beneficiaryCount: id * 10,
    imageCid: 'QmImage',
    imageGatewayUrl: `https://ipfs.io/ipfs/QmImage-${id}`,
    onChainTokenStatus: 'ACTIVE',
    confirmedAt: '2026-08-01T10:00:00.000Z'
  };
}

type GalleryQueryMock = {
  data: ImpactSbtGalleryResponse | undefined;
  isLoading: boolean;
  isFetching: boolean;
  isError: boolean;
  error: { message: string } | null;
  refetch: () => unknown;
};

/** Mock đầy đủ shape của hook gallery để test không bỏ sót nhánh trạng thái khi interface mở rộng. */
function mockQuery(overrides: Partial<GalleryQueryMock> = {}): void {
  mocks.useGallery.mockReturnValue({
    data: {
      entries: [makeEntry(1)],
      pagination: { page: 1, limit: 20, total: 1, totalPages: 1 }
    },
    isLoading: false,
    isFetching: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
    ...overrides
  });
}

/** Tạo response thành công theo số entry cần dùng trong từng test container. */
function mockData(entries: ImpactSbtGalleryEntry[] = [makeEntry(1)]): void {
  mockQuery({
    data: {
      entries,
      pagination: { page: 1, limit: 20, total: entries.length, totalPages: 1 }
    }
  });
}

describe('ImpactNFTGallery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockData();
  });

  it('renders eight skeletons while the first request is loading', () => {
    mockQuery({ isLoading: true, data: undefined });

    render(<ImpactNFTGallery />);

    expect(screen.getAllByTestId('sbt-card-skeleton')).toHaveLength(8);
    expect(screen.queryByTestId('sbt-card')).not.toBeInTheDocument();
    expect(screen.queryByText('Chưa có SBT nào được mint')).not.toBeInTheDocument();
  });

  it('renders the empty state for HTTP 200 with no entries', () => {
    mockData([]);

    render(<ImpactNFTGallery />);

    expect(screen.getByText('Chưa có SBT nào được mint')).toBeInTheDocument();
    expect(screen.queryByText('Không thể tải gallery SBT.')).not.toBeInTheDocument();
  });

  it('renders error message and retries exactly once', () => {
    const refetch = vi.fn();
    mockQuery({
      data: undefined,
      isLoading: false,
      isError: true,
      error: { message: 'Không thể kết nối API.' },
      refetch
    });

    render(<ImpactNFTGallery />);
    expect(screen.getByText('Không thể kết nối API.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Thử lại' }));

    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('renders entries in the API order without client-side sorting', () => {
    mockData([makeEntry(3), makeEntry(1), makeEntry(2)]);

    render(<ImpactNFTGallery />);

    expect(screen.getAllByTestId('sbt-card')).toHaveLength(3);
    const projectNames = screen.getAllByRole('heading', { level: 2 }).map(node => node.textContent);
    expect(projectNames).toEqual(['Dự án 3', 'Dự án 1', 'Dự án 2']);
  });

  it('passes initial filter to the hook and synchronizes submitted filter to router', () => {
    render(<ImpactNFTGallery initialProjectId="p-001" />);

    expect(mocks.useGallery).toHaveBeenCalledWith('p-001', 1);
    fireEvent.change(screen.getByLabelText('Lọc theo project ID'), { target: { value: 'p-002' } });
    expect(mocks.replace).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Áp dụng' }));

    expect(mocks.replace).toHaveBeenCalledWith('/impact-gallery?projectId=p-002');
  });

  it('does not pass projectId when no initial filter is supplied', () => {
    render(<ImpactNFTGallery />);

    expect(mocks.useGallery).toHaveBeenCalledWith(undefined, 1);
  });

  it('changes page while preserving the applied project filter', () => {
    mockQuery({
      data: {
        entries: [makeEntry(1)],
        pagination: { page: 1, limit: 20, total: 21, totalPages: 2 }
      },
      isLoading: false,
      isFetching: false,
      isError: false,
      error: null,
      refetch: vi.fn()
    });

    const { rerender } = render(<ImpactNFTGallery initialProjectId="p-001" />);
    fireEvent.click(screen.getByRole('button', { name: 'Trang sau' }));

    expect(mocks.replace).toHaveBeenCalledWith('/impact-gallery?page=2&projectId=p-001');
    rerender(<ImpactNFTGallery initialProjectId="p-001" initialPage={2} />);
    expect(mocks.useGallery).toHaveBeenCalledWith('p-001', 2);
  });

  it('disables both pagination buttons while a page request is in flight', () => {
    mockQuery({
      data: {
        entries: [makeEntry(1)],
        pagination: { page: 2, limit: 20, total: 41, totalPages: 3 }
      },
      isFetching: true
    });

    render(<ImpactNFTGallery initialPage={2} />);

    const paginationButtons = screen.getAllByRole('button', { name: /^Trang/ });
    expect(paginationButtons).toHaveLength(2);
    paginationButtons.forEach(button => expect(button).toBeDisabled());
  });

  it('resynchronizes filter and page when server props change after URL navigation', () => {
    const { rerender } = render(<ImpactNFTGallery initialProjectId="p-001" initialPage={3} />);

    rerender(<ImpactNFTGallery initialProjectId="p-002" initialPage={1} />);

    expect(mocks.useGallery).toHaveBeenLastCalledWith('p-002', 1);
    expect(screen.getByRole('searchbox')).toHaveValue('p-002');
  });

  it('resynchronizes page when only the server page prop changes', () => {
    const { rerender } = render(<ImpactNFTGallery initialProjectId="p-001" initialPage={3} />);

    rerender(<ImpactNFTGallery initialProjectId="p-001" initialPage={2} />);

    expect(mocks.useGallery).toHaveBeenLastCalledWith('p-001', 2);
  });

  it('shows the filtered empty-state hint when the project has no SBT', () => {
    mockData([]);

    render(<ImpactNFTGallery initialProjectId="missing-project" />);

    expect(screen.getByText('Thử xoá bộ lọc project để xem toàn bộ gallery.')).toBeInTheDocument();
  });
});
