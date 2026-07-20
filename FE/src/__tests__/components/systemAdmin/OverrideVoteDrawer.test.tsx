/**
 * Test cases cho OverrideVoteDrawer component (B4).
 * Bao gồm:
 * - Hiển thị thông tin GPS, VoteConfirmationDialog
 * - Banner trạng thái (2/3 vote, đã duyệt, đã từ chối)
 * - Empty state, auto-select từ initialRequestId
 * - REJECT flow (button, dialog, banner, toast RESOLVED_REJECTED)
 * - API error handling (409/410/403/generic)
 * - Boundary test reason length (9 vs 10 ký tự)
 * - User không có trong commissionerSnapshot
 * - Retry button trong warning banner gọi refetch đúng cách
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

// GeofenceMapLazy dùng next/dynamic (Leaflet DOM-only) — trong Vitest/jsdom không lazy-load thật.
// Mock expose đủ snapshot/marker metadata để assertion bắt được mapping B3, không chỉ đếm marker.
vi.mock('@/app/components/oracle/GeofenceMapLazy', () => ({
  GeofenceMapLazy: (props: {
    snapshot?: {
      radiusMeters: number;
      centroid?: { lat: number; lng: number };
      polygon?: Array<{ lat: number; lng: number }>;
    } | null;
    markers?: Array<{
      status?: string;
      coordinate?: { lat: number; lng: number } | null;
    }>;
  }) => {
    const markerCoordinates = props.markers
      ?.map((marker) => marker.coordinate ? `${marker.coordinate.lat},${marker.coordinate.lng}` : 'null')
      .join('|') ?? '';

    return (
      <div
        data-testid="geofence-map-mock"
        data-centroid={props.snapshot?.centroid ? `${props.snapshot.centroid.lat},${props.snapshot.centroid.lng}` : 'null'}
        data-markers={String(props.markers?.length ?? 0)}
        data-marker-coordinates={markerCoordinates}
        data-marker-statuses={props.markers?.map((marker) => marker.status ?? '').join('|') ?? ''}
        data-polygon-points={String(props.snapshot?.polygon?.length ?? 0)}
        data-radius={props.snapshot ? String(props.snapshot.radiusMeters) : 'null'}
      />
    );
  },
}));

// Mock TanStack Query hooks để có thể control data/error/loading per test
type MockOverrideItem = Record<string, unknown> & {
  overrideRequestId: string;
  commissionerSnapshot: Array<{ role: string; isCurrentUser: boolean }>;
  votes: Array<{ commissionerId: string; vote: 'APPROVE' | 'REJECT'; reason: string; commissionerRole: string; votedAt: string }>;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED';
};

const overrideRequestsMock: {
  data: MockOverrideItem[];
  isLoading: boolean;
  error: unknown;
  refetch: ReturnType<typeof vi.fn>;
} = {
  data: [],
  isLoading: false,
  error: null,
  refetch: vi.fn().mockResolvedValue({ data: [], error: null }),
};

type SubmitResult = {
  outcome: 'VOTE_RECORDED' | 'RESOLVED_APPROVED' | 'RESOLVED_REJECTED';
  pendingVoters?: number;
  totalVoters?: number;
  disbursementAutoApproved?: boolean;
};
type SubmitError = {
  statusCode?: number;
  errorCode?: string;
  message?: string;
};
const submitVoteMock: {
  mutateAsync: ReturnType<typeof vi.fn>;
} = {
  mutateAsync: vi.fn()
};

// [B3-FE-02] Mock detail hook — trả geofenceSnapshot cho DetailView. Mặc định snapshot=null.
const detailMock: {
  data: unknown;
  isLoading: boolean;
  error: unknown;
  refetch: ReturnType<typeof vi.fn>;
} = {
  data: undefined,
  isLoading: false,
  error: null,
  refetch: vi.fn().mockResolvedValue({ data: undefined, error: null }),
};

// Ghi nhận id được truyền vào useOverrideRequestDetail để assert lazy-fetch (list = null).
const detailHookSpy = vi.fn();

vi.mock('@/app/hooks/useOverrideRequests', () => ({
  useOverrideRequests: vi.fn(() => ({ ...overrideRequestsMock })),
  useOverrideRequestDetail: vi.fn((id: string | null | undefined) => {
    detailHookSpy(id);
    return { ...detailMock };
  }),
  useSubmitOverrideVote: vi.fn(() => ({ ...submitVoteMock })),
}));

import { readAuthSession } from '@/app/utils/authSession';
import OverrideVoteDrawer from '@/app/components/systemAdmin/tailwind/OverrideVoteDrawer';
import type { OverrideVoteDrawerProps } from '@/app/components/systemAdmin/tailwind/OverrideVoteDrawer';

// =============================================================================
// HELPERS — xử lý tiếng Việt có dấu trong DOM
// =============================================================================

/**
 * Chuẩn hoá tiếng Việt: NFD → bỏ combining marks → lowercase → thay thế ký tự đặc biệt.
 * toLowerCase() phải đứng TRƯỚC map để 'Đ' → 'đ' → 'd' (không phải 'Đ' → 'đ' bị bỏ sót).
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

// Mock item với shape từ BE (sau khi BE redact userId trong snapshot)
const baseMockItem = {
  overrideRequestId: 'req-001',
  projectId: 'proj-abc',
  organizationId: 'org-001',
  evidenceCid: 'QmTest1234567890abcdef',
  disbursementRequestId: null,
  reason: 'OUT_OF_GEOFENCE' as 'OUT_OF_GEOFENCE' | 'GPS_EXIF_MISSING' | 'NO_GEOFENCE',
  gpsFromImage: { lat: 10.123456, lng: 106.654321 } as { lat: number; lng: number } | null,
  gpsFromProject: { lat: 10.100000, lng: 106.600000 },
  distanceMeters: 750.5 as number | null,
  // Snapshot đã được BE redact → chỉ còn role + isCurrentUser
  commissionerSnapshot: [
    { role: 'admin', isCurrentUser: true },
    { role: 'admin', isCurrentUser: false },
    { role: 'regulatory', isCurrentUser: false },
  ],
  votes: [] as Array<{ commissionerId: string; vote: 'APPROVE' | 'REJECT'; reason: string; commissionerRole: string; votedAt: string }>,
  status: 'PENDING' as 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED',
  createdAt: '2026-06-12T10:00:00.000Z',
};

/** 2/3 vote APPROVE — một ủy viên chưa vote */
const mockItem2of3 = {
  ...baseMockItem,
  votes: [
    { commissionerId: 'admin-001', commissionerRole: 'admin', vote: 'APPROVE' as const, reason: 'Lý do hợp lệ', votedAt: '2026-06-12T10:05:00.000Z' },
    { commissionerId: 'admin-002', commissionerRole: 'admin', vote: 'APPROVE' as const, reason: 'Đồng ý ghi đè', votedAt: '2026-06-12T10:06:00.000Z' },
  ],
};

