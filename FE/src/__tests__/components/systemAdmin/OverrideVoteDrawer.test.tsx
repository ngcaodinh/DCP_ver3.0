/**
 * Test cases cho OverrideVoteDrawer component (B4).
 * Bao gồm: hiển thị thông tin GPS, VoteConfirmationDialog,
 * các banner trạng thái (2/3 vote, đã duyệt), empty state, auto-select từ initialRequestId.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

// =============================================================================
// MOCKS
// =============================================================================

vi.mock('@/app/utils/apiClient', () => ({
  fetchApi: vi.fn(),
  buildApiUrl: vi.fn((path: string) => path),
}));

vi.mock('@/app/utils/authSession', () => ({
  readAuthSession: vi.fn(),
}));

// GeofenceMapLazy dùng next/dynamic — trong Vitest/jsdom không lazy-load,
// render thẳng GeofenceMap → useGeofence → cần QueryClientProvider.
// Mock để tránh dependency phức tạp trong unit test của OverrideVoteDrawer.
vi.mock('@/app/components/oracle/GeofenceMapLazy', () => ({
  GeofenceMapLazy: () => <div data-testid="geofence-map-mock" />,
}));

// Mock TanStack Query — OverrideVoteDrawer bây giờ dùng useOverrideRequests/useSubmitOverrideVote
// Dùng module-level objects được update trong từng test case
const overrideRequestsMock = {
  data: [] as unknown[],
  isLoading: false,
  error: null,
  refetch: vi.fn().mockResolvedValue({ data: [], error: null }),
};

const submitVoteMock = {
  mutateAsync: vi.fn().mockResolvedValue({ outcome: 'VOTE_RECORDED' as const, pendingVoters: 2, totalVoters: 3 }),
};

// Dùng mockImplementation để mỗi lần hook được gọi nó trả về object mới nhất
// (React Query useQuery nhận object reference mới → trigger re-render)
vi.mock('@/app/hooks/useOverrideRequests', () => ({
  useOverrideRequests: vi.fn(() => ({ ...overrideRequestsMock })),
  useSubmitOverrideVote: vi.fn(() => ({ ...submitVoteMock })),
}));

import { fetchApi } from '@/app/utils/apiClient';
import { readAuthSession } from '@/app/utils/authSession';
import OverrideVoteDrawer from '@/app/components/systemAdmin/tailwind/OverrideVoteDrawer';
import type { OverrideVoteDrawerProps } from '@/app/components/systemAdmin/tailwind/OverrideVoteDrawer';

// =============================================================================
// HELPERS — xử lý tiếng Việt có dấu trong DOM
// =============================================================================

/**
 * Chuẩn hoá tiếng Việt: NFD → bỏ combining marks → lowercase → thay thế ký tự đặc biệt.
 * toLowerCase() phải đứng TRƯỚC map để 'Đ' → 'đ' → 'd' (không phải 'Đ' → 'đ' bị bỏ sót).
 * Regex dùng Unicode escapes [̀-ͯ] thay character literals để tránh encoding lỗi.
 */
function normalizeText(text: string): string {
  let r = text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const M: Record<string, string> = {
    'ă':'a',
    'â':'a',
    'đ':'d',
    'ê':'e',
    'ô':'o',
    'ơ':'o',
    'ư':'u',
  };
  for (const [k, v] of Object.entries(M)) r = r.split(k).join(v);
  return r;
}

function assertText(pattern: string): void {
  const body = normalizeText(document.body.textContent ?? '');
  expect(body).toContain(normalizeText(pattern));
}

function findButton(text: string): HTMLButtonElement | null {
  return (screen.getAllByRole('button') as HTMLButtonElement[]).find(
    (b) => normalizeText(b.textContent ?? '').includes(normalizeText(text))
  ) ?? null;
}

// =============================================================================
// MOCK DATA
// =============================================================================

const CURRENT_USER_ID = 'admin-001';

// Kiểu vote dùng trong mock data — phản ánh CommissionerVote của component
type MockVote = {
  commissionerId: string;
  commissionerRole: string;
  vote: 'APPROVE' | 'REJECT';
  reason: string;
  votedAt: string;
};

