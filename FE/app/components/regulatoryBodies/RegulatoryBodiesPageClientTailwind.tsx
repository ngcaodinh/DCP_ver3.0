'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { clearAuthSession, readAuthSession } from '../../utils/authSession';
import { buildApiUrl, fetchApi } from '@/app/utils/apiClient';
import AuditTable from './tailwind/AuditTable';
import { navigationItemList } from './tailwind/data';
import { getPageTitle } from './tailwind/helpers';
import DisbursementStatusCard from './tailwind/DisbursementStatusCard';
import MetricCard from './tailwind/MetricCard';
import NonDashboardPanel from './tailwind/NonDashboardPanel';
import RequestDrawer from './tailwind/RequestDrawer';
import Sidebar from './tailwind/Sidebar';
import ToastStack from './tailwind/ToastStack';
import Topbar from './tailwind/Topbar';
import NotificationBell from '@/app/components/notifications/NotificationBell';
import type { AuditLogItem, DrawerTabKey, PageKey, ToastItem, UrgentRequestItem } from './tailwind/types';
import UrgentTable from './tailwind/UrgentTable';
import OverrideVoteDrawer from '../systemAdmin/tailwind/OverrideVoteDrawer';
import { useOverrideDrawerController } from '@/app/hooks/useOverrideDrawerController';

