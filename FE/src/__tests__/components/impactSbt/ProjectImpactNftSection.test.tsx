import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  useGallery: vi.fn()
}));

vi.mock('@/app/hooks/useImpactSbtGallery', () => ({
  useImpactSbtGallery: mocks.useGallery
}));

import ProjectImpactNftSection from '@/app/components/impactSbt/ProjectImpactNftSection';
import type { ImpactSbtGalleryEntry, ImpactSbtGalleryResponse } from '@/app/types/impactSbt';

/** Tạo một entry Impact SBT hợp lệ để kiểm tra số lượng card và liên kết preview. */
function makeEntry(id: number): ImpactSbtGalleryEntry {
  return {
    onChainTokenId: id,
    projectId: 'project-001',
    projectName: `Dự án ${id}`,
    milestone: id,
    beneficiaryCount: id * 10,
    imageCid: `Qm${'a'.repeat(44)}`,
    imageGatewayUrl: `https://ipfs.io/ipfs/QmImage-${id}`,
    onChainTokenStatus: 'ACTIVE',
    confirmedAt: '2026-08-01T10:00:00.000Z'
  };
}

type GalleryQueryMock = {
  data: ImpactSbtGalleryResponse | undefined;
  isLoading: boolean;
  isPlaceholderData: boolean;
  isError: boolean;
  error: { message: string } | null;
  refetch: ReturnType<typeof vi.fn>;
};

/** Dựng response thành công theo số entry và tổng số bản ghi cần kiểm tra. */
function mockData(entries: ImpactSbtGalleryEntry[], total = entries.length): ImpactSbtGalleryResponse {
  return {
    entries,
    pagination: { page: 1, limit: 20, total, totalPages: Math.max(1, Math.ceil(total / 20)) }
  };
}

/** Mock đầy đủ các trạng thái query mà section sử dụng để kiểm thử độc lập với React Query provider. */
function mockQuery(overrides: Partial<GalleryQueryMock> = {}): void {
  mocks.useGallery.mockReturnValue({
    data: mockData([makeEntry(1)]),
    isLoading: false,
    isPlaceholderData: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
    ...overrides
  });
}

describe('ProjectImpactNftSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders three skeletons while the gallery request is loading', () => {
    mockQuery({ data: undefined, isLoading: true });

    render(<ProjectImpactNftSection projectId="project-001" />);

    expect(screen.getAllByTestId('sbt-card-skeleton')).toHaveLength(3);
    expect(screen.queryByTestId('sbt-card')).not.toBeInTheDocument();
    expect(screen.queryByText('Dự án này chưa có mốc nào được xác minh on-chain.')).not.toBeInTheDocument();
  });

  it('renders only four preview cards and links to the full gallery when more exist', () => {
    mockQuery({ data: mockData([1, 2, 3, 4].map(makeEntry), 6) });

    render(<ProjectImpactNftSection projectId="project-001" />);

    expect(mocks.useGallery).toHaveBeenCalledWith('project-001', 1);
    expect(screen.getAllByTestId('sbt-card')).toHaveLength(4);
    expect(screen.getByRole('link', { name: 'Xem tất cả trên Impact Gallery' })).toHaveAttribute(
      'href',
      '/impact-gallery?projectId=project-001'
    );
  });

  it('shows skeletons while React Query exposes placeholder data from another project', () => {
    mockQuery({
      data: mockData([makeEntry(1)]),
      isPlaceholderData: true
    });

    render(<ProjectImpactNftSection projectId="project-002" />);

    expect(screen.getAllByTestId('sbt-card-skeleton')).toHaveLength(3);
    expect(screen.queryByTestId('sbt-card')).not.toBeInTheDocument();
    expect(screen.queryByText('Dự án 1')).not.toBeInTheDocument();
  });

  it('keeps the section visible with a friendly empty state when no SBT exists', () => {
    mockQuery({ data: mockData([]) });

    render(<ProjectImpactNftSection projectId="project-001" />);

    expect(screen.getByTestId('project-impact-nft-section')).toBeInTheDocument();
    expect(screen.getByText('Dự án này chưa có mốc nào được xác minh on-chain.')).toBeInTheDocument();
    expect(screen.queryByTestId('sbt-card')).not.toBeInTheDocument();
  });

  it('renders the API error and retries exactly once', () => {
    const refetch = vi.fn();
    mockQuery({
      data: undefined,
      isError: true,
      error: { message: 'Không thể kết nối API.' },
      refetch
    });

    render(<ProjectImpactNftSection projectId="project-001" />);
    expect(screen.getByText('Không thể kết nối API.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Thử lại' }));

    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('does not show the full-gallery link when the total is within the preview limit', () => {
    mockQuery({ data: mockData([1, 2, 3].map(makeEntry), 3) });

    render(<ProjectImpactNftSection projectId="project-001" />);

    expect(screen.getAllByTestId('sbt-card')).toHaveLength(3);
    expect(screen.queryByRole('link', { name: 'Xem tất cả trên Impact Gallery' })).not.toBeInTheDocument();
  });
});