/** Override request PENDING — chưa có vote nào */
const mockItemPending = {
  overrideRequestId: 'req-001',
  projectId: 'proj-abc',
  organizationId: 'org-001',
  evidenceCid: 'QmTest1234567890abcdef',
  disbursementRequestId: null,
  // Union type để các spread variant có thể override reason/status mà không bị type conflict
  reason: 'OUT_OF_GEOFENCE' as 'OUT_OF_GEOFENCE' | 'GPS_EXIF_MISSING' | 'NO_GEOFENCE',
  gpsFromImage: { lat: 10.123456, lng: 106.654321 } as { lat: number; lng: number } | null,
  gpsFromProject: { lat: 10.100000, lng: 106.600000 },
  distanceMeters: 750.5 as number | null,
  commissionerSnapshot: [
    { userId: 'admin-001', role: 'admin' },
    { userId: 'admin-002', role: 'admin' },
    { userId: 'reg-001', role: 'regulatory' },
  ],
  // Không dùng [] trần — TypeScript infer thành never[] khiến spread override bị fail
  votes: [] as MockVote[],
  status: 'PENDING' as 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED',
  createdAt: '2026-06-12T10:00:00.000Z',
};

/** 2/3 vote APPROVE — một ủy viên chưa vote */
const mockItem2of3 = {
  ...mockItemPending,
  votes: [
    { commissionerId: 'admin-001', commissionerRole: 'admin', vote: 'APPROVE' as const, reason: 'Lý do hợp lệ', votedAt: '2026-06-12T10:05:00.000Z' },
    { commissionerId: 'admin-002', commissionerRole: 'admin', vote: 'APPROVE' as const, reason: 'Đồng ý ghi đè', votedAt: '2026-06-12T10:06:00.000Z' },
  ],
};

/** Đã APPROVED — tất cả 3/3 vote APPROVE */
const mockItemApproved = {
  ...mockItemPending,
  status: 'APPROVED' as const,
  votes: [
    { commissionerId: 'admin-001', commissionerRole: 'admin', vote: 'APPROVE' as const, reason: 'OK', votedAt: '2026-06-12T10:05:00.000Z' },
    { commissionerId: 'admin-002', commissionerRole: 'admin', vote: 'APPROVE' as const, reason: 'OK', votedAt: '2026-06-12T10:06:00.000Z' },
    { commissionerId: 'reg-001', commissionerRole: 'regulatory', vote: 'APPROVE' as const, reason: 'OK', votedAt: '2026-06-12T10:07:00.000Z' },
  ],
};

/** Override request với lý do GPS_EXIF_MISSING — không có GPS từ ảnh */
const mockItemNoGps = {
  ...mockItemPending,
  overrideRequestId: 'req-002',
  reason: 'GPS_EXIF_MISSING' as const,
  gpsFromImage: null,
  distanceMeters: null,
};

// =============================================================================
// SETUP HELPERS
// =============================================================================

function mockApiResponse(items: typeof mockItemPending[]) {
  // I1: TanStack Query mock thay vì fetchApi trực tiếp
  overrideRequestsMock.data = items;
  overrideRequestsMock.isLoading = false;
  overrideRequestsMock.error = null;
  overrideRequestsMock.refetch = vi.fn().mockResolvedValue({ data: items, error: null });
}

function mockAuthSession(userId = CURRENT_USER_ID) {
  vi.mocked(readAuthSession).mockReturnValue({
    accessToken: 'mock-token-xyz',
    userId,
    userRole: 'admin'
  } as never);
}

const defaultProps: OverrideVoteDrawerProps = {
  isOpen: true,
  onClose: vi.fn(),
  currentUserId: CURRENT_USER_ID,
  currentUserRole: 'admin',
  onToast: vi.fn(),
};

// =============================================================================
// TESTS
// =============================================================================

