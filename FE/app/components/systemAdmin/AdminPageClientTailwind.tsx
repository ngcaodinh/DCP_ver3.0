'use client';

// =============================================================================
// AdminPageClientTailwind — Trang Admin chính
// Clone from: FE/app/components/regulatoryBodies/RegulatoryBodiesPageClientTailwind.tsx
// Mục đích: Trang quản trị hệ thống hoàn chỉnh — kết hợp Sidebar, Topbar, Dashboard,
//           và các NonDashboard panels với đầy đủ auth, toast, drawer/modal coordination
// =============================================================================

import { useState, useCallback, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import Sidebar from './tailwind/Sidebar';
import Topbar from './tailwind/Topbar';
import MetricCard from './tailwind/MetricCard';
import UrgentTable from './tailwind/UrgentTable';
import DisbursementStatusCard from './tailwind/DisbursementStatusCard';
import AuditTable from './tailwind/AuditTable';
import RequestDrawer from './tailwind/RequestDrawer';
import ToastStack from './tailwind/ToastStack';
import NonDashboardPanel from './tailwind/NonDashboardPanel';
import { getNavigationItems } from './tailwind/data';
import { readAuthSession, clearAuthSession } from '@/app/utils/authSession';
import { fetchApi, buildApiUrl } from '@/app/utils/apiClient';
import { getPageTitle } from './tailwind/helpers';
import type { PageKey, ToastItem, UrgentRequestItem, DrawerTabKey } from './tailwind/types';
import type { AuditLogItem } from './tailwind/types';

// =============================================================================
// TYPES for Dashboard API responses
// =============================================================================

/** Chuẩn hóa metric card từ API cho dashboard Admin. */
type MetricCardData = {
  valueText: string;
  labelText: string;
  trendText: string;
  trendClassName: 'trend-up' | 'trend-dn';
  colorVariant: 'amber' | 'cyan' | 'green' | 'teal';
};

type DisbursementSummaryItem = {
  id: string;
  projectName: string;
  organizationName: string;
  amount: number;
  requiredSignatures: number;
  currentSignatures: number;
  deadlineTimestamp: number;
  usagePurpose?: string;
  ipfsCid?: string;
  fileName?: string;
  requestMode: 'NORMAL' | 'EMERGENCY';
};

type DisbursementApprovalLogResponseItem = {
  id: string;
  requestId: string;
  transactionHash: string | null;
  amount: number;
  status: 'SIGNED' | 'PENDING' | 'REJECTED';
  actor: string;
  actionTimestamp: number;
};

type SigningStatusSummary = {
  fullySignedRequestCount: number;
  partiallySignedRequestCount: number;
  unsignedRequestCount: number;
};

// =============================================================================
// MAIN COMPONENT
// =============================================================================

export default function AdminPageClientTailwind() {
  // Auth state — kiểm tra quyền truy cập 'admin'
  const [authVerified, setAuthVerified] = useState(false);
  const [authLoading, setAuthLoading] = useState(true);

  // Page navigation
  const [activePage, setActivePage] = useState<PageKey>('dashboard');

  // Toast notifications
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  // Drawer state
  const [selectedUrgentRequestItem, setSelectedUrgentRequestItem] = useState<UrgentRequestItem | null>(null);
  const [drawerTabKey, setDrawerTabKey] = useState<DrawerTabKey>('overview');

  // Dashboard real API state
  const [dashboardMetrics, setDashboardMetrics] = useState<MetricCardData[]>([]);
  const [dashboardUrgentRequests, setDashboardUrgentRequests] = useState<UrgentRequestItem[]>([]);
  const [dashboardAuditLogs, setDashboardAuditLogs] = useState<AuditLogItem[]>([]);
  const [signingStatusSummary, setSigningStatusSummary] = useState<SigningStatusSummary>({
    fullySignedRequestCount: 0,
    partiallySignedRequestCount: 0,
    unsignedRequestCount: 0,
  });
  const [dashboardLoading, setDashboardLoading] = useState(true);
  const [dashboardError, setDashboardError] = useState(false);

  // User info from session
  const [userDisplayName, setUserDisplayName] = useState('Quản trị viên');
  const [userEmail, setUserEmail] = useState('');
  const [userWalletAddress, setUserWalletAddress] = useState('');

  const router = useRouter();

  // =============================================================================
  // AUTH VERIFICATION + USER INFO + DASHBOARD DATA
  // =============================================================================

  useEffect(() => {
    const verifyAuth = async () => {
      setAuthLoading(true);
      const session = readAuthSession();

      if (!session.accessToken) {
        router.push('/login');
        return;
      }

      // Kiểm tra quyền admin (chu?n OWASP A01: Access Control)
      if (session.userRole !== 'admin') {
        router.push('/unauthorized');
        return;
      }

      // Lưu thông tin user từ session để hiển thị trên Topbar
      setUserDisplayName(session.userFullName || 'Quản trị viên');
      setUserEmail(session.userEmail || '');
      setUserWalletAddress(session.userWalletAddress || '');

      setAuthVerified(true);
      setAuthLoading(false);
    };

    verifyAuth();
  }, [router]);

  /** Hàm định dạng deadline mức độ ưu tiên — chuyển số giây sang text cho bảng urgent. */
  const normalizeDeadlineText = (deadlineTimestamp: number): string => {
    const now = Date.now();
    const diffMs = deadlineTimestamp - now;
    if (diffMs <= 0) return 'Đã quá hạn';
    const diffSeconds = Math.floor(diffMs / 1000);
    if (diffSeconds < 60) return `${diffSeconds} giây`;
    const diffMinutes = Math.floor(diffSeconds / 60);
    if (diffMinutes < 60) return `${diffMinutes} phút`;
    const diffHours = Math.floor(diffMinutes / 60);
    if (diffHours < 24) return `${diffHours} giờ`;
    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays} ngày`;
  };

  /** Hàm Chuẩn hóa deadline level từ timestamp để hiển thị màu s?c phù h?p trên bảng urgent. */
  const normalizeDeadlineLevel = (deadlineTimestamp: number): 'urgent' | 'normal' | 'ok' => {
    const now = Date.now();
    const diffMs = deadlineTimestamp - now;
    if (diffMs <= 0) return 'ok';
    if (diffMs <= 60 * 60 * 1000) return 'urgent'; // Du?i 1 giờ: kh?n c?p
    if (diffMs <= 24 * 60 * 60 * 1000) return 'normal'; // Du?i 24 giờ: b́nh thu?ng
    return 'ok';
  };

  /** Hàm chuẩn hóa trạng thái chữ ký. Mục đích: hiển thị đúng ngưỡng chữ ký động FR7 từ backend. */
  const normalizeSignatureState = (currentSignatures: number, requiredSignatures: number): string => {
    const safeRequiredSignatures = Math.max(1, requiredSignatures);
    const safeCurrentSignatures = Math.min(Math.max(0, currentSignatures), safeRequiredSignatures);
    return `${safeCurrentSignatures}/${safeRequiredSignatures}`;
  };

  /** Hàm tạo metric ký duyệt từ danh sách yêu cầu thật để đồng bộ admin với regulatory-bodies. */
  const buildDisbursementMetricList = (requestItemList: DisbursementSummaryItem[]): MetricCardData[] => {
    const pendingRequestCount = requestItemList.length;
    const emergencyRequestCount = requestItemList.filter((item) => item.requestMode === 'EMERGENCY').length;
    const almostApprovedRequestCount = requestItemList.filter((item) => item.currentSignatures + 1 >= item.requiredSignatures).length;
    const urgentDeadlineRequestCount = requestItemList.filter((item) => normalizeDeadlineLevel(item.deadlineTimestamp) === 'urgent').length;

    return [
      { colorVariant: 'amber', valueText: String(pendingRequestCount), labelText: 'Yêu cầu chờ ký', trendText: 'Dữ liệu thật từ backend', trendClassName: 'trend-up' },
      { colorVariant: 'cyan', valueText: String(emergencyRequestCount), labelText: 'Yêu cầu khẩn cấp', trendText: 'Ưu tiên xử lý ngay', trendClassName: emergencyRequestCount > 0 ? 'trend-dn' : 'trend-up' },
      { colorVariant: 'green', valueText: String(almostApprovedRequestCount), labelText: 'Sắp đủ chữ ký', trendText: 'Theo ngưỡng chữ ký động', trendClassName: 'trend-up' },
      { colorVariant: 'teal', valueText: String(urgentDeadlineRequestCount), labelText: 'Hạn dưới 1 giờ', trendText: urgentDeadlineRequestCount > 0 ? 'Cần xử lý gấp' : 'Không có quá hạn gần', trendClassName: urgentDeadlineRequestCount > 0 ? 'trend-dn' : 'trend-up' },
    ];
  };

  /** Hàm tạo thống kê tiến độ chữ ký từ dữ liệu backend để card trạng thái không còn dùng số liệu cứng. */
  const buildSigningStatusSummary = (requestItemList: DisbursementSummaryItem[]): SigningStatusSummary => {
    return requestItemList.reduce<SigningStatusSummary>((summary, item) => {
      if (item.currentSignatures <= 0) {
        return { ...summary, unsignedRequestCount: summary.unsignedRequestCount + 1 };
      }

      if (item.currentSignatures >= item.requiredSignatures) {
        return { ...summary, fullySignedRequestCount: summary.fullySignedRequestCount + 1 };
      }

      return { ...summary, partiallySignedRequestCount: summary.partiallySignedRequestCount + 1 };
    }, { fullySignedRequestCount: 0, partiallySignedRequestCount: 0, unsignedRequestCount: 0 });
  };

  /** Hàm ánh xạ trạng thái nhật ký ký duyệt sang tiếng Việt để bảng admin dễ đọc. */
  const mapApprovalLogStatusToText = (status: 'SIGNED' | 'PENDING' | 'REJECTED'): string => {
    if (status === 'SIGNED') return 'Đã ký';
    if (status === 'REJECTED') return 'Bị từ chối';
    return 'Chờ ký';
  };

  /** Hàm định dạng thời gian nhật ký ký duyệt theo chuẩn Việt Nam. */
  const buildApprovalLogTimeText = (actionTimestamp: number): string => {
    const actionDate = new Date(actionTimestamp);
    if (!Number.isFinite(actionDate.getTime())) return 'Không xác định';
    return actionDate.toLocaleString('vi-VN');
  };

  /** Hàm gọi API dashboard từng h?p cho Admin — lấy metrics, urgent requests, timeline, audit logs. */
  const loadDashboardData = useCallback(async () => {
    setDashboardLoading(true);
    setDashboardError(false);
    const session = readAuthSession();
    const authHeaders = { Authorization: `Bearer ${session.accessToken}` };

    try {
      // Gọi song song API giải ngân để dashboard admin dùng dữ liệu thật, cùng nguồn với regulatory-bodies.
      const [urgentResp, auditResp] = await Promise.allSettled([
        fetchApi<{
          requests: DisbursementSummaryItem[];
        }>(buildApiUrl('/api/disbursement/requests'), { headers: authHeaders }),
        fetchApi<{
          logs: DisbursementApprovalLogResponseItem[];
        }>(buildApiUrl('/api/disbursement/approval-logs'), { headers: authHeaders }),
      ]);

      // Xử lý urgent requests — chuyển đổi từ raw API sang UrgentRequestItem
      if (urgentResp.status === 'fulfilled') {
        const rawRequests = urgentResp.value.data.requests ?? [];
        setDashboardMetrics(buildDisbursementMetricList(rawRequests));
        setSigningStatusSummary(buildSigningStatusSummary(rawRequests));
        setDashboardUrgentRequests(rawRequests.map((r) => ({
          id: r.id,
          projectName: r.projectName,
          organizationName: r.organizationName,
          amountText: new Intl.NumberFormat('vi-VN').format(r.amount) + '₫',
          signatureState: normalizeSignatureState(r.currentSignatures, r.requiredSignatures),
          deadlineText: normalizeDeadlineText(r.deadlineTimestamp),
          deadlineLevel: normalizeDeadlineLevel(r.deadlineTimestamp),
          ipfsCid: r.ipfsCid,
          fileName: r.fileName,
          usagePurpose: r.usagePurpose,
        })));
      } else {
        setDashboardMetrics(buildDisbursementMetricList([]));
        setSigningStatusSummary(buildSigningStatusSummary([]));
        setDashboardUrgentRequests([]);
      }

      // Xử lý nhật ký ký duyệt gần nhất từ API thật.
      if (auditResp.status === 'fulfilled') {
        const rawLogs = auditResp.value.data.logs ?? [];
        setDashboardAuditLogs(rawLogs.map((l) => ({
          transactionId: l.transactionHash || l.id,
          requestId: l.requestId,
          amountText: new Intl.NumberFormat('vi-VN').format(l.amount) + '₫',
          statusText: mapApprovalLogStatusToText(l.status),
          actorText: l.actor,
          timeText: buildApprovalLogTimeText(l.actionTimestamp),
        })));
      } else {
        setDashboardAuditLogs([]);
      }
    } catch {
      setDashboardError(true);
      // Fallback: đặt rỗng để tránh hiển thị mock data
      setDashboardMetrics([]);
      setDashboardUrgentRequests([]);
      setDashboardAuditLogs([]);
      setSigningStatusSummary(buildSigningStatusSummary([]));
    } finally {
      setDashboardLoading(false);
    }
  }, []);

  // Tải dashboard data khi auth đã xác thực thành công.
  useEffect(() => {
    if (authVerified) {
      loadDashboardData();
    }
  }, [authVerified, loadDashboardData]);

  // =============================================================================
  // TOAST HANDLERS
  // =============================================================================

  const addToast = useCallback((toastItem: Omit<ToastItem, 'id'>) => {
    const id = Date.now().toString();
    setToasts((prev) => [...prev, { ...toastItem, id }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4000);
  }, []);

  /** Gỡ toast khỏi danh sách. */
  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // =============================================================================
  // DRAWER HANDLERS
  // =============================================================================

  /** Mở drawer với item được chọn. */
  const handleOpenDrawer = useCallback((item: UrgentRequestItem) => {
    setSelectedUrgentRequestItem(item);
    setDrawerTabKey('overview');
  }, []);

  /** Đóng drawer — reset state về null. */
  const handleCloseDrawer = useCallback(() => {
    setSelectedUrgentRequestItem(null);
  }, []);

  /** Hàm thực thi action ký/từ chối với API thật. Mục đích: đồng bộ dashboard admin với dữ liệu backend, không dùng mock. */
  const submitDisbursementAction = useCallback(async (
    requestId: string,
    action: 'approve' | 'reject',
    rejectReason?: string
  ): Promise<void> => {
    const session = readAuthSession();
    if (!session.accessToken) {
      addToast({ titleText: 'Phiên đăng nhập hết hạn', bodyText: 'Vui lòng đăng nhập lại để tiếp tục ký duyệt.', tone: 'error' });

      throw new Error('SESSION_EXPIRED');
    }

    if (action === 'approve') {
      const signResponse = await fetchApi(buildApiUrl(`/api/disbursement/${requestId}/sign`), {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.accessToken}` },
        body: JSON.stringify({ comment: 'Approved from admin dashboard' })
      });

      if (!signResponse.success) {

        throw new Error('SIGN_DISBURSEMENT_FAILED');

      }

      addToast({ titleText: 'Ký duyệt thành công', bodyText: `Đã ký duyệt yêu cầu ${requestId}.`, tone: 'success' });
    } else {
      await fetchApi(buildApiUrl(`/api/disbursement/${requestId}/reject`), {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.accessToken}` },
        body: JSON.stringify({ reason: rejectReason })
      });
      addToast({ titleText: 'Đã từ chối yêu cầu', bodyText: `Yêu cầu ${requestId} đã được cập nhật trạng thái từ chối.`, tone: 'warning' });
    }

    await loadDashboardData();
  }, [addToast, loadDashboardData]);

  /** Hàm xử lý ký duyệt từ drawer. Mục đích: gọi API thật, làm mới dữ liệu và đóng drawer sau khi thành công. */
  const handleApproveFromDrawer = useCallback(async (): Promise<void> => {
    const requestId = selectedUrgentRequestItem?.id;
    if (!requestId) {
      return;
    }

    try {
      await submitDisbursementAction(requestId, 'approve');
      setSelectedUrgentRequestItem(null);
    } catch {
      addToast({ titleText: 'Ký duyệt thất bại', bodyText: 'Không thể cập nhật trạng thái yêu cầu. Vui lòng thử lại.', tone: 'error' });
    }
  }, [addToast, selectedUrgentRequestItem, submitDisbursementAction]);

  /** Hàm xử lý từ chối từ drawer. Mục đích: nhận lý do đã nhập trong form và đồng bộ trạng thái reject với backend. */
  const handleRejectFromDrawer = useCallback(async (rejectReason: string): Promise<void> => {
    const requestId = selectedUrgentRequestItem?.id;
    if (!requestId) {
      return;
    }

    const normalizedRejectReason = rejectReason.trim();
    if (normalizedRejectReason.length < 5) {
      addToast({ titleText: 'Thiếu lý do từ chối', bodyText: 'Bạn cần nhập lý do từ chối tối thiểu 5 ký tự.', tone: 'warning' });
      return;
    }

    try {
      await submitDisbursementAction(requestId, 'reject', normalizedRejectReason);
      setSelectedUrgentRequestItem(null);
    } catch {
      addToast({ titleText: 'Từ chối thất bại', bodyText: 'Không thể cập nhật trạng thái yêu cầu. Vui lòng thử lại.', tone: 'error' });
    }
  }, [addToast, selectedUrgentRequestItem, submitDisbursementAction]);

  // =============================================================================
  // LOGOUT
  // =============================================================================

  const handleLogout = useCallback(() => {
    clearAuthSession();
    router.push('/login');
  }, [router]);

  // =============================================================================
  // PAGE NAVIGATION
  // =============================================================================

  const handleNavigate = useCallback((key: PageKey) => {
    setActivePage(key);
  }, []);

  // =============================================================================
  // RENDER: LOADING
  // =============================================================================

  if (authLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-[#0E7C6B] border-t-transparent" />
          <p className="text-sm text-slate-500">Đang xác thực quyền truy cập...</p>
        </div>
      </div>
    );
  }

  // =============================================================================
  // RENDER: AUTH FAILED
  // =============================================================================

  if (!authVerified) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
        <div className="flex flex-col items-center gap-3 text-center">
          <svg className="text-red-400" width="48" height="48" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <p className="text-base font-semibold text-red-700">Không có quy?n truy c?p</p>
          <p className="text-sm text-slate-500">Bạn cần Đãng nhập với tài khoản Admin d? truy c?p trang này.</p>
        </div>
      </div>
    );
  }

  const navigationItemList = getNavigationItems();

  // =============================================================================
  // RENDER: DASHBOARD
  // =============================================================================

  if (activePage === 'dashboard') {
    return (
      <main className="min-h-screen bg-slate-50 text-slate-900 lg:flex">
        <Sidebar
          selectedPageKey={activePage}
          navigationItemList={navigationItemList}
          onSelectPage={handleNavigate}
          onLogout={handleLogout}
        />

        <section className="flex-1 p-0">
          <Topbar
            breadcrumbTitle={getPageTitle(activePage)}
            userDisplayName={userDisplayName}
            userEmail={userEmail}
            userWalletAddress={userWalletAddress}
            onLogout={handleLogout}
          />

          <div className="space-y-5 p-4 lg:p-7">
            <div>
              <h1 className="text-2xl font-bold text-slate-900">{getPageTitle(activePage)}</h1>
              <p className="mt-1 text-xs text-slate-500">từng quan h? th?ng</p>
            </div>

            {/* Metric cards — từ API th?t */}
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              {dashboardLoading ? (
                Array.from({ length: 4 }).map((_, idx) => (
                  <div key={idx} className="overflow-hidden rounded-xl border border-emerald-900/15 bg-white px-5 py-4">
                    <div className="h-8 w-20 animate-pulse rounded bg-slate-200" />
                    <div className="mt-2 h-4 w-32 animate-pulse rounded bg-slate-100" />
                  </div>
                ))
              ) : dashboardMetrics.length > 0 ? (
                dashboardMetrics.map((item, idx) => (
                  <MetricCard key={idx} {...item} />
                ))
              ) : (
                <div className="col-span-4 overflow-hidden rounded-xl border border-red-200 bg-red-50 px-6 py-8 text-center text-sm text-red-700">
                  Không thể tải metric. Vui lòng thử lại.
                </div>
              )}
            </div>

            {/* Main dashboard grid */}
            <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
              {/* Left: Urgent table */}
              <UrgentTable urgentRequestItemList={dashboardUrgentRequests} onOpenDrawer={handleOpenDrawer} />

              {/* Right: Disbursement status */}
              <div className="space-y-4">
                <DisbursementStatusCard
                  fullySignedRequestCount={signingStatusSummary.fullySignedRequestCount}
                  partiallySignedRequestCount={signingStatusSummary.partiallySignedRequestCount}
                  unsignedRequestCount={signingStatusSummary.unsignedRequestCount}
                />
              </div>
            </div>

            {/* Audit table */}
            {dashboardLoading ? (
              <div className="overflow-hidden rounded-xl border border-emerald-900/15 bg-white p-5">
                <div className="h-4 w-24 animate-pulse rounded bg-slate-200" />
                <div className="mt-4 space-y-2">
                  {Array.from({ length: 5 }).map((_, idx) => (
                    <div key={idx} className="h-10 animate-pulse rounded bg-slate-100" />
                  ))}
                </div>
              </div>
            ) : (
              <AuditTable auditLogItemList={dashboardAuditLogs} />
            )}

            {/* Retry button when dashboard data failed */}
            {dashboardError && !dashboardLoading && (
              <div className="text-center">
                <button
                  type="button"
                  onClick={() => loadDashboardData()}
                  className="rounded-lg border border-emerald-900/15 bg-[#0E7C6B] px-5 py-2.5 text-xs font-semibold text-white transition hover:bg-[#0d6b5c]"
                >
                  Tải lại dữ liệu tổng quan
                </button>
              </div>
            )}
          </div>
        </section>

        {/* Global overlays */}
        {selectedUrgentRequestItem && (
          <RequestDrawer
            selectedUrgentRequestItem={selectedUrgentRequestItem}
            selectedDrawerTabKey={drawerTabKey}
            onClose={handleCloseDrawer}
            onChangeTab={setDrawerTabKey}
            onApprove={handleApproveFromDrawer}
            onReject={handleRejectFromDrawer}
          />
        )}

        <ToastStack toastItemList={toasts} onCloseToast={removeToast} />
      </main>
    );
  }

  // =============================================================================
  // RENDER: NON-DASHBOARD PAGES
  // =============================================================================

  return (
    <main className="min-h-screen bg-slate-50 text-slate-900 lg:flex">
      <div className="hidden lg:block">
        <Sidebar
          selectedPageKey={activePage}
          navigationItemList={navigationItemList}
          onSelectPage={handleNavigate}
          onLogout={handleLogout}
        />
      </div>

      <section className="flex-1 p-0">
        <Topbar
          breadcrumbTitle={getPageTitle(activePage)}
          userDisplayName={userDisplayName}
          userEmail={userEmail}
          userWalletAddress={userWalletAddress}
          onLogout={handleLogout}
        />

        <div className="space-y-5 p-4 lg:p-7">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">{getPageTitle(activePage)}</h1>
            <p className="mt-1 text-xs text-slate-500">Quản lý và giám sát hệ thống</p>
          </div>

          <NonDashboardPanel
            activePage={activePage}
            onPushToast={addToast}
            onOpenDrawer={(urgentRequestItem) => {
              setSelectedUrgentRequestItem(urgentRequestItem);
              setDrawerTabKey('overview');
            }}
          />
        </div>
      </section>

      {selectedUrgentRequestItem && (
        <RequestDrawer
          selectedUrgentRequestItem={selectedUrgentRequestItem}
          selectedDrawerTabKey={drawerTabKey}
          onClose={handleCloseDrawer}
          onChangeTab={setDrawerTabKey}
          onApprove={handleApproveFromDrawer}
          onReject={handleRejectFromDrawer}
        />
      )}

      <ToastStack toastItemList={toasts} onCloseToast={removeToast} />
    </main>
  );
}