type DashboardMetricItem = {
  valueText: string;
  labelText: string;
  trendText: string;
  trendClassName: 'trend-up' | 'trend-dn';
  colorVariant: 'amber' | 'cyan' | 'green' | 'navy';
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

/** Hàm chuẩn hóa role để so sánh quyền ổn định giữa các biến thể dữ liệu legacy/new. */
function normalizeUserRole(userRoleValue: string | undefined | null): string {
  if (!userRoleValue) {
    return '';
  }

  return userRoleValue.trim().toLowerCase().replace(/[\s_-]+/g, '');
}

/** Hàm kiểm tra role regulatory để không redirect nhầm sang trang chủ khi backend trả role theo biến thể khác. */
function isRegulatoryRole(userRoleValue: string | undefined | null): boolean {
  const normalizedUserRole = normalizeUserRole(userRoleValue);
  return normalizedUserRole === 'regulatory' || normalizedUserRole === 'regulatorybody' || normalizedUserRole === 'regulatorybodies';
}

/** Hàm tạo toast mới để tái sử dụng cho nhiều hành động UI trên trang tổng quan. */
function buildToastItem(titleText: string, bodyText: string, tone: 'success' | 'error' | 'info'): ToastItem {
  return { id: `${Date.now()}-${Math.random()}`, titleText, bodyText, tone };
}

/** Hàm chuẩn hóa text trạng thái chữ ký theo định dạng x/y để hiển thị thống nhất trên dashboard. */
function buildSignatureStateText(currentSignatures: number, requiredSignatures: number): string {
  const safeRequiredSignatures = Math.max(1, requiredSignatures);
  const safeCurrentSignatures = Math.min(Math.max(0, currentSignatures), safeRequiredSignatures);
  return `${safeCurrentSignatures}/${safeRequiredSignatures}`;
}

/** Hàm chuẩn hóa mức deadline để tô màu cảnh báo theo ngưỡng thời gian xử lý. */
function buildDeadlineLevel(deadlineTimestamp: number): 'urgent' | 'normal' | 'ok' {
  const remainMilliseconds = deadlineTimestamp - Date.now();
  if (remainMilliseconds <= 60 * 60 * 1000) {
    return 'urgent';
  }

  if (remainMilliseconds <= 24 * 60 * 60 * 1000) {
    return 'normal';
  }

  return 'ok';
}

/** Hàm chuẩn hóa text deadline để người dùng đọc nhanh mức ưu tiên xử lý. */
function buildDeadlineText(deadlineTimestamp: number): string {
  const remainMilliseconds = deadlineTimestamp - Date.now();
  if (remainMilliseconds <= 0) {
    return 'Đã quá hạn';
  }

  const remainMinutes = Math.floor(remainMilliseconds / (60 * 1000));
  if (remainMinutes < 60) {
    return `${remainMinutes} phút`;
  }

  const remainHours = Math.floor(remainMinutes / 60);
  if (remainHours < 24) {
    return `${remainHours} giờ`;
  }

  const remainDays = Math.floor(remainHours / 24);
  return `${remainDays} ngày`;
}

/** Hàm ánh xạ trạng thái ký duyệt từ API sang nhãn tiếng Việt để hiển thị đồng nhất trong bảng nhật ký. */
function mapApprovalLogStatusToText(status: 'SIGNED' | 'PENDING' | 'REJECTED'): string {
  if (status === 'SIGNED') {
    return 'Đã ký';
  }

  if (status === 'REJECTED') {
    return 'Bị từ chối';
  }

  return 'Chờ ký';
}

/** Hàm chuẩn hóa thời gian nhật ký về định dạng `vi-VN` để người dùng tra cứu hành động mới nhất. */
function buildApprovalLogTimeText(actionTimestamp: number): string {
  const actionDate = new Date(actionTimestamp);
  if (!Number.isFinite(actionDate.getTime())) {
    return 'Không xác định';
  }

  return actionDate.toLocaleString('vi-VN');
}

/** Hàm chuyển dữ liệu nhật ký ký duyệt từ backend thành định dạng `AuditLogItem` mà bảng đang sử dụng. */
function mapApprovalLogResponseItemToAuditLogItem(
  approvalLogResponseItem: DisbursementApprovalLogResponseItem
): AuditLogItem {
  return {
    transactionId: approvalLogResponseItem.transactionHash || approvalLogResponseItem.id,
    requestId: approvalLogResponseItem.requestId,
    amountText: `${new Intl.NumberFormat('vi-VN').format(approvalLogResponseItem.amount)}₫`,
    statusText: mapApprovalLogStatusToText(approvalLogResponseItem.status),
    actorText: approvalLogResponseItem.actor,
    timeText: buildApprovalLogTimeText(approvalLogResponseItem.actionTimestamp)
  };
}

/** Hàm tạo dữ liệu metric từ danh sách request thật để loại bỏ phụ thuộc mock data. */
function buildMetricItemList(disbursementSummaryItemList: DisbursementSummaryItem[]): DashboardMetricItem[] {
  const totalPendingRequestCount = disbursementSummaryItemList.length;
  const emergencyPendingRequestCount = disbursementSummaryItemList.filter((item) => item.requestMode === 'EMERGENCY').length;
  const urgentDeadlineRequestCount = disbursementSummaryItemList.filter((item) => buildDeadlineLevel(item.deadlineTimestamp) === 'urgent').length;
  const almostApprovedRequestCount = disbursementSummaryItemList.filter((item) => item.currentSignatures + 1 >= item.requiredSignatures).length;

  return [
    {
      valueText: String(totalPendingRequestCount),
      labelText: 'Yêu cầu chờ ký',
      trendText: 'Dữ liệu thật từ backend',
      trendClassName: 'trend-up',
      colorVariant: 'amber'
    },
    {
      valueText: String(emergencyPendingRequestCount),
      labelText: 'Yêu cầu khẩn cấp',
      trendText: 'Ưu tiên xử lý ngay',
      trendClassName: emergencyPendingRequestCount > 0 ? 'trend-dn' : 'trend-up',
      colorVariant: 'cyan'
    },
    {
      valueText: String(almostApprovedRequestCount),
      labelText: 'Sắp đủ chữ ký',
      trendText: 'Theo ngưỡng chữ ký động',
      trendClassName: 'trend-up',
      colorVariant: 'green'
    },
    {
      valueText: String(urgentDeadlineRequestCount),
      labelText: 'Hạn dưới 1 giờ',
      trendText: urgentDeadlineRequestCount > 0 ? 'Cần xử lý gấp' : 'Không có quá hạn gần',
      trendClassName: urgentDeadlineRequestCount > 0 ? 'trend-dn' : 'trend-up',
      colorVariant: 'navy'
    }
  ];
}


/** Hàm tạo thống kê tiến độ chữ ký từ danh sách request thật để card trạng thái không dùng số liệu cứng. */
function buildSigningStatusSummary(disbursementSummaryItemList: DisbursementSummaryItem[]): SigningStatusSummary {
  return disbursementSummaryItemList.reduce<SigningStatusSummary>((previousSummary, item) => {
    if (item.currentSignatures <= 0) {
      return {
        ...previousSummary,
        unsignedRequestCount: previousSummary.unsignedRequestCount + 1
      };
    }

    if (item.currentSignatures >= item.requiredSignatures) {
      return {
        ...previousSummary,
        fullySignedRequestCount: previousSummary.fullySignedRequestCount + 1
      };
    }

    return {
      ...previousSummary,
      partiallySignedRequestCount: previousSummary.partiallySignedRequestCount + 1
    };
  }, {
    fullySignedRequestCount: 0,
    partiallySignedRequestCount: 0,
    unsignedRequestCount: 0
  });
}

/** Hàm trang chính để dựng giao diện Cơ quan giám sát theo mẫu Tailwind và dữ liệu thật từ backend. */
export default function RegulatoryBodiesPageClientTailwind() {
  const router = useRouter();
  const [selectedPageKey, setSelectedPageKey] = useState<PageKey>('dashboard');
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [selectedUrgentRequestItem, setSelectedUrgentRequestItem] = useState<UrgentRequestItem | null>(null);
  const [selectedDrawerTabKey, setSelectedDrawerTabKey] = useState<DrawerTabKey>('overview');
  const [toastItemList, setToastItemList] = useState<ToastItem[]>([]);
  const [isAccessChecking, setIsAccessChecking] = useState(true);
  const [isDashboardLoading, setIsDashboardLoading] = useState(false);
  const [isDashboardError, setIsDashboardError] = useState(false);
  const [isLogoutProcessing, setIsLogoutProcessing] = useState(false);
  const [isActionProcessing, setIsActionProcessing] = useState(false);
  const [userDisplayName, setUserDisplayName] = useState('Người dùng');
  const [userEmail, setUserEmail] = useState('');
  const [userWalletAddress, setUserWalletAddress] = useState('');
  const [disbursementSummaryItemList, setDisbursementSummaryItemList] = useState<DisbursementSummaryItem[]>([]);
  const [auditLogItemList, setAuditLogItemList] = useState<AuditLogItem[]>([]);

  // Override vote drawer state (B4)
  const [isOverrideDrawerOpen, setIsOverrideDrawerOpen] = useState(false);
  const [overrideDrawerInitialId, setOverrideDrawerInitialId] = useState<string | null>(null);
  const [pendingOverridesCount, setPendingOverridesCount] = useState(0);
  const [currentUserId, setCurrentUserId] = useState('');
  const queryClient = useQueryClient();

  const metricItemList = useMemo(
    () => buildMetricItemList(disbursementSummaryItemList),
    [disbursementSummaryItemList]
  );

  const urgentRequestItemList = useMemo(
    () => disbursementSummaryItemList.map((item) => ({
      id: item.id,
      projectName: item.projectName,
      organizationName: item.organizationName,
      amountText: new Intl.NumberFormat('vi-VN').format(item.amount) + '₫',
      signatureState: buildSignatureStateText(item.currentSignatures, item.requiredSignatures),
      deadlineText: buildDeadlineText(item.deadlineTimestamp),
      deadlineLevel: buildDeadlineLevel(item.deadlineTimestamp),
      ipfsCid: item.ipfsCid,
      fileName: item.fileName,
      usagePurpose: item.usagePurpose
    })),
    [disbursementSummaryItemList]
  );


  const signingStatusSummary = useMemo(
    () => buildSigningStatusSummary(disbursementSummaryItemList),
    [disbursementSummaryItemList]
  );

  const shouldRenderSigningDashboard = selectedPageKey === 'dashboard';

  /** Hàm đồng bộ khóa cuộn nền khi mở lớp phủ để trải nghiệm mobile ổn định hơn. */
  useEffect(() => {
    const isOverlayOpen = isMobileMenuOpen || Boolean(selectedUrgentRequestItem);
    document.body.style.overflow = isOverlayOpen ? 'hidden' : '';

    return () => {
      document.body.style.overflow = '';
    };
  }, [isMobileMenuOpen, selectedUrgentRequestItem]);

  /** Hàm thêm toast và tự đóng sau 3 giây để phản hồi nhanh mà không cản thao tác. */
  const pushToast = useCallback((titleText: string, bodyText: string, tone: 'success' | 'error' | 'info'): void => {
    const newToastItem = buildToastItem(titleText, bodyText, tone);
    setToastItemList((previousToastItemList) => [...previousToastItemList, newToastItem]);
    window.setTimeout(() => {
      setToastItemList((previousToastItemList) => previousToastItemList.filter((toastItem) => toastItem.id !== newToastItem.id));
    }, 3000);
  }, []);

  // Override socket — regulatory commissioner nhận event ghi đè GPS realtime (B4).
  // Hàm sync số lượng pending overrides bằng cách invalidate cache TanStack Query
  // để `useOverrideRequests` ở drawer tự refetch và cập nhật badge qua `onItemsCountChange`.
  const syncPendingOverridesCount = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['overrideRequests'] });
  }, [queryClient]);

  /** Mở drawer và đặt ID mặc định khi nhận sự kiện override:new từ socket. */
  const handleOpenOverrideDrawer = useCallback((overrideRequestId: string) => {
    setOverrideDrawerInitialId(overrideRequestId);
    setIsOverrideDrawerOpen(true);
  }, []);

  /** Forward toast từ controller vào hệ thống toast của trang.
   *  tone `warning` không có trong regulatory ToastItem → map về `info`. */
  const handleOverrideDrawerToast = useCallback((toast: { titleText: string; bodyText: string; tone: 'info' | 'success' | 'warning' | 'error' }) => {
    const tone = toast.tone === 'warning' ? 'info' : toast.tone;
    pushToast(toast.titleText, toast.bodyText, tone as 'info' | 'success' | 'error');
  }, [pushToast]);

  // Hook expose { isSocketConnected, isUsingFallback } — hiện không dùng ở trang này,
  // nhưng vẫn gọi để đăng ký listener và side effects.
  useOverrideDrawerController({
    isDrawerOpen: isOverrideDrawerOpen,
    onOpenDrawer: handleOpenOverrideDrawer,
    onToast: handleOverrideDrawerToast,
    onSyncCount: syncPendingOverridesCount
  });

  /** Hàm kiểm tra quyền truy cập regulatory kết hợp xác thực server để chống bypass role ở client. */
  const verifyRegulatoryAccess = useCallback(async () => {
    const sessionPayload = readAuthSession();
    if (!sessionPayload.accessToken) {
      clearAuthSession();
      router.replace('/login');
      return;
    }

    setUserDisplayName(sessionPayload.userFullName || 'Người dùng');
    setUserEmail(sessionPayload.userEmail || '');
    setUserWalletAddress(sessionPayload.userWalletAddress || '');
    setCurrentUserId(sessionPayload.userId || '');

    if (sessionPayload.userRole && !isRegulatoryRole(sessionPayload.userRole)) {
      clearAuthSession();
      router.replace('/');
      return;
    }

    try {
      const response = await fetch(buildApiUrl('/auth/me'), {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${sessionPayload.accessToken}`
        }
      });

      if (!response.ok) {
        clearAuthSession();
        router.replace('/login');
        return;
      }

      const responseData = await response.json().catch(() => null) as {
        user?: { role?: string };
        data?: { user?: { role?: string } };
      } | null;

      // Ghi chú logic phức tạp: backend có 2 kiểu payload /auth/me (legacy và wrapper data),
      // nên cần đọc cả 2 để tránh loại nhầm user regulatory hợp lệ.
      const userRoleFromServer = responseData?.user?.role || responseData?.data?.user?.role || '';

      if (!isRegulatoryRole(userRoleFromServer)) {
        clearAuthSession();
        router.replace('/');
        return;
      }
    } catch {
      clearAuthSession();
      router.replace('/login');
      return;
    } finally {
      setIsAccessChecking(false);
    }
  }, [router]);

  /** Hàm tải dữ liệu request giải ngân từ backend để đồng bộ dashboard regulatory bằng dữ liệu thật. */
  const loadDashboardData = useCallback(async () => {
    const sessionPayload = readAuthSession();
    if (!sessionPayload.accessToken) {
      return;
    }

    setIsDashboardLoading(true);
    setIsDashboardError(false);
    try {
      const [disbursementSummaryResponse, approvalLogResponse] = await Promise.all([
        fetchApi<{ requests?: DisbursementSummaryItem[] }>(buildApiUrl('/api/disbursement/requests'), {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${sessionPayload.accessToken}`
          }
        }),
        fetchApi<{ logs?: DisbursementApprovalLogResponseItem[] }>(buildApiUrl('/api/disbursement/approval-logs'), {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${sessionPayload.accessToken}`
          }
        })
      ]);

      setDisbursementSummaryItemList(disbursementSummaryResponse.data?.requests ?? []);
      setAuditLogItemList((approvalLogResponse.data?.logs ?? []).map(mapApprovalLogResponseItemToAuditLogItem));
    } catch {
      setDisbursementSummaryItemList([]);
      setAuditLogItemList([]);
      setIsDashboardError(true);
    } finally {
      setIsDashboardLoading(false);
    }
  }, []);

  /** Hàm gọi API logout, xóa phiên cục bộ và điều hướng về login an toàn. */
  const handleLogout = useCallback(async () => {
    if (isLogoutProcessing) {
      return;
    }

    setIsLogoutProcessing(true);
    const sessionPayload = readAuthSession();

    try {
      if (sessionPayload.accessToken) {
        await fetch(buildApiUrl('/auth/logout-all'), {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${sessionPayload.accessToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({})
        });
      }
    } catch {
      // Ghi chú logic phức tạp: vẫn xóa session local để đảm bảo đóng phiên phía client.
    } finally {
      clearAuthSession();
      window.sessionStorage.clear();
      router.replace('/login');
      router.refresh();
      setIsLogoutProcessing(false);
    }
  }, [isLogoutProcessing, router]);

  /** Hàm submit action ký hoặc từ chối để đồng bộ dữ liệu ký duyệt giữa FE và backend. */
  const submitDisbursementAction = useCallback(async (
    requestId: string,
    action: 'approve' | 'reject',
    rejectReason?: string
  ): Promise<void> => {
    const sessionPayload = readAuthSession();
    if (!sessionPayload.accessToken) {
      throw new Error('SESSION_EXPIRED');
    }

    if (action === 'approve') {
      const signResponse = await fetchApi(buildApiUrl(`/api/disbursement/${requestId}/sign`), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${sessionPayload.accessToken}`
        },
        body: JSON.stringify({ comment: 'Approved from regulatory dashboard' })
      });

      if (!signResponse.success) {
        throw new Error('SIGN_DISBURSEMENT_FAILED');
      }
      return;
    }

    await fetchApi(buildApiUrl(`/api/disbursement/${requestId}/reject`), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${sessionPayload.accessToken}`
      },
      body: JSON.stringify({ reason: rejectReason })
    });
  }, []);

  /** Hàm mở drawer với tab mặc định overview để người dùng luôn thấy thông tin chính trước. */
  function handleOpenDrawer(urgentRequestItem: UrgentRequestItem) {
    setSelectedUrgentRequestItem(urgentRequestItem);
    setSelectedDrawerTabKey('overview');
  }

  /** Hàm ký duyệt từ drawer bằng API thật và làm mới toàn bộ dashboard sau khi thành công. */
  const handleApproveFromDrawer = useCallback(async (): Promise<void> => {
    const requestId = selectedUrgentRequestItem?.id;
    if (!requestId || isActionProcessing) {
      return;
    }

    setIsActionProcessing(true);
    try {
      await submitDisbursementAction(requestId, 'approve');
      setSelectedUrgentRequestItem(null);
      await loadDashboardData();
      pushToast('Ký duyệt thành công', `Đã ký duyệt yêu cầu ${requestId}.`, 'success');
    } catch {
      pushToast('Ký duyệt thất bại', 'Không thể cập nhật trạng thái yêu cầu. Vui lòng thử lại.', 'error');
    } finally {
      setIsActionProcessing(false);
    }
  }, [isActionProcessing, loadDashboardData, pushToast, selectedUrgentRequestItem, submitDisbursementAction]);

  /** Hàm từ chối từ drawer, nhận lý do đã được nhập trong form để đảm bảo audit trail rõ ràng. */
  const handleRejectFromDrawer = useCallback(async (rejectReason: string): Promise<void> => {
    const requestId = selectedUrgentRequestItem?.id;
    if (!requestId || isActionProcessing) {
      return;
    }

    const normalizedRejectReason = rejectReason.trim();
    if (normalizedRejectReason.length < 5) {
      pushToast('Thiếu lý do từ chối', 'Bạn cần nhập lý do từ chối tối thiểu 5 ký tự.', 'info');
      return;
    }

    setIsActionProcessing(true);
    try {
      await submitDisbursementAction(requestId, 'reject', normalizedRejectReason);
      setSelectedUrgentRequestItem(null);
      await loadDashboardData();
      pushToast('Đã từ chối yêu cầu', `Yêu cầu ${requestId} đã được cập nhật trạng thái từ chối.`, 'info');
    } catch {
      pushToast('Từ chối thất bại', 'Không thể cập nhật trạng thái yêu cầu. Vui lòng thử lại.', 'error');
    } finally {
      setIsActionProcessing(false);
    }
  }, [isActionProcessing, loadDashboardData, pushToast, selectedUrgentRequestItem, submitDisbursementAction]);

  /** Hàm chạy guard phân quyền khi component mount. */
  useEffect(() => {
    void verifyRegulatoryAccess();
  }, [verifyRegulatoryAccess]);

  /** Hàm tải dữ liệu dashboard khi đã xác thực quyền và đang ở trang ký duyệt. */
  useEffect(() => {
    if (isAccessChecking || !shouldRenderSigningDashboard) {
      return;
    }

    void loadDashboardData();
  }, [isAccessChecking, loadDashboardData, shouldRenderSigningDashboard]);

  if (isAccessChecking) {
    return (
      <main className="min-h-screen bg-slate-50 text-slate-900">
        <div className="flex min-h-screen items-center justify-center">
          <div className="rounded-lg bg-white px-6 py-4 shadow-sm">
            <p className="text-sm font-medium text-slate-700">Đang kiểm tra quyền truy cập...</p>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-slate-50 text-slate-900 lg:flex">
      <div className="hidden lg:block"><Sidebar selectedPageKey={selectedPageKey} navigationItemList={navigationItemList} onSelectPage={setSelectedPageKey} onLogout={handleLogout} /></div>

      {isMobileMenuOpen ? (
        <div className="fixed inset-0 z-30 lg:hidden">
          <button type="button" className="absolute inset-0 bg-slate-900/40" onClick={() => setIsMobileMenuOpen(false)} aria-label="Đóng menu" />
          <div className="relative h-full w-[248px]"><Sidebar selectedPageKey={selectedPageKey} navigationItemList={navigationItemList} onSelectPage={setSelectedPageKey} onCloseMobileMenu={() => setIsMobileMenuOpen(false)} onLogout={handleLogout} /></div>
        </div>
      ) : null}

      <section className="flex-1 p-0">
        <Topbar
          breadcrumbTitle={selectedPageKey === 'dashboard' ? 'Tổng quan' : getPageTitle(selectedPageKey)}
          userDisplayName={userDisplayName}
          userEmail={userEmail}
          userWalletAddress={userWalletAddress}
          notificationContent={<NotificationBell />}
          onOpenMobileMenu={() => setIsMobileMenuOpen(true)}
          onLogout={handleLogout}
        />

        <div className="space-y-5 p-4 lg:p-7">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-2xl font-bold">{getPageTitle(selectedPageKey)}</h1>
              <p className="mt-1 text-xs text-slate-500">Cập nhật lúc {new Date().toLocaleString('vi-VN')}</p>
            </div>
            {/* B4: Nút mở Override Vote Drawer — regulatory commissioner */}
            <button
              type="button"
              onClick={() => {
                setOverrideDrawerInitialId(null);
                setIsOverrideDrawerOpen(true);
              }}
              className="relative shrink-0 flex items-center gap-2 rounded-lg border border-orange-200 bg-orange-50 px-3 py-2 text-xs font-semibold text-orange-700 transition hover:bg-orange-100"
            >
              <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 10.5a3 3 0 11-6 0 3 3 0 016 0z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1115 0z" />
              </svg>
              Ghi đè GPS
              {pendingOverridesCount > 0 && (
                <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-orange-500 px-1 text-[10px] font-bold text-white">
                  {pendingOverridesCount}
                </span>
              )}
            </button>
          </div>

          {shouldRenderSigningDashboard ? (
            <>
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                {metricItemList.map((metricItem) => (
                  <MetricCard
                    key={metricItem.labelText}
                    valueText={metricItem.valueText}
                    labelText={metricItem.labelText}
                    trendText={metricItem.trendText}
                    trendClassName={metricItem.trendClassName}
                    colorVariant={metricItem.colorVariant}
                  />
                ))}
              </div>

              {isDashboardError ? (
                <div className="rounded-xl border border-red-200 bg-red-50 p-4">
                  <p className="text-sm font-semibold text-red-700">Không thể tải dữ liệu giải ngân từ backend.</p>
                  <button
                    type="button"
                    onClick={() => {
                      void loadDashboardData();
                    }}
                    className="mt-3 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white"
                  >
                    Thử lại
                  </button>
                </div>
              ) : (
                <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
                  <UrgentTable urgentRequestItemList={urgentRequestItemList} onOpenDrawer={handleOpenDrawer} />
                  <div className="space-y-4">
                    <DisbursementStatusCard
                      fullySignedRequestCount={signingStatusSummary.fullySignedRequestCount}
                      partiallySignedRequestCount={signingStatusSummary.partiallySignedRequestCount}
                      unsignedRequestCount={signingStatusSummary.unsignedRequestCount}
                    />
                  </div>
                </div>
              )}

              {isDashboardLoading ? (
                <div className="rounded-xl border border-emerald-900/15 bg-white p-4 text-sm text-slate-500">Đang tải dữ liệu ký duyệt từ backend...</div>
              ) : null}

              <AuditTable auditLogItemList={auditLogItemList} />
            </>
          ) : <NonDashboardPanel selectedPageKey={selectedPageKey} onOpenDisbursementRequest={handleOpenDrawer} />}
        </div>
      </section>

      <RequestDrawer
        selectedUrgentRequestItem={selectedUrgentRequestItem}
        selectedDrawerTabKey={selectedDrawerTabKey}
        onClose={() => setSelectedUrgentRequestItem(null)}
        onChangeTab={setSelectedDrawerTabKey}
        onReject={handleRejectFromDrawer}
        onApprove={handleApproveFromDrawer}
      />

      {/* B4: Override Vote Drawer — regulatory commissioner biểu quyết ghi đè GPS */}
      <OverrideVoteDrawer
        isOpen={isOverrideDrawerOpen}
        onClose={() => setIsOverrideDrawerOpen(false)}
        initialRequestId={overrideDrawerInitialId}
        currentUserId={currentUserId}
        currentUserRole="regulatory"
        onToast={(t) => {
          // tone 'warning' không có trong regulatory ToastItem — map về 'info'
          const tone = t.tone === 'warning' ? 'info' : t.tone;
          pushToast(t.titleText, t.bodyText, tone);
        }}
        onItemsCountChange={setPendingOverridesCount}
      />

      <ToastStack
        toastItemList={toastItemList}
        onCloseToast={(toastId) => setToastItemList((previousToastItemList) => previousToastItemList.filter((toastItem) => toastItem.id !== toastId))}
      />
    </main>
  );
}