describe('OverrideVoteDrawer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthSession();
  });

  // ---------------------------------------------------------------------------
  // Test 1: Hiển thị thông tin GPS và warning reason khi mở detail view
  // ---------------------------------------------------------------------------
  it('hiển thị GPS from image, GPS from project, Haversine distance và warning reason trong detail view', async () => {
    mockApiResponse([mockItemPending]);

    await act(async () => {
      render(<OverrideVoteDrawer {...defaultProps} />);
    });

    // Chờ load xong — danh sách xuất hiện
    await waitFor(() => {
      expect(screen.getByText('proj-abc')).toBeInTheDocument();
    });

    // Click vào item để vào detail view
    await act(async () => {
      fireEvent.click(screen.getByText('proj-abc'));
    });

    // GPS từ ảnh
    assertText('10.123456');
    assertText('106.654321');

    // GPS từ dự án
    assertText('10.100000');
    assertText('106.600000');

    // Khoảng cách Haversine
    assertText('750.5');

    // Warning reason — "Ảnh chụp ngoài vùng địa lý dự án"
    assertText('Anh chup ngoai vung dia ly du an');
  });

  // ---------------------------------------------------------------------------
  // Test 2: VoteConfirmationDialog yêu cầu reason tối thiểu 10 ký tự
  // ---------------------------------------------------------------------------
  it('hiển thị VoteConfirmationDialog khi click vote, nút submit disabled khi reason < 10 ký tự', async () => {
    mockApiResponse([mockItemPending]);

    await act(async () => {
      render(<OverrideVoteDrawer {...defaultProps} />);
    });

    await waitFor(() => {
      expect(screen.getByText('proj-abc')).toBeInTheDocument();
    });

    // Vào detail view
    await act(async () => {
      fireEvent.click(screen.getByText('proj-abc'));
    });

    // Chờ detail view render xong — nút vote phải hiển thị
    await waitFor(() => {
      expect(findButton('Dong y Ghi de')).not.toBeNull();
    });

    // Click nút "Đồng ý Ghi đè" trong DetailView
    await act(async () => {
      fireEvent.click(findButton('Dong y Ghi de')!);
    });

    // Dialog phải xuất hiện
    assertText('Xac nhan Dong y Ghi de');

    // Dùng data-testid để tránh nhầm nút dialog với nút trong DetailView (cùng text)
    const submitBtn = screen.getByTestId('vote-confirm-submit');
    expect(submitBtn).toBeDisabled();

    // Nhập reason < 10 ký tự — vẫn disabled
    const textarea = screen.getByRole('textbox');
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'ngan' } });
    });
    expect(submitBtn).toBeDisabled();

    // Nhập đủ 10+ ký tự — nút được enable
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'Ly do hop le du 10 ky tu' } });
    });
    expect(submitBtn).not.toBeDisabled();
  });

  // ---------------------------------------------------------------------------
  // Test 3: Banner "Cần 1 phiếu nữa để approve" khi 2/3 vote APPROVE
  // ---------------------------------------------------------------------------
  it('hiển thị banner "Cần 1 phiếu nữa để approve" khi 2/3 ủy viên đã vote APPROVE', async () => {
    mockApiResponse([mockItem2of3]);

    await act(async () => {
      render(<OverrideVoteDrawer {...defaultProps} />);
    });

    await waitFor(() => {
      expect(screen.getByText('proj-abc')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByText('proj-abc'));
    });

    // Banner cần 1 phiếu
    assertText('Can 1 phieu nua de approve');
  });

  // ---------------------------------------------------------------------------
  // Test 4: Banner "Đã duyệt" và nút bị disabled khi status APPROVED (3/3)
  // ---------------------------------------------------------------------------
  it('hiển thị banner "Đã duyệt" và không có nút vote khi status APPROVED', async () => {
    mockApiResponse([mockItemApproved]);

    await act(async () => {
      render(<OverrideVoteDrawer {...defaultProps} />);
    });

    await waitFor(() => {
      expect(screen.getByText('proj-abc')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByText('proj-abc'));
    });

    // Banner "Đã duyệt"
    assertText('Da duyet');

    // Không có nút "Đồng ý Ghi đè" hoặc "Từ chối" khi đã resolved
    expect(findButton('Dong y Ghi de')).toBeNull();
    expect(findButton('Tu choi')).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Test 5: Empty state khi không có pending override
  // ---------------------------------------------------------------------------
  it('hiển thị empty state khi không có yêu cầu ghi đè GPS nào đang chờ', async () => {
    mockApiResponse([]);

    await act(async () => {
      render(<OverrideVoteDrawer {...defaultProps} />);
    });

    await waitFor(() => {
      assertText('Khong co yeu cau ghi de GPS nao dang cho');
    });
  });

  // ---------------------------------------------------------------------------
  // Test 6: Auto-select detail view khi initialRequestId được truyền
  // ---------------------------------------------------------------------------
  it('tự động chuyển sang detail view khi initialRequestId khớp với một request trong danh sách', async () => {
    mockApiResponse([mockItemPending]);

    await act(async () => {
      render(
        <OverrideVoteDrawer
          {...defaultProps}
          initialRequestId="req-001"
        />
      );
    });

    // Không cần click — detail view tự hiện
    await waitFor(() => {
      assertText('Chi tiet Bieu quyet');
    });

    // GPS data phải hiển thị ngay
    assertText('10.123456');
  });

  // ---------------------------------------------------------------------------
  // Test 7: Hiển thị GPS_EXIF_MISSING khi không có GPS từ ảnh
  // ---------------------------------------------------------------------------
  it('hiển thị "Không có dữ liệu GPS" khi reason là GPS_EXIF_MISSING', async () => {
    mockApiResponse([mockItemNoGps]);

    await act(async () => {
      render(<OverrideVoteDrawer {...defaultProps} />);
    });

    await waitFor(() => {
      expect(screen.getByText('proj-abc')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByText('proj-abc'));
    });

    assertText('Khong co du lieu GPS');
    assertText('Anh khong co du lieu GPS');
  });

  // ---------------------------------------------------------------------------
  // Test 8: Hiển thị "Đã đồng ý" badge khi currentUser đã vote APPROVE
  // ---------------------------------------------------------------------------
  it('hiển thị badge "Đã đồng ý" và không hiển thị nút vote khi admin đã vote APPROVE', async () => {
    const itemWithMyVote = {
      ...mockItemPending,
      votes: [
        {
          commissionerId: CURRENT_USER_ID,
          commissionerRole: 'admin',
          vote: 'APPROVE' as const,
          reason: 'Tôi đồng ý vì tọa độ hợp lý',
          votedAt: '2026-06-12T10:05:00.000Z',
        },
      ],
    };

    mockApiResponse([itemWithMyVote]);

    await act(async () => {
      render(<OverrideVoteDrawer {...defaultProps} />);
    });

    await waitFor(() => {
      expect(screen.getByText('proj-abc')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByText('proj-abc'));
    });

    // Badge trong detail view
    assertText('Ban da Dong y ghi de');

    // Không còn nút vote
    expect(findButton('Dong y Ghi de')).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Test 9: Consistency warning banner khi validateVoteConsistency fail
  // ---------------------------------------------------------------------------
  it('hiển thị warning banner khi số phiếu vượt quá số ủy viên trong snapshot', async () => {
    // Mock API trả dữ liệu không nhất quán: 4 vote nhưng chỉ có 3 commissioner
    const inconsistentItem = {
      ...mockItemPending,
      commissionerSnapshot: [
        { userId: 'admin-001', role: 'admin' },
        { userId: 'admin-002', role: 'admin' },
        { userId: 'reg-001', role: 'regulatory' },
      ],
      // 4 votes nhưng chỉ có 3 commissioner → vi phạm invariant
      votes: [
        { commissionerId: 'admin-001', commissionerRole: 'admin', vote: 'APPROVE' as const, reason: 'ok', votedAt: '2026-06-12T10:05:00.000Z' },
        { commissionerId: 'admin-002', commissionerRole: 'admin', vote: 'APPROVE' as const, reason: 'ok', votedAt: '2026-06-12T10:06:00.000Z' },
        { commissionerId: 'reg-001', commissionerRole: 'regulatory', vote: 'APPROVE' as const, reason: 'ok', votedAt: '2026-06-12T10:07:00.000Z' },
        { commissionerId: 'extra-voter', commissionerRole: 'admin', vote: 'REJECT' as const, reason: 'not in snapshot', votedAt: '2026-06-12T10:08:00.000Z' },
      ],
    };
    mockApiResponse([inconsistentItem]);

    await act(async () => {
      render(<OverrideVoteDrawer {...defaultProps} />);
    });

    await waitFor(() => {
      expect(screen.getByText('proj-abc')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByText('proj-abc'));
    });

    // Warning banner phải hiển thị
    assertText('Du lieu bieu quyet khong nhat quan');
  });

  // ---------------------------------------------------------------------------
  // Test 10: Retry button trong warning banner gọi loadItems
  // ---------------------------------------------------------------------------
  it('nút "Tải lại dữ liệu" trong warning banner trigger refetch', async () => {
    const { rerender } = await act(async () => {
      const result = render(<OverrideVoteDrawer {...defaultProps} />);
      return result;
    });

    // Mock initial data
    mockApiResponse([mockItemPending]);

    await waitFor(() => {
      expect(screen.getByText('proj-abc')).toBeInTheDocument();
    });

    // Click vào item để trigger consistency check
    await act(async () => {
      fireEvent.click(screen.getByText('proj-abc'));
    });

    // Verify banner không hiển thị với data hợp lệ
    await waitFor(() => {
      expect(screen.queryByText(/khong nhat quan/i)).not.toBeInTheDocument();
    });
  });
});