/** Đã APPROVED — tất cả 3/3 vote APPROVE */
const mockItemApproved = {
  ...baseMockItem,
  status: 'APPROVED' as const,
  votes: [
    { commissionerId: 'admin-001', commissionerRole: 'admin', vote: 'APPROVE' as const, reason: 'OK', votedAt: '2026-06-12T10:05:00.000Z' },
    { commissionerId: 'admin-002', commissionerRole: 'admin', vote: 'APPROVE' as const, reason: 'OK', votedAt: '2026-06-12T10:06:00.000Z' },
    { commissionerId: 'reg-001', commissionerRole: 'regulatory', vote: 'APPROVE' as const, reason: 'OK', votedAt: '2026-06-12T10:07:00.000Z' },
  ],
};

/** Đã REJECTED — một phiếu REJECT */
const mockItemRejected = {
  ...baseMockItem,
  status: 'REJECTED' as const,
  votes: [
    { commissionerId: 'admin-002', commissionerRole: 'admin', vote: 'REJECT' as const, reason: 'Không hợp lý', votedAt: '2026-06-12T10:05:00.000Z' },
  ],
};

/** Item với lý do GPS_EXIF_MISSING — không có GPS từ ảnh */
const mockItemNoGps = {
  ...baseMockItem,
  overrideRequestId: 'req-002',
  reason: 'GPS_EXIF_MISSING' as const,
  gpsFromImage: null,
  distanceMeters: null,
};

/** Item user hiện tại KHÔNG có trong snapshot */
const mockItemNotInSnapshot = {
  ...baseMockItem,
  commissionerSnapshot: [
    { role: 'admin', isCurrentUser: false },
    { role: 'regulatory', isCurrentUser: false },
  ],
};

// =============================================================================
// SETUP HELPERS
// =============================================================================

function mockApiResponse(items: MockOverrideItem[]) {
  overrideRequestsMock.data = items;
  overrideRequestsMock.isLoading = false;
  overrideRequestsMock.error = null;
  overrideRequestsMock.refetch = vi.fn().mockResolvedValue({ data: items, error: null });
}

function mockApiError(error: unknown) {
  overrideRequestsMock.data = [];
  overrideRequestsMock.isLoading = false;
  overrideRequestsMock.error = error;
}

function mockAuthSession(userId = CURRENT_USER_ID) {
  vi.mocked(readAuthSession).mockReturnValue({
    accessToken: 'mock-token-xyz',
    userId,
    userRole: 'admin'
  } as never);
}

function mockLoading() {
  overrideRequestsMock.data = [];
  overrideRequestsMock.isLoading = true;
  overrideRequestsMock.error = null;
  overrideRequestsMock.refetch = vi.fn().mockImplementation(async () => {
    return new Promise(() => {}) as never; // never resolves → stays loading
  });
}

function mockSubmitSuccess(result: SubmitResult) {
  submitVoteMock.mutateAsync.mockReset();
  submitVoteMock.mutateAsync.mockResolvedValue(result);
}

function mockSubmitError(error: SubmitError) {
  submitVoteMock.mutateAsync.mockReset();
  submitVoteMock.mutateAsync.mockRejectedValue(error);
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
    mockSubmitSuccess({ outcome: 'VOTE_RECORDED', pendingVoters: 2, totalVoters: 3 });
    // [B3-FE-02] Reset detail hook mock về mặc định (chưa có snapshot).
    detailMock.data = undefined;
    detailMock.isLoading = false;
    detailMock.error = null;
    detailMock.refetch = vi.fn().mockResolvedValue({ data: undefined, error: null });
  });

  // ---------------------------------------------------------------------------
  // Test 1: Hiển thị thông tin GPS và warning reason khi mở detail view
  // ---------------------------------------------------------------------------
  it('hiển thị GPS from image, GPS from project, Haversine distance và warning reason trong detail view', async () => {
    mockApiResponse([baseMockItem]);

    await act(async () => {
      render(<OverrideVoteDrawer {...defaultProps} />);
    });

    await waitFor(() => {
      expect(screen.getByText('proj-abc')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByText('proj-abc'));
    });

    assertText('10.123456');
    assertText('106.654321');
    assertText('10.100000');
    assertText('106.600000');
    assertText('750.5');
    assertText('Anh chup ngoai vung dia ly du an');
    expect(normalizeText(document.body.textContent ?? '')).not.toContain(normalizeText('Vuot nguong'));
  });

  // ---------------------------------------------------------------------------
  // Test 2: VoteConfirmationDialog yêu cầu reason tối thiểu 10 ký tự (9 vs 10 boundary)
  // ---------------------------------------------------------------------------
  it('submit button disabled khi reason 9 ký tự, enabled khi đủ 10 ký tự', async () => {
    mockApiResponse([baseMockItem]);

    await act(async () => {
      render(<OverrideVoteDrawer {...defaultProps} />);
    });

    await waitFor(() => {
      expect(screen.getByText('proj-abc')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByText('proj-abc'));
    });

    await waitFor(() => {
      expect(findButton('Dong y Ghi de')).not.toBeNull();
    });

    await act(async () => {
      fireEvent.click(findButton('Dong y Ghi de')!);
    });

    assertText('Xac nhan Dong y Ghi de');
    const submitBtn = screen.getByTestId('vote-confirm-submit');
    expect(submitBtn).toBeDisabled();

    const textarea = screen.getByRole('textbox');

    // Boundary: 9 ký tự → vẫn disabled
    const nineCharReason = '123456789';
    expect(nineCharReason.length).toBe(9);
    await act(async () => {
      fireEvent.change(textarea, { target: { value: nineCharReason } });
    });
    expect(submitBtn).toBeDisabled();

    // Boundary: 10 ký tự → enabled
    const tenCharReason = '1234567890';
    expect(tenCharReason.length).toBe(10);
    await act(async () => {
      fireEvent.change(textarea, { target: { value: tenCharReason } });
    });
    expect(submitBtn).not.toBeDisabled();
  });

  // ---------------------------------------------------------------------------
  // Test 2b: Escape trong dialog → onCancel được gọi (đóng dialog)
  // ---------------------------------------------------------------------------
  it('Escape trong VoteConfirmationDialog đóng dialog (gọi onCancel) khi không submitting', async () => {
    mockApiResponse([baseMockItem]);

    await act(async () => {
      render(<OverrideVoteDrawer {...defaultProps} />);
    });

    await waitFor(() => {
      expect(screen.getByText('proj-abc')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByText('proj-abc'));
    });

    await waitFor(() => {
      expect(findButton('Dong y Ghi de')).not.toBeNull();
    });

    await act(async () => {
      fireEvent.click(findButton('Dong y Ghi de')!);
    });

    // Dialog xác nhận hiển thị
    await waitFor(() => {
      expect(screen.getByText('Xác nhận Đồng ý Ghi đè')).toBeInTheDocument();
    });

    // Lấy dialog chứa nội dung xác nhận (cụ thể — tránh match drawer ngoài)
    const dialogs = screen.getAllByRole('dialog');
    const confirmDialog = dialogs.find((d) => d.textContent?.includes('Xác nhận Đồng ý Ghi đè'));
    expect(confirmDialog).toBeDefined();

    await act(async () => {
      fireEvent.keyDown(confirmDialog!, { key: 'Escape' });
    });

    // Sau Escape, dialog xác nhận không còn → onCancel path được trigger
    await waitFor(() => {
      expect(screen.queryByText('Xác nhận Đồng ý Ghi đè')).not.toBeInTheDocument();
    });
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

    assertText('Da duyet');
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
    mockApiResponse([baseMockItem]);

    await act(async () => {
      render(
        <OverrideVoteDrawer
          {...defaultProps}
          initialRequestId="req-001"
        />
      );
    });

    await waitFor(() => {
      assertText('Chi tiet Bieu quyet');
    });

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
    const map = screen.getByTestId('geofence-map-mock');
    expect(map.getAttribute('data-marker-statuses')).toBe('NO_GPS');
    expect(map.getAttribute('data-marker-coordinates')).toBe('null');
  });

  // ---------------------------------------------------------------------------
  // Test 8: Hiển thị "Đã đồng ý" badge khi currentUser đã vote APPROVE
  // ---------------------------------------------------------------------------
  it('hiển thị badge "Đã đồng ý" và không hiển thị nút vote khi admin đã vote APPROVE', async () => {
    const itemWithMyVote = {
      ...baseMockItem,
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

    assertText('Ban da Dong y ghi de');
    expect(findButton('Dong y Ghi de')).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Test 9: Consistency warning banner khi validateVoteConsistency fail
  // ---------------------------------------------------------------------------
  it('hiển thị warning banner khi số phiếu vượt quá số ủy viên trong snapshot', async () => {
    const inconsistentItem = {
      ...baseMockItem,
      // Chỉ giữ 3 commissioner trong snapshot, nhưng votes có 4 entry → invariant violated
      commissionerSnapshot: [
        { role: 'admin', isCurrentUser: true },
        { role: 'admin', isCurrentUser: false },
        { role: 'regulatory', isCurrentUser: false },
      ],
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

    assertText('Du lieu bieu quyet khong nhat quan');
  });

  // ---------------------------------------------------------------------------
  // Test 10 [BLOCKER FIX]: Nút "Tải lại dữ liệu" trong warning banner gọi refetch
  // ---------------------------------------------------------------------------
  it('[B4-fix] nút "Tải lại dữ liệu" trong warning banner gọi refetch', async () => {
    // Mock data KHÔNG nhất quán: 4 votes nhưng snapshot chỉ có 3 → trigger warning
    const inconsistentItem = {
      ...baseMockItem,
      commissionerSnapshot: [
        { role: 'admin', isCurrentUser: true },
        { role: 'admin', isCurrentUser: false },
        { role: 'regulatory', isCurrentUser: false },
      ],
      votes: [
        { commissionerId: 'admin-001', commissionerRole: 'admin', vote: 'APPROVE' as const, reason: 'ok', votedAt: '2026-06-12T10:05:00.000Z' },
        { commissionerId: 'admin-002', commissionerRole: 'admin', vote: 'APPROVE' as const, reason: 'ok', votedAt: '2026-06-12T10:06:00.000Z' },
        { commissionerId: 'reg-001', commissionerRole: 'regulatory', vote: 'APPROVE' as const, reason: 'ok', votedAt: '2026-06-12T10:07:00.000Z' },
        { commissionerId: 'extra-voter', commissionerRole: 'admin', vote: 'REJECT' as const, reason: 'not in snapshot', votedAt: '2026-06-12T10:08:00.000Z' },
      ],
    };

    // Capture lại số lần refetch được gọi TRƯỚC khi render
    const refetchSpy = vi.fn().mockResolvedValue({ data: [inconsistentItem], error: null });
    overrideRequestsMock.data = [inconsistentItem];
    overrideRequestsMock.isLoading = false;
    overrideRequestsMock.error = null;
    overrideRequestsMock.refetch = refetchSpy;

    await act(async () => {
      render(<OverrideVoteDrawer {...defaultProps} />);
    });

    await waitFor(() => {
      expect(screen.getByText('proj-abc')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByText('proj-abc'));
    });

    // Warning banner xuất hiện
    await waitFor(() => {
      assertText('Du lieu bieu quyet khong nhat quan');
    });

    // Nút "Tải lại dữ liệu" được render
    const retryBtn = findButton('Tai lai du lieu');
    expect(retryBtn).not.toBeNull();

    // Click → refetch spy phải được gọi
    await act(async () => {
      fireEvent.click(retryBtn!);
    });

    await waitFor(() => {
      expect(refetchSpy).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Test 11: REJECT vote flow — button → dialog → submit → RESOLVED_REJECTED toast
  // ---------------------------------------------------------------------------
  it('REJECT flow: button → dialog → submit → toast RESOLVED_REJECTED', async () => {
    mockApiResponse([baseMockItem]);
    mockSubmitSuccess({ outcome: 'RESOLVED_REJECTED' });
    const onToastMock = vi.fn();

    await act(async () => {
      render(<OverrideVoteDrawer {...defaultProps} onToast={onToastMock} />);
    });

    await waitFor(() => {
      expect(screen.getByText('proj-abc')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByText('proj-abc'));
    });

    await waitFor(() => {
      expect(findButton('Tu choi')).not.toBeNull();
    });

    // Click "Từ chối"
    await act(async () => {
      fireEvent.click(findButton('Tu choi')!);
    });

    // Dialog xác nhận REJECT
    assertText('Xac nhan Tu choi Ghi de');
    assertText('Mot phieu tu choi se ket thuc ngay');

    // Nhập reason đủ dài
    const textarea = screen.getByRole('textbox');
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'Toa do qua xa khoi vung du an' } });
    });

    const submitBtn = screen.getByTestId('vote-confirm-submit');
    expect(submitBtn).not.toBeDisabled();

    await act(async () => {
      fireEvent.click(submitBtn);
    });

    // mutateAsync được gọi với vote: REJECT
    await waitFor(() => {
      expect(submitVoteMock.mutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          overrideRequestId: 'req-001',
          vote: 'REJECT'
        })
      );
    });

    // Toast RESOLVED_REJECTED được hiển thị với tone: warning
    await waitFor(() => {
      expect(onToastMock).toHaveBeenCalledWith(
        expect.objectContaining({
          tone: 'warning'
        })
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Test 12: REJECTED banner khi status REJECTED với 1 phiếu reject
  // ---------------------------------------------------------------------------
  it('hiển thị banner "Đã bị từ chối" khi status REJECTED với 1 phiếu reject', async () => {
    mockApiResponse([mockItemRejected]);

    await act(async () => {
      render(<OverrideVoteDrawer {...defaultProps} />);
    });

    await waitFor(() => {
      expect(screen.getByText('proj-abc')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByText('proj-abc'));
    });

    assertText('Da bi tu choi');
    expect(findButton('Dong y Ghi de')).toBeNull();
    expect(findButton('Tu choi')).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Test 13: API error 409 ALREADY_VOTED → toast warning
  // ---------------------------------------------------------------------------
  it('API error 409 ALREADY_VOTED → toast cảnh báo "Bạn đã biểu quyết rồi"', async () => {
    mockApiResponse([baseMockItem]);
    mockSubmitError({ statusCode: 409, errorCode: 'ALREADY_VOTED', message: 'Already voted' });
    const onToastMock = vi.fn();

    await act(async () => {
      render(<OverrideVoteDrawer {...defaultProps} onToast={onToastMock} />);
    });

    await waitFor(() => {
      expect(screen.getByText('proj-abc')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByText('proj-abc'));
    });

    await waitFor(() => {
      expect(findButton('Dong y Ghi de')).not.toBeNull();
    });

    await act(async () => {
      fireEvent.click(findButton('Dong y Ghi de')!);
    });

    const textarea = screen.getByRole('textbox');
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'Ly do du 10 ky tu' } });
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('vote-confirm-submit'));
    });

    await waitFor(() => {
      expect(onToastMock).toHaveBeenCalledWith(
        expect.objectContaining({
          tone: 'warning',
          titleText: 'Bạn đã biểu quyết rồi',
          bodyText: 'Mỗi ủy viên chỉ được vote một lần.'
        })
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Test 14: API error 410 GONE → toast warning với strong title/body
  // ---------------------------------------------------------------------------
  it('API error 410 GONE → toast "Yêu cầu đã hết hiệu lực"', async () => {
    mockApiResponse([baseMockItem]);
    mockSubmitError({ statusCode: 410, message: 'Gone' });
    const onToastMock = vi.fn();

    await act(async () => {
      render(<OverrideVoteDrawer {...defaultProps} onToast={onToastMock} />);
    });

    await waitFor(() => {
      expect(screen.getByText('proj-abc')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByText('proj-abc'));
    });

    await act(async () => {
      fireEvent.click(findButton('Dong y Ghi de')!);
    });

    const textarea = screen.getByRole('textbox');
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'Ly do du 10 ky tu' } });
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('vote-confirm-submit'));
    });

    await waitFor(() => {
      expect(onToastMock).toHaveBeenCalledWith(
        expect.objectContaining({
          tone: 'warning',
          titleText: 'Yêu cầu đã hết hiệu lực',
          bodyText: expect.stringContaining('Danh sách ủy viên thay đổi')
        })
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Test 15: API error 403 → toast lỗi
  // ---------------------------------------------------------------------------
  it('API error 403 → toast "Không có quyền biểu quyết"', async () => {
    mockApiResponse([baseMockItem]);
    mockSubmitError({ statusCode: 403, message: 'Forbidden' });
    const onToastMock = vi.fn();

    await act(async () => {
      render(<OverrideVoteDrawer {...defaultProps} onToast={onToastMock} />);
    });

    await waitFor(() => {
      expect(screen.getByText('proj-abc')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByText('proj-abc'));
    });

    await act(async () => {
      fireEvent.click(findButton('Dong y Ghi de')!);
    });

    const textarea = screen.getByRole('textbox');
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'Ly do du 10 ky tu' } });
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('vote-confirm-submit'));
    });

    await waitFor(() => {
      expect(onToastMock).toHaveBeenCalledWith(
        expect.objectContaining({
          tone: 'error',
          titleText: 'Không có quyền biểu quyết',
          bodyText: 'Bạn không có trong danh sách ủy viên của yêu cầu này.'
        })
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Test 16: Generic API error 500 → toast lỗi mặc định
  // ---------------------------------------------------------------------------
  it('API error generic 500 → toast "Biểu quyết thất bại" với message lỗi', async () => {
    mockApiResponse([baseMockItem]);
    mockSubmitError({ statusCode: 500, message: 'Internal Server Error' });
    const onToastMock = vi.fn();

    await act(async () => {
      render(<OverrideVoteDrawer {...defaultProps} onToast={onToastMock} />);
    });

    await waitFor(() => {
      expect(screen.getByText('proj-abc')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByText('proj-abc'));
    });

    await act(async () => {
      fireEvent.click(findButton('Dong y Ghi de')!);
    });

    const textarea = screen.getByRole('textbox');
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'Ly do du 10 ky tu' } });
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('vote-confirm-submit'));
    });

    await waitFor(() => {
      expect(onToastMock).toHaveBeenCalledWith(
        expect.objectContaining({
          tone: 'error',
          bodyText: 'Internal Server Error'
        })
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Test 17: User KHÔNG có trong commissionerSnapshot → không hiển thị nút vote
  // ---------------------------------------------------------------------------
  it('không hiển thị nút vote khi user không có trong commissionerSnapshot', async () => {
    mockApiResponse([mockItemNotInSnapshot]);

    await act(async () => {
      render(<OverrideVoteDrawer {...defaultProps} />);
    });

    await waitFor(() => {
      expect(screen.getByText('proj-abc')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByText('proj-abc'));
    });

    assertText('khong co trong danh sach uy vien');
    expect(findButton('Dong y Ghi de')).toBeNull();
    expect(findButton('Tu choi')).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Test 18: RESOLVED_APPROVED toast có disbursementAutoApproved
  // ---------------------------------------------------------------------------
  it('RESOLVED_APPROVED toast hiển thị thông báo auto-approve disbursement', async () => {
    mockApiResponse([baseMockItem]);
    mockSubmitSuccess({ outcome: 'RESOLVED_APPROVED', disbursementAutoApproved: true });
    const onToastMock = vi.fn();

    await act(async () => {
      render(<OverrideVoteDrawer {...defaultProps} onToast={onToastMock} />);
    });

    await waitFor(() => {
      expect(screen.getByText('proj-abc')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByText('proj-abc'));
    });

    await act(async () => {
      fireEvent.click(findButton('Dong y Ghi de')!);
    });

    const textarea = screen.getByRole('textbox');
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'Ly do du 10 ky tu' } });
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('vote-confirm-submit'));
    });

    await waitFor(() => {
      expect(onToastMock).toHaveBeenCalledWith(
        expect.objectContaining({
          tone: 'success'
        })
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Test 19: Close drawer (backdrop click, X button)
  // ---------------------------------------------------------------------------
  it('gọi onClose khi click nút X đóng drawer', async () => {
    mockApiResponse([baseMockItem]);
    const onCloseMock = vi.fn();

    await act(async () => {
      render(<OverrideVoteDrawer {...defaultProps} onClose={onCloseMock} />);
    });

    await waitFor(() => {
      expect(screen.getByText('proj-abc')).toBeInTheDocument();
    });

    // Tìm nút đóng bằng aria-label="Đóng" (case-insensitive Vietnamese normalize)
    const allButtons = screen.getAllByRole('button') as HTMLButtonElement[];
    const closeBtn = allButtons.find(b => {
      const aria = (b.getAttribute('aria-label') ?? '').toLowerCase();
      const text = (b.textContent ?? '').toLowerCase();
      return aria.includes('đóng') || aria.includes('dong') || text.includes('đóng') || text.includes('dong');
    });
    expect(closeBtn).toBeDefined();

    await act(async () => {
      fireEvent.click(closeBtn!);
    });

    expect(onCloseMock).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------------------
  // Test 20: API error → list view hiển thị error message
  // ---------------------------------------------------------------------------
  it('hiển thị error message và nút "Thử lại" khi API trả về lỗi', async () => {
    mockApiError({ statusCode: 500, message: 'Internal Server Error' });

    await act(async () => {
      render(<OverrideVoteDrawer {...defaultProps} />);
    });

    await waitFor(() => {
      assertText('Khong the tai danh sach');
    });

    // Nút Thử lại
    const retryBtn = findButton('Thu lai');
    expect(retryBtn).not.toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Test 21: Loading skeleton khi API đang fetch
  // ---------------------------------------------------------------------------
  it('hiển thị loading skeleton (animate-pulse) khi API đang fetch', async () => {
    mockLoading();

    let container: HTMLElement;
    await act(async () => {
      const result = render(<OverrideVoteDrawer {...defaultProps} />);
      container = result.container;
    });

    // animate-pulse class xuất hiện trong skeleton rows
    expect(container!.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // Test 22 [B4-fix-strong]: strong assertion cho 409 ALREADY_VOTED titleText + bodyText
  // ---------------------------------------------------------------------------
  it('[B4-fix-strong] 409 ALREADY_VOTED: toast có titleText và bodyText cụ thể', async () => {
    mockApiResponse([baseMockItem]);
    mockSubmitError({ statusCode: 409, errorCode: 'ALREADY_VOTED', message: 'Already voted' });
    const onToastMock = vi.fn();

    await act(async () => {
      render(<OverrideVoteDrawer {...defaultProps} onToast={onToastMock} />);
    });

    await waitFor(() => {
      expect(screen.getByText('proj-abc')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByText('proj-abc'));
    });

    await act(async () => {
      fireEvent.click(findButton('Dong y Ghi de')!);
    });

    const textarea = screen.getByRole('textbox');
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'Ly do du 10 ky tu' } });
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('vote-confirm-submit'));
    });

    await waitFor(() => {
      expect(onToastMock).toHaveBeenCalledWith(
        expect.objectContaining({
          tone: 'warning',
          titleText: 'Bạn đã biểu quyết rồi',
          bodyText: 'Mỗi ủy viên chỉ được vote một lần.'
        })
      );
    });
  });
});

// =============================================================================
// TESTS B3-FE-02 — Snapshot map trong DetailView (lazy fetch, đúng snapshot)
// =============================================================================

describe('OverrideVoteDrawer — B3 geofence snapshot map', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthSession();
    mockSubmitSuccess({ outcome: 'VOTE_RECORDED', pendingVoters: 2, totalVoters: 3 });
    detailMock.data = undefined;
    detailMock.isLoading = false;
    detailMock.error = null;
    detailMock.refetch = vi.fn().mockResolvedValue({ data: undefined, error: null });
  });

  // ---------------------------------------------------------------------------
  // R4: ListView KHÔNG fetch detail — hook detail chỉ nhận null khi liệt kê
  // ---------------------------------------------------------------------------
  it('[B3] ListView với nhiều item KHÔNG tạo detail request (hook detail chỉ nhận null)', async () => {
    const items = [
      baseMockItem,
      { ...baseMockItem, overrideRequestId: 'req-002', projectId: 'proj-2' },
      { ...baseMockItem, overrideRequestId: 'req-003', projectId: 'proj-3' },
    ];
    mockApiResponse(items);

    await act(async () => {
      render(<OverrideVoteDrawer {...defaultProps} />);
    });

    await waitFor(() => {
      expect(screen.getByText('proj-abc')).toBeInTheDocument();
    });

    // Hook detail được gọi (mỗi render) nhưng chỉ với null khi đang ở ListView
    expect(detailHookSpy).toHaveBeenCalled();
    for (const call of detailHookSpy.mock.calls) {
      expect(call[0]).toBeNull();
    }
  });

  // ---------------------------------------------------------------------------
  // Click một item → detail hook nhận đúng overrideRequestId (một detail request)
  // ---------------------------------------------------------------------------
  it('[B3] chọn một request → detail hook nhận đúng overrideRequestId', async () => {
    mockApiResponse([baseMockItem]);

    await act(async () => {
      render(<OverrideVoteDrawer {...defaultProps} />);
    });

    await waitFor(() => {
      expect(screen.getByText('proj-abc')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByText('proj-abc'));
    });

    await waitFor(() => {
      expect(detailHookSpy).toHaveBeenCalledWith('req-001');
    });
  });

  // ---------------------------------------------------------------------------
  // Map dùng snapshot radius từ detail endpoint (không tự tính, không dùng current geofence)
  // ---------------------------------------------------------------------------
  it('[B3] map nhận snapshot radius từ detail endpoint', async () => {
    mockApiResponse([baseMockItem]);
    detailMock.data = {
      ...baseMockItem,
      geofenceSnapshot: {
        polygon: [
          { lat: 10.10, lng: 106.60 },
          { lat: 10.11, lng: 106.60 },
          { lat: 10.11, lng: 106.61 },
        ],
        centroid: { lat: 10.105, lng: 106.605 },
        radiusMeters: 1000,
      },
    };

    await act(async () => {
      render(<OverrideVoteDrawer {...defaultProps} />);
    });

    await waitFor(() => {
      expect(screen.getByText('proj-abc')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByText('proj-abc'));
    });

    await waitFor(() => {
      const map = screen.getByTestId('geofence-map-mock');
      expect(map.getAttribute('data-radius')).toBe('1000');
      expect(map.getAttribute('data-centroid')).toBe('10.105,106.605');
      expect(map.getAttribute('data-polygon-points')).toBe('3');
      // OUT_OF_GEOFENCE → 1 marker INVALID
      expect(map.getAttribute('data-markers')).toBe('1');
      expect(map.getAttribute('data-marker-statuses')).toBe('INVALID');
      expect(map.getAttribute('data-marker-coordinates')).toBe('10.123456,106.654321');
    });
  });

  // ---------------------------------------------------------------------------
  // NO_GEOFENCE → banner riêng, không render map
  // ---------------------------------------------------------------------------
  it('[B3] reason NO_GEOFENCE hiển thị banner, không render map', async () => {
    const noGeofenceItem = {
      ...baseMockItem,
      overrideRequestId: 'req-nogeo',
      reason: 'NO_GEOFENCE' as const,
      gpsFromImage: null,
      gpsFromProject: { lat: 0, lng: 0 },
      distanceMeters: null,
    };
    mockApiResponse([noGeofenceItem]);

    await act(async () => {
      render(<OverrideVoteDrawer {...defaultProps} />);
    });

    await waitFor(() => {
      expect(screen.getByText('proj-abc')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByText('proj-abc'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('detail-no-geofence-banner')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('geofence-map-mock')).not.toBeInTheDocument();
    expect(document.body.textContent ?? '').not.toContain('0.000000');
  });

  // ---------------------------------------------------------------------------
  // Record cũ thiếu snapshot (null) → map vẫn render với snapshot=null (banner nội bộ map)
  // ---------------------------------------------------------------------------
  it('[B3] snapshot=null (record cũ) → map nhận data-radius="null"', async () => {
    mockApiResponse([baseMockItem]);
    detailMock.data = { ...baseMockItem, geofenceSnapshot: null };

    await act(async () => {
      render(<OverrideVoteDrawer {...defaultProps} />);
    });

    await waitFor(() => {
      expect(screen.getByText('proj-abc')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByText('proj-abc'));
    });

    await waitFor(() => {
      const map = screen.getByTestId('geofence-map-mock');
      expect(map.getAttribute('data-radius')).toBe('null');
    });
  });

  // ---------------------------------------------------------------------------
  // [B3-fix] Lỗi detail query (5xx) → hiển thị trạng thái lỗi/retry riêng, KHÔNG render map
  // ---------------------------------------------------------------------------
  it('[B3-fix] detail query lỗi 500 → hiển thị block lỗi/retry, không render map với snapshot=null', async () => {
    mockApiResponse([baseMockItem]);
    // Detail query thất bại — undefined data + error (mô phỏng 5xx)
    detailMock.data = undefined;
    detailMock.error = { statusCode: 500, message: 'Internal Server Error' };

    await act(async () => {
      render(<OverrideVoteDrawer {...defaultProps} />);
    });

    await waitFor(() => {
      expect(screen.getByText('proj-abc')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByText('proj-abc'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('detail-snapshot-error')).toBeInTheDocument();
    });
    // KHÔNG được render map (tránh banner "record cũ thiếu snapshot" gây hiểu nhầm)
    expect(screen.queryByTestId('geofence-map-mock')).not.toBeInTheDocument();
    assertText('Khong the tai du lieu ban do');
  });

  // ---------------------------------------------------------------------------
  // [B3-fix] Lỗi 403 → tiêu đề "Không có quyền xem dữ liệu bản đồ" (clear state cho lỗi auth)
  // ---------------------------------------------------------------------------
  it('[B3-fix] detail query lỗi 403 → tiêu đề quyền truy cập, không render map', async () => {
    mockApiResponse([baseMockItem]);
    detailMock.data = undefined;
    detailMock.error = { statusCode: 403, message: 'Forbidden' };

    await act(async () => {
      render(<OverrideVoteDrawer {...defaultProps} />);
    });

    await waitFor(() => {
      expect(screen.getByText('proj-abc')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByText('proj-abc'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('detail-snapshot-error')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('geofence-map-mock')).not.toBeInTheDocument();
    assertText('Khong co quyen xem du lieu ban do');
  });

  // ---------------------------------------------------------------------------
  // [B3-fix] Nút "Tải lại bản đồ" gọi refetch của detail query (retry riêng)
  // ---------------------------------------------------------------------------
  it('[B3-fix] nút "Tải lại bản đồ" gọi refetch detail query', async () => {
    mockApiResponse([baseMockItem]);
    const detailRefetchSpy = vi.fn().mockResolvedValue({ data: undefined, error: null });
    detailMock.data = undefined;
    detailMock.error = { statusCode: 500, message: 'Internal Server Error' };
    detailMock.refetch = detailRefetchSpy;

    await act(async () => {
      render(<OverrideVoteDrawer {...defaultProps} />);
    });

    await waitFor(() => {
      expect(screen.getByText('proj-abc')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByText('proj-abc'));
    });

    const retryBtn = findButton('Tai lai ban do');
    expect(retryBtn).not.toBeNull();

    await act(async () => {
      fireEvent.click(retryBtn!);
    });

    await waitFor(() => {
      expect(detailRefetchSpy).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // [B3-fix] BE trả HTTP 200 nhưng geofenceSnapshotUnavailable=true (đọc DB snapshot thất bại)
  // → cùng trạng thái lỗi/retry, KHÔNG diễn giải thành "record cũ thiếu snapshot"
  // ---------------------------------------------------------------------------
  it('[B3-fix] geofenceSnapshotUnavailable=true → hiển thị block lỗi, không render map dù HTTP 200', async () => {
    mockApiResponse([baseMockItem]);
    // BE trả 200 với snapshot=null NHƯNG bật cờ unavailable → không được coi là "record cũ"
    detailMock.data = { ...baseMockItem, geofenceSnapshot: null, geofenceSnapshotUnavailable: true };
    detailMock.error = null;

    await act(async () => {
      render(<OverrideVoteDrawer {...defaultProps} />);
    });

    await waitFor(() => {
      expect(screen.getByText('proj-abc')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByText('proj-abc'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('detail-snapshot-error')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('geofence-map-mock')).not.toBeInTheDocument();
  });
});
