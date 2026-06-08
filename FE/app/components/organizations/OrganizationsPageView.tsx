'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from 'react';
import { useRouter } from 'next/navigation';
import { financeNavigationItems, primaryNavigationItems, systemNavigationItems } from './mockData';
import {
  CreateDisbursementModal,
  CreateProjectModal,
  DashboardSection,
  DisbursementSection,
  NotificationDropdown,
  ProjectsSection,
  SettingsSection,
  TransparencySection
} from './OrganizationsSections';
import { ApiErrorResponse, fetchApi, buildApiUrl } from '@/app/utils/apiClient';
import { clearAuthSession, readAuthSession } from '@/app/utils/authSession';
import Topbar from '../regulatoryBodies/tailwind/Topbar';
import {
  DashboardDonationHistoryItem,
  DashboardFeaturedProject,
  DisbursementResult,
  NavigationItem,
  NotificationItem,
  OrganizationPageKey,
  ProjectSummary,
  StatisticItem,
  TimelineItem
} from './types';
import type { ApiSuccessResponse } from '@/app/utils/apiClient';

type CreateProjectEligibilityResponse = {
  isEligibleToCreateProject: boolean;
  blockReason: string | null;
};

type OrganizationKycSubmissionSummary = {
  submissionId: string;
  organizationId: string;
  organizationName: string;
  legalRegistrationNumber: string;
  status: 'PENDING_REVIEW' | 'APPROVED' | 'REJECTED' | 'SUBMISSION_ERROR';
  submittedAt: string;
  reviewedAt: string | null;
  rejectionReason?: string | null;
  beneficiaryBankAccount?: {
    bankName: string;
    bankAccountNumber: string;
    accountHolderName: string;
    branchName: string | null;
  } | null;
};

type ApprovedBeneficiaryBankAccount = {
  bankName: string;
  bankAccountNumber: string;
  accountHolderName: string;
  branchName?: string | null;
};

type RankingItem = {
  projectId: string;
  projectName: string;
  rankPosition: number;
  totalRaisedAmount: number;
  totalFundingScore: number;
};

type RankingSnapshotResponse = {
  items: RankingItem[];
  metadata?: {
    totalItems?: number;
    totalPages?: number;
    currentPage?: number;
    pageSize?: number;
  };
};

type DonationHistoryApiItem = {
  transactionHash: string;
  projectId: string;
  donorAddress: string;
  amount: number;
  timestamp: string;
  isAnonymous: boolean;
};

type NotificationListResponse = {
  notifications: NotificationItem[];
  unreadCount: number;
};

/** Hàm định dạng số tiền rút gọn theo chuẩn Việt Nam. Mục đích: hiển thị nhanh số lớn trên thẻ thống kê Tổng quan. */
function formatCompactCurrencyVietnamese(amountValue: number): string {
  const safeAmountValue = Number.isFinite(amountValue) ? Math.max(0, amountValue) : 0;
  return new Intl.NumberFormat('vi-VN', {
    notation: 'compact',
    compactDisplay: 'short',
    maximumFractionDigits: 1
  }).format(safeAmountValue);
}

/** Hàm định dạng số tiền đầy đủ theo chuẩn Việt Nam. Mục đích: hiển thị rõ ràng số tiền trên timeline và dự án nổi bật. */
function formatCurrencyVietnamese(amountValue: number): string {
  const safeAmountValue = Number.isFinite(amountValue) ? Math.max(0, amountValue) : 0;
  return new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 0 }).format(safeAmountValue);
}

/** Hàm định dạng thời điểm cho timeline Tổng quan. Mục đích: hiển thị mốc thời gian ngắn gọn, dễ đọc theo ngữ cảnh Việt Nam. */
function formatDashboardTimeLabel(timestampValue: number): string {
  return new Date(timestampValue).toLocaleString('vi-VN', {
    hour: '2-digit',
    minute: '2-digit',
    day: '2-digit',
    month: '2-digit'
  });
}

/** Hàm rút gọn địa chỉ ví donor. Mục đích: giữ thông tin nhận diện nhưng vẫn gọn khi hiển thị trong khối lịch sử quyên góp. */
function formatDonorWalletAddress(donorWalletAddress: string): string {
  if (!donorWalletAddress || donorWalletAddress.length < 10) {
    return donorWalletAddress || 'Không xác định';
  }

  return `${donorWalletAddress.slice(0, 6)}...${donorWalletAddress.slice(-4)}`;
}

/** Hàm rút gọn transaction hash. Mục đích: tránh tràn layout ở màn hình Tổng quan nhưng vẫn tra cứu được giao dịch. */
function formatTransactionHash(transactionHash: string): string {
  if (!transactionHash || transactionHash.length < 14) {
    return transactionHash || 'N/A';
  }

  return `${transactionHash.slice(0, 8)}...${transactionHash.slice(-6)}`;
}

type SidebarItemProps = {
  item: NavigationItem;
  activePage: OrganizationPageKey;
  onSelectPage: (page: OrganizationPageKey) => void;
  onTriggerAction: (action: 'createProject' | 'toggleNotification') => void;
};

/** Hàm kiểm tra có tài khoản thụ hưởng đã duyệt hay chưa. Mục đích: chặn UI tạo dự án khi chưa đủ điều kiện ngân hàng theo dữ liệu thật từ KYC. Chỉ check submission có dữ liệu bank account thực sự, tránh nhầm với KYC profile submission. */
function hasApprovedBeneficiaryBankAccount(submissionList: OrganizationKycSubmissionSummary[]): boolean {
  return submissionList.some(submissionItem =>
    submissionItem.beneficiaryBankAccount !== null && submissionItem.status === 'APPROVED'
  );
}

/** Hàm chuẩn hóa message lỗi API. Mục đích: hiển thị thông báo ổn định khi response lỗi hoặc thiếu cấu trúc mong muốn. */
function resolveApiErrorMessage(error: unknown, fallbackErrorMessage: string): string {
  if (!error || typeof error !== 'object') {
    return fallbackErrorMessage;
  }

  const typedError = error as ApiErrorResponse;
  return typedError.message || fallbackErrorMessage;
}

/** Hàm render item sidebar. Mục đích: tái sử dụng giao diện điều hướng bên trái. */
function SidebarItem({ item, activePage, onSelectPage, onTriggerAction }: SidebarItemProps) {
  const isActive = item.page === activePage;

  /** Hàm xử lý click item sidebar. Mục đích: phân tách luồng điều hướng và action đặc biệt. */
  const handleClick = () => {
    if (item.page) {
      onSelectPage(item.page);
      return;
    }

    if (item.action) {
      onTriggerAction(item.action);
    }
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      className={`flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-left text-[13px] font-medium transition ${isActive ? 'border border-white/25 bg-white/15 text-white' : 'text-white/75 hover:bg-white/10 hover:text-white'}`}
    >
      <span>{item.icon} {item.label}</span>
      {item.badge ? <span className="rounded-full bg-[#E11D48] px-1.5 text-[10px] text-white">{item.badge}</span> : null}
    </button>
  );
}

/** Hàm render trang Organizations chi tiết. Mục đích: bám sát layout HTML gốc theo các section chính. */
export default function OrganizationsPageView() {
  const router = useRouter();
  const backendBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:4000';
  const [activePage, setActivePage] = useState<OrganizationPageKey>('dashboard');
  const [activeDisbursementTab, setActiveDisbursementTab] = useState<'eligible' | 'pending' | 'history'>('eligible');
  const [isNotificationOpen, setIsNotificationOpen] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [isCreateProjectOpen, setIsCreateProjectOpen] = useState(false);
  const [selectedDisbursementProject, setSelectedDisbursementProject] = useState<ProjectSummary | null>(null);
  const [isBankSetupHighlighted, setIsBankSetupHighlighted] = useState(false);
  const [notificationItemList, setNotificationItemList] = useState<NotificationItem[]>([]);
  const [unreadNotificationCount, setUnreadNotificationCount] = useState(0);
  const [realtimeToastNotification, setRealtimeToastNotification] = useState<NotificationItem | null>(null);
  const [isNotificationLoading, setIsNotificationLoading] = useState(false);
  const [notificationErrorMessage, setNotificationErrorMessage] = useState<string | null>(null);
  const [createdProjects, setCreatedProjects] = useState<ProjectSummary[]>([]);
  const [disbursements, setDisbursements] = useState<import('./types').DisbursementResult[]>([]);
  const [isDisbursementsLoading, setIsDisbursementsLoading] = useState(false);
  const [disbursementsErrorMessage, setDisbursementsErrorMessage] = useState<string | null>(null);
  const [rankingItems, setRankingItems] = useState<RankingItem[]>([]);
  const [rankingTotalItems, setRankingTotalItems] = useState(0);
  const [isRankingLoading, setIsRankingLoading] = useState(false);
  const [rankingErrorMessage, setRankingErrorMessage] = useState<string | null>(null);
  const [dashboardDonationHistoryItemList, setDashboardDonationHistoryItemList] = useState<DashboardDonationHistoryItem[]>([]);
  const [isDonationHistoryLoading, setIsDonationHistoryLoading] = useState(false);
  const [donationHistoryErrorMessage, setDonationHistoryErrorMessage] = useState<string | null>(null);
  const [isProjectsLoading, setIsProjectsLoading] = useState(false);
  const [projectsErrorMessage, setProjectsErrorMessage] = useState<string | null>(null);
  const [isCreateProjectAllowed, setIsCreateProjectAllowed] = useState(true);
  const [createProjectBlockReason, setCreateProjectBlockReason] = useState<string | null>(null);
  const [organizationKycSubmissionList, setOrganizationKycSubmissionList] = useState<OrganizationKycSubmissionSummary[]>([]);
  const [isOrganizationKycLoading, setIsOrganizationKycLoading] = useState(false);
  const [organizationKycErrorMessage, setOrganizationKycErrorMessage] = useState<string | null>(null);
  const [isAccessChecking, setIsAccessChecking] = useState(true);
  const [isLogoutProcessing, setIsLogoutProcessing] = useState(false);
  const [userDisplayName, setUserDisplayName] = useState('Người dùng');
  const [userEmail, setUserEmail] = useState('');
  const [userWalletAddress, setUserWalletAddress] = useState('');
  const latestEligibilityRequestRef = useRef(0);
  const knownNotificationIdSetRef = useRef<Set<string>>(new Set());
  const hasInitializedNotificationSnapshotRef = useRef(false);

  /** Hàm lấy tài khoản thụ hưởng đã duyệt. Mục đích: dùng đúng tài khoản ngân hàng đã qua phê duyệt khi tạo yêu cầu giải ngân. */
  const approvedBeneficiaryBankAccount = useMemo<ApprovedBeneficiaryBankAccount | null>(() => {
    const approvedSubmission = organizationKycSubmissionList.find(submissionItem =>
      submissionItem.status === 'APPROVED' && submissionItem.beneficiaryBankAccount !== null
    );

    return approvedSubmission?.beneficiaryBankAccount || null;
  }, [organizationKycSubmissionList]);

  /** Hàm tính tiêu đề topbar. Mục đích: đồng bộ tiêu đề theo menu đang active. */
  const pageTitle = useMemo(() => {
    const pageTitleMap: Record<OrganizationPageKey, string> = {
      dashboard: 'Tổng quan',
      projects: 'Dự án của tôi',
      disbursement: 'Giải ngân',
      transparency: 'Minh bạch',
      settings: 'Cài đặt'
    };

    return pageTitleMap[activePage];
  }, [activePage]);

  /** Hàm tải điều kiện tạo dự án từ backend. Mục đích: đồng bộ rule ngân hàng thụ hưởng để khóa/mở tính năng tạo dự án trên UI. */
  const loadCreateProjectEligibility = async (): Promise<boolean> => {
    const requestOrderNumber = latestEligibilityRequestRef.current + 1;
    latestEligibilityRequestRef.current = requestOrderNumber;

    const authSession = readAuthSession();
    if (!authSession?.accessToken) {
      if (requestOrderNumber === latestEligibilityRequestRef.current) {
        setIsCreateProjectAllowed(false);
        setCreateProjectBlockReason('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.');
      }
      return false;
    }

    try {
      const response = await fetchApi<CreateProjectEligibilityResponse>(buildApiUrl('/projects/create-eligibility'), {
        method: 'GET',
        headers: { Authorization: `Bearer ${authSession.accessToken}` }
      });

      // Logic này dùng cả điều kiện backend và trạng thái KYC local để tránh hiển thị sai nút tạo dự án khi dữ liệu chưa đồng bộ hoàn toàn.
      const hasApprovedBankAccount = hasApprovedBeneficiaryBankAccount(organizationKycSubmissionList);
      const isEligibleToCreateProject = response.data.isEligibleToCreateProject && hasApprovedBankAccount;

      // Chỉ cập nhật state từ request mới nhất để tránh race condition khi có nhiều request chạy song song.
      if (requestOrderNumber === latestEligibilityRequestRef.current) {
        setIsCreateProjectAllowed(isEligibleToCreateProject);
        setCreateProjectBlockReason(
          isEligibleToCreateProject
            ? null
            : response.data.blockReason || 'Bạn cần liên kết và được duyệt tài khoản ngân hàng thụ hưởng trước khi tạo dự án. Vui lòng vào Cài đặt ngân hàng.'
        );
      }
      return isEligibleToCreateProject;
    } catch (error: unknown) {
      const fallbackBlockReason = 'Không thể kiểm tra điều kiện tạo dự án. Vui lòng thử lại sau.';
      if (requestOrderNumber === latestEligibilityRequestRef.current) {
        setCreateProjectBlockReason(resolveApiErrorMessage(error, fallbackBlockReason));
        setIsCreateProjectAllowed(false);
      }
      return false;
    }
  };

  /** Hàm tải danh sách hồ sơ KYC của tổ chức hiện tại. Mục đích: lấy dữ liệu thật trạng thái tài khoản thụ hưởng cho Dashboard/Settings. */
  const loadOrganizationKycSubmissions = async () => {
    const authSession = readAuthSession();
    if (!authSession?.accessToken) {
      setOrganizationKycSubmissionList([]);
      setOrganizationKycErrorMessage('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.');
      setIsOrganizationKycLoading(false);
      setIsCreateProjectAllowed(false);
      setCreateProjectBlockReason('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.');
      return;
    }

    setIsOrganizationKycLoading(true);
    setOrganizationKycErrorMessage(null);

    try {
      const response = await fetchApi<{ submissions?: OrganizationKycSubmissionSummary[] }>(
        buildApiUrl('/auth/organization/kyc-submissions/me'),
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${authSession.accessToken}` }
        }
      );

      // Logic này luôn ép về mảng an toàn để tránh runtime crash khi backend tạm thời không trả field submissions.
      const nextSubmissionList = Array.isArray(response.data?.submissions) ? response.data.submissions : [];
      setOrganizationKycSubmissionList(nextSubmissionList);

      const hasApprovedBankAccount = hasApprovedBeneficiaryBankAccount(nextSubmissionList);
      setIsCreateProjectAllowed(hasApprovedBankAccount);
      setCreateProjectBlockReason(
        hasApprovedBankAccount
          ? null
          : 'Bạn cần liên kết và được duyệt tài khoản ngân hàng thụ hưởng trước khi tạo dự án. Vui lòng vào Cài đặt ngân hàng.'
      );
    } catch (error: unknown) {
      const fallbackErrorMessage = 'Không thể tải trạng thái duyệt tài khoản. Vui lòng thử lại sau.';
      setOrganizationKycErrorMessage(resolveApiErrorMessage(error, fallbackErrorMessage));
      setOrganizationKycSubmissionList([]);
      setIsCreateProjectAllowed(false);
      setCreateProjectBlockReason('Bạn cần liên kết và được duyệt tài khoản ngân hàng thụ hưởng trước khi tạo dự án. Vui lòng vào Cài đặt ngân hàng.');
    } finally {
      setIsOrganizationKycLoading(false);
    }
  };

  /** Hàm xử lý khi gửi duyệt ngân hàng thành công. Mục đích: tải lại trạng thái thật và eligibility theo thứ tự để tránh dữ liệu chồng chéo. */
  const handleBankSubmissionSuccess = async () => {
    await loadOrganizationKycSubmissions();
    await loadCreateProjectEligibility();
  };

  /** Hàm mở modal tạo dự án. Mục đích: chỉ mở modal khi tổ chức đã đủ điều kiện ngân hàng thụ hưởng. */
  const handleOpenCreateProjectModal = async () => {
    const isEligibleToCreateProject = await loadCreateProjectEligibility();
    if (!isEligibleToCreateProject) {
      handleLinkBankAccount();
      return;
    }

    setIsCreateProjectOpen(true);
  };

  /** Hàm xử lý action từ sidebar. Mục đích: mở modal hoặc dropdown thông báo đúng ngữ cảnh. */
  const handleSidebarAction = (action: 'createProject' | 'toggleNotification') => {
    if (action === 'createProject') {
      void handleOpenCreateProjectModal();
      return;
    }

    setIsNotificationOpen(currentState => !currentState);
    void loadNotificationsFromApi();
  };

  /** Hàm cập nhật state thông báo. Mục đích: đồng bộ danh sách và badge chưa đọc từ response thật. */
  const applyNotificationResponse = useCallback((notificationResponse: NotificationListResponse) => {
    const nextNotificationItemList = Array.isArray(notificationResponse.notifications) ? notificationResponse.notifications : [];
    const newUnreadNotification = nextNotificationItemList.find(notificationItem =>
      !notificationItem.isRead && !knownNotificationIdSetRef.current.has(notificationItem.notificationId)
    );

    setNotificationItemList(nextNotificationItemList);
    setUnreadNotificationCount(Number.isFinite(notificationResponse.unreadCount) ? Math.max(0, notificationResponse.unreadCount) : 0);

    if (hasInitializedNotificationSnapshotRef.current && newUnreadNotification) {
      setRealtimeToastNotification(newUnreadNotification);
    }

    nextNotificationItemList.forEach(notificationItem => {
      knownNotificationIdSetRef.current.add(notificationItem.notificationId);
    });
    hasInitializedNotificationSnapshotRef.current = true;
  }, []);

  /** Hàm tải thông báo từ backend. Mục đích: lấy snapshot ban đầu trước khi nhận realtime. */
  const loadNotificationsFromApi = useCallback(async () => {
    const authSession = readAuthSession();
    if (!authSession?.accessToken) {
      setNotificationErrorMessage('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.');
      return;
    }

    setIsNotificationLoading(true);
    setNotificationErrorMessage(null);

    try {
      const response = await fetchApi<NotificationListResponse>(buildApiUrl('/api/notifications'), {
        method: 'GET',
        headers: { Authorization: `Bearer ${authSession.accessToken}` }
      });
      applyNotificationResponse(response.data);
    } catch (error: unknown) {
      setNotificationErrorMessage(resolveApiErrorMessage(error, 'Không thể tải thông báo. Vui lòng thử lại sau.'));
    } finally {
      setIsNotificationLoading(false);
    }
  }, [applyNotificationResponse]);

  /** Hàm tải danh sách giải ngân từ backend. Mục đích: đồng bộ dữ liệu thật cho màn hình "Giải ngân". */
  const loadDisbursementsFromApi = async () => {
    const authSession = readAuthSession();
    if (!authSession?.accessToken) {
      setDisbursementsErrorMessage('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.');
      return;
    }

    setIsDisbursementsLoading(true);
    setDisbursementsErrorMessage(null);

    try {
      const response = await fetchApi<import('./types').DisbursementResult[]>(buildApiUrl('/api/disbursement/me'), {
        method: 'GET',
        headers: { Authorization: `Bearer ${authSession.accessToken}` }
      });
      setDisbursements(response.data);
    } catch (error: unknown) {
      const fallbackErrorMessage = 'Không thể tải danh sách giải ngân. Vui lòng thử lại sau.';
      if (error && typeof error === 'object' && 'message' in error) {
        setDisbursementsErrorMessage((error as { message?: string }).message || fallbackErrorMessage);
      } else {
        setDisbursementsErrorMessage(fallbackErrorMessage);
      }
    } finally {
      setIsDisbursementsLoading(false);
    }
  };

  /** Hàm tải bảng xếp hạng QF từ backend. Mục đích: lấy dữ liệu thật để tính tổng quyên góp và thứ hạng trên tab Tổng quan. */
  const loadRankingFromApi = async () => {
    setIsRankingLoading(true);
    setRankingErrorMessage(null);

    try {
      const response = await fetchApi<RankingSnapshotResponse>(
        buildApiUrl('/rankings?page=1&limit=500&sortBy=rankPosition&sortDirection=asc'),
        { method: 'GET' }
      );

      const nextRankingItems = Array.isArray(response.data?.items) ? response.data.items : [];
      const nextTotalItems =
        typeof response.data?.metadata?.totalItems === 'number' && Number.isFinite(response.data.metadata.totalItems)
          ? response.data.metadata.totalItems
          : nextRankingItems.length;

      setRankingItems(nextRankingItems);
      setRankingTotalItems(nextTotalItems);
    } catch (error: unknown) {
      const fallbackErrorMessage = 'Không thể tải bảng xếp hạng QF. Vui lòng thử lại sau.';
      if (error && typeof error === 'object' && 'message' in error) {
        setRankingErrorMessage((error as { message?: string }).message || fallbackErrorMessage);
      } else {
        setRankingErrorMessage(fallbackErrorMessage);
      }
      setRankingItems([]);
      setRankingTotalItems(0);
    } finally {
      setIsRankingLoading(false);
    }
  };

  /** Hàm tải danh sách dự án từ backend. Mục đích: đồng bộ dữ liệu thật cho màn hình “Dự án của tôi”. */
  const loadProjectsFromApi = async () => {
    const authSession = readAuthSession();
    if (!authSession?.accessToken) {
      setProjectsErrorMessage('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.');
      return;
    }

    setIsProjectsLoading(true);
    setProjectsErrorMessage(null);

    try {
      const response = await fetchApi<ProjectSummary[]>(buildApiUrl('/projects'), {
        method: 'GET',
        headers: { Authorization: `Bearer ${authSession.accessToken}` }
      });
      setCreatedProjects(response.data);
    } catch (error: unknown) {
      const fallbackErrorMessage = 'Không thể tải danh sách dự án. Vui lòng thử lại sau.';
      if (error && typeof error === 'object' && 'message' in error) {
        setProjectsErrorMessage((error as { message?: string }).message || fallbackErrorMessage);
      } else {
        setProjectsErrorMessage(fallbackErrorMessage);
      }
    } finally {
      setIsProjectsLoading(false);
    }
  };

  /** Hàm tải lịch sử quyên góp cho Dashboard. Mục đích: gộp giao dịch donation thật từ tất cả dự án của tổ chức để hiển thị tại tab Tổng quan. */
  const loadDashboardDonationHistory = useCallback(async (projectList: ProjectSummary[]) => {
    const fallbackErrorMessage = 'Không thể tải lịch sử quyên góp. Vui lòng thử lại sau.';
    const validProjectList = projectList.filter(projectItem => typeof projectItem.projectId === 'string' && projectItem.projectId.trim().length > 0);

    if (validProjectList.length === 0) {
      setDashboardDonationHistoryItemList([]);
      setDonationHistoryErrorMessage(null);
      setIsDonationHistoryLoading(false);
      return;
    }

    setIsDonationHistoryLoading(true);
    setDonationHistoryErrorMessage(null);

    const projectNameByProjectIdMap = new Map(
      validProjectList.map(projectItem => [projectItem.projectId, projectItem.name])
    );

    try {
      /** Hằng số giới hạn số bản ghi lịch sử lấy theo mỗi dự án. Mục đích: đủ dữ liệu để lọc theo ngày/tuần/tháng ở UI. */
      const donationHistoryFetchLimitCount = 50;

      const donationHistoryResultList = await Promise.allSettled(
        validProjectList.map(projectItem =>
          fetchApi<DonationHistoryApiItem[]>(
            buildApiUrl(
              `/donations/campaigns/${encodeURIComponent(projectItem.projectId)}/history?limit=${donationHistoryFetchLimitCount}`
            ),
            {
              method: 'GET',
              cache: 'no-store'
            }
          )
        )
      );

      const rawDashboardDonationHistoryItemList = donationHistoryResultList
        .filter(
          (resultItem): resultItem is PromiseFulfilledResult<ApiSuccessResponse<DonationHistoryApiItem[]>> =>
            resultItem.status === 'fulfilled'
        )
        .flatMap(resultItem => (Array.isArray(resultItem.value.data) ? resultItem.value.data : []))
        .map(historyItem => {
          const parsedTimestampValue = Date.parse(historyItem.timestamp);
          const isValidTimestamp = !Number.isNaN(parsedTimestampValue);
          return {
            transactionHash: historyItem.transactionHash,
            projectName: projectNameByProjectIdMap.get(historyItem.projectId) || historyItem.projectId,
            donorLabel: historyItem.isAnonymous ? 'Ẩn danh' : formatDonorWalletAddress(historyItem.donorAddress),
            amount: Number.isFinite(historyItem.amount) ? historyItem.amount : 0,
            timestamp: isValidTimestamp ? new Date(parsedTimestampValue).toLocaleString('vi-VN') : 'Không xác định',
            timestampValue: isValidTimestamp ? parsedTimestampValue : 0,
            transactionHashDisplayText: formatTransactionHash(historyItem.transactionHash)
          };
        })
        .sort((leftHistoryItem, rightHistoryItem) => rightHistoryItem.timestampValue - leftHistoryItem.timestampValue);

      const usedTransactionHashSet = new Set<string>();
      const nextDashboardDonationHistoryItemList: DashboardDonationHistoryItem[] = [];

      // Logic này loại trùng transactionHash khi cùng giao dịch xuất hiện từ nhiều nguồn, giúp danh sách lịch sử không lặp bản ghi.
      rawDashboardDonationHistoryItemList.forEach(historyItem => {
        if (usedTransactionHashSet.has(historyItem.transactionHash)) {
          return;
        }

        usedTransactionHashSet.add(historyItem.transactionHash);
        nextDashboardDonationHistoryItemList.push({
          transactionHash: historyItem.transactionHashDisplayText,
          projectName: historyItem.projectName,
          donorLabel: historyItem.donorLabel,
          amount: historyItem.amount,
          timestamp: historyItem.timestamp,
          timestampIso: historyItem.timestampValue > 0 ? new Date(historyItem.timestampValue).toISOString() : ''
        });
      });

      setDashboardDonationHistoryItemList(nextDashboardDonationHistoryItemList);

      const hasAnySuccessfulResult = donationHistoryResultList.some(resultItem => resultItem.status === 'fulfilled');
      if (!hasAnySuccessfulResult) {
        setDonationHistoryErrorMessage(fallbackErrorMessage);
      }
    } catch (_error) {
      setDashboardDonationHistoryItemList([]);
      setDonationHistoryErrorMessage(fallbackErrorMessage);
    } finally {
      setIsDonationHistoryLoading(false);
    }
  }, []);

  /** Hàm nhận dự án vừa tạo. Mục đích: thêm dự án mới vào đầu danh sách để hiển thị ngay. */
  const handleProjectCreated = (project: ProjectSummary) => {
    setCreatedProjects(currentProjects => [project, ...currentProjects]);
  };

  /** Hàm mở modal tạo giải ngân. Mục đích: chỉ cho phép mở khi tổ chức đã có tài khoản thụ hưởng được duyệt. */
  const handleOpenCreateDisbursementModal = (project: ProjectSummary) => {
    if (!approvedBeneficiaryBankAccount) {
      handleLinkBankAccount();
      return;
    }

    setSelectedDisbursementProject(project);
  };

  /** Hàm nhận yêu cầu giải ngân vừa tạo. Mục đích: cập nhật UI ngay mà không cần chờ tải lại toàn bộ trang. */
  const handleDisbursementCreated = (createdDisbursement: DisbursementResult) => {
    setDisbursements(currentDisbursements => [createdDisbursement, ...currentDisbursements]);
    setActiveDisbursementTab('pending');
    setSelectedDisbursementProject(null);
  };

  /** Hàm cập nhật dự án sau khi submit. Mục đích: đồng bộ trạng thái PENDING_APPROVAL tại danh sách local. */
  const handleProjectSubmitted = (projectId: string, submittedProject: ProjectSummary) => {
    setCreatedProjects(currentProjects => {
      return currentProjects.map(project => {
        if (project.projectId !== projectId) {
          return project;
        }

        return submittedProject;
      });
    });
  };

  /** Hàm cập nhật dự án sau khi chỉnh sửa. Mục đích: đồng bộ dữ liệu mới nhất từ API vào danh sách local. */
  const handleProjectUpdated = (projectId: string, updatedProject: ProjectSummary) => {
    setCreatedProjects(currentProjects => {
      return currentProjects.map(project => {
        if (project.projectId !== projectId) {
          return project;
        }

        return updatedProject;
      });
    });
  };

  /** Hàm tạo danh sách menu hệ thống. Mục đích: đồng bộ badge thông báo theo trạng thái đã đọc/chưa đọc. */
  const rankingItemByProjectIdMap = useMemo(() => {
    return new Map(rankingItems.map(rankingItem => [rankingItem.projectId, rankingItem]));
  }, [rankingItems]);

  const dashboardStatisticItemList = useMemo<StatisticItem[]>(() => {
    const totalProjectCount = createdProjects.length;
    const activeProjectCount = createdProjects.filter(projectItem => projectItem.status === 'ACTIVE').length;
    const completedProjectCount = createdProjects.filter(projectItem => projectItem.status === 'COMPLETED').length;
    const pendingProjectCount = createdProjects.filter(
      projectItem => projectItem.status === 'DRAFT' || projectItem.status === 'PENDING_APPROVAL'
    ).length;

    const totalDonationAmount = createdProjects.reduce((accumulator, projectItem) => {
      return accumulator + (rankingItemByProjectIdMap.get(projectItem.projectId)?.totalRaisedAmount || 0);
    }, 0);

    const projectWithDonationCount = createdProjects.filter(projectItem => {
      return (rankingItemByProjectIdMap.get(projectItem.projectId)?.totalRaisedAmount || 0) > 0;
    }).length;

    const pendingDisbursementList = disbursements.filter(disbursementItem => {
      return ['PENDING', 'APPROVED', 'EXECUTING'].includes(disbursementItem.status);
    });
    const pendingDisbursementAmount = pendingDisbursementList.reduce(
      (accumulator, disbursementItem) => accumulator + disbursementItem.amount,
      0
    );
    const disbursementNeedSignatureCount = pendingDisbursementList.filter(disbursementItem => {
      return disbursementItem.approvals.length < disbursementItem.requiredApprovals;
    }).length;

    const rankedOrganizationProjectList = createdProjects
      .map(projectItem => rankingItemByProjectIdMap.get(projectItem.projectId) || null)
      .filter((rankingItem): rankingItem is RankingItem => rankingItem !== null);
    const bestRankedProjectItem = rankedOrganizationProjectList.reduce<RankingItem | null>((bestItem, currentItem) => {
      if (!bestItem || currentItem.rankPosition < bestItem.rankPosition) {
        return currentItem;
      }
      return bestItem;
    }, null);
    const effectiveRankingTotalItems = rankingTotalItems > 0 ? rankingTotalItems : rankingItems.length;

    return [
      {
        color: 'emerald',
        icon: '💎',
        label: 'Tổng quyên góp nhận',
        value: formatCompactCurrencyVietnamese(totalDonationAmount),
        subtitle: '₫ từ dữ liệu xếp hạng QF',
        change: `${projectWithDonationCount} dự án đã có quyên góp`,
        changeStyle: 'up'
      },
      {
        color: 'blue',
        icon: '📋',
        label: 'Dự án đang hoạt động',
        value: `${activeProjectCount} / ${totalProjectCount}`,
        subtitle: `${pendingProjectCount} dự án đang chờ duyệt`,
        change: `${completedProjectCount} dự án đã hoàn thành`,
        changeStyle: activeProjectCount > 0 ? 'up' : 'warn'
      },
      {
        color: 'amber',
        icon: '⏳',
        label: 'Đang chờ giải ngân',
        value: `${formatCompactCurrencyVietnamese(pendingDisbursementAmount)} ₫`,
        subtitle: `${pendingDisbursementList.length} yêu cầu đang xử lý`,
        change: `${disbursementNeedSignatureCount} yêu cầu chưa đủ chữ ký`,
        changeStyle: pendingDisbursementList.length > 0 ? 'warn' : 'up'
      },
      {
        color: 'gold',
        icon: '🏆',
        label: 'Xếp hạng QF tốt nhất',
        value: bestRankedProjectItem ? `#${bestRankedProjectItem.rankPosition}/${effectiveRankingTotalItems}` : 'Chưa có',
        subtitle: bestRankedProjectItem ? bestRankedProjectItem.projectName : 'Chưa có dự án vào bảng xếp hạng',
        change: `${rankedOrganizationProjectList.length}/${totalProjectCount} dự án có điểm QF`,
        changeStyle: rankedOrganizationProjectList.length > 0 ? 'up' : 'warn'
      }
    ];
  }, [createdProjects, disbursements, rankingItemByProjectIdMap, rankingItems.length, rankingTotalItems]);

  const dashboardFeaturedProject = useMemo<DashboardFeaturedProject | null>(() => {
    if (createdProjects.length === 0) {
      return null;
    }

    const sortedProjectList = [...createdProjects].sort((leftProjectItem, rightProjectItem) => {
      const leftRaisedAmount = rankingItemByProjectIdMap.get(leftProjectItem.projectId)?.totalRaisedAmount || 0;
      const rightRaisedAmount = rankingItemByProjectIdMap.get(rightProjectItem.projectId)?.totalRaisedAmount || 0;
      if (leftRaisedAmount !== rightRaisedAmount) {
        return rightRaisedAmount - leftRaisedAmount;
      }
      return new Date(rightProjectItem.createdAt).getTime() - new Date(leftProjectItem.createdAt).getTime();
    });

    const selectedProjectItem = sortedProjectList[0];
    const raisedAmount = rankingItemByProjectIdMap.get(selectedProjectItem.projectId)?.totalRaisedAmount || 0;
    const progressPercent =
      selectedProjectItem.goalAmount > 0
        ? Math.min(100, Math.round((raisedAmount / selectedProjectItem.goalAmount) * 100))
        : 0;

    return {
      projectId: selectedProjectItem.projectId,
      name: selectedProjectItem.name,
      description: selectedProjectItem.description,
      raisedAmount,
      goalAmount: selectedProjectItem.goalAmount,
      progressPercent
    };
  }, [createdProjects, rankingItemByProjectIdMap]);

  const dashboardTimelineItemList = useMemo<TimelineItem[]>(() => {
    const timelineEventItemList: Array<{ timestampValue: number; dotStyle: string; content: string }> = [];
    const projectNameByProjectIdMap = new Map(createdProjects.map(projectItem => [projectItem.projectId, projectItem.name]));

    createdProjects.forEach(projectItem => {
      const createdTimestampValue = Date.parse(projectItem.createdAt);
      if (!Number.isNaN(createdTimestampValue)) {
        timelineEventItemList.push({
          timestampValue: createdTimestampValue,
          dotStyle: 'bg-[#2563EB] shadow-[0_0_0_3px_rgba(37,99,235,0.15)]',
          content: `Đã tạo dự án "${projectItem.name}".`
        });
      }

      if (projectItem.submittedAt) {
        const submittedTimestampValue = Date.parse(projectItem.submittedAt);
        if (!Number.isNaN(submittedTimestampValue)) {
          timelineEventItemList.push({
            timestampValue: submittedTimestampValue,
            dotStyle: 'bg-[#F59E0B] shadow-[0_0_0_3px_rgba(245,158,11,0.15)]',
            content: `Đã gửi dự án "${projectItem.name}" để phê duyệt.`
          });
        }
      }

      if (projectItem.reviewedAt) {
        const reviewedTimestampValue = Date.parse(projectItem.reviewedAt);
        if (!Number.isNaN(reviewedTimestampValue)) {
          if (projectItem.status === 'ACTIVE') {
            timelineEventItemList.push({
              timestampValue: reviewedTimestampValue,
              dotStyle: 'bg-[#16A34A] shadow-[0_0_0_3px_rgba(22,163,74,0.15)]',
              content: `Dự án "${projectItem.name}" đã được phê duyệt và kích hoạt.`
            });
          }

          if (projectItem.status === 'REJECTED') {
            timelineEventItemList.push({
              timestampValue: reviewedTimestampValue,
              dotStyle: 'bg-[#DC2626] shadow-[0_0_0_3px_rgba(220,38,38,0.15)]',
              content: `Dự án "${projectItem.name}" đã bị từ chối duyệt.`
            });
          }
        }
      }
    });

    disbursements.forEach(disbursementItem => {
      const createdTimestampValue = Date.parse(disbursementItem.createdAt);
      const projectName = projectNameByProjectIdMap.get(disbursementItem.projectId) || disbursementItem.projectId;
      if (!Number.isNaN(createdTimestampValue)) {
        timelineEventItemList.push({
          timestampValue: createdTimestampValue,
          dotStyle: 'bg-[#2563EB] shadow-[0_0_0_3px_rgba(37,99,235,0.15)]',
          content: `Tạo yêu cầu giải ngân ${formatCurrencyVietnamese(disbursementItem.amount)} ₫ cho dự án "${projectName}".`
        });
      }

      if (disbursementItem.status !== 'PENDING') {
        let statusTimestampValue = Date.parse(disbursementItem.updatedAt);
        if (disbursementItem.status === 'COMPLETED' && disbursementItem.completedAt) {
          statusTimestampValue = Date.parse(disbursementItem.completedAt);
        }
        if (disbursementItem.status === 'REJECTED' && disbursementItem.rejection?.rejectedAt) {
          statusTimestampValue = Date.parse(disbursementItem.rejection.rejectedAt);
        }

        if (!Number.isNaN(statusTimestampValue)) {
          if (disbursementItem.status === 'COMPLETED') {
            timelineEventItemList.push({
              timestampValue: statusTimestampValue,
              dotStyle: 'bg-[#16A34A] shadow-[0_0_0_3px_rgba(22,163,74,0.15)]',
              content: `Giải ngân ${formatCurrencyVietnamese(disbursementItem.amount)} ₫ đã hoàn tất cho dự án "${projectName}".`
            });
          } else if (disbursementItem.status === 'REJECTED') {
            timelineEventItemList.push({
              timestampValue: statusTimestampValue,
              dotStyle: 'bg-[#DC2626] shadow-[0_0_0_3px_rgba(220,38,38,0.15)]',
              content: `Yêu cầu giải ngân của dự án "${projectName}" đã bị từ chối.`
            });
          } else if (disbursementItem.status === 'APPROVED' || disbursementItem.status === 'EXECUTING') {
            timelineEventItemList.push({
              timestampValue: statusTimestampValue,
              dotStyle: 'bg-[#F59E0B] shadow-[0_0_0_3px_rgba(245,158,11,0.15)]',
              content: `Yêu cầu giải ngân của dự án "${projectName}" đang được xử lý.`
            });
          } else if (disbursementItem.status === 'EXPIRED' || disbursementItem.status === 'CANCELLED') {
            timelineEventItemList.push({
              timestampValue: statusTimestampValue,
              dotStyle: 'bg-[#DC2626] shadow-[0_0_0_3px_rgba(220,38,38,0.15)]',
              content: `Yêu cầu giải ngân của dự án "${projectName}" đã kết thúc với trạng thái ${disbursementItem.status}.`
            });
          }
        }
      }
    });

    return timelineEventItemList
      .sort((leftTimelineEventItem, rightTimelineEventItem) => rightTimelineEventItem.timestampValue - leftTimelineEventItem.timestampValue)
      .slice(0, 6)
      .map(timelineEventItem => ({
        dotStyle: timelineEventItem.dotStyle,
        content: timelineEventItem.content,
        time: formatDashboardTimeLabel(timelineEventItem.timestampValue)
      }));
  }, [createdProjects, disbursements]);

  const isDashboardLoading = isProjectsLoading || isDisbursementsLoading || isRankingLoading;
  const dashboardErrorMessage = projectsErrorMessage || disbursementsErrorMessage || rankingErrorMessage;

  /** Hàm tải lại dữ liệu thật cho tab Tổng quan. Mục đích: đồng bộ lại Projects, Disbursements và Ranking khi người dùng bấm retry. */
  const handleRetryLoadDashboardData = () => {
    void Promise.all([loadProjectsFromApi(), loadDisbursementsFromApi(), loadRankingFromApi()]);
  };

  /** Hàm tải lại lịch sử quyên góp của Dashboard. Mục đích: cho phép người dùng retry riêng khối “Lịch sử quyên góp”. */
  const handleRetryLoadDonationHistory = () => {
    void loadDashboardDonationHistory(createdProjects);
  };

  const systemNavigationItemsWithNotificationState = useMemo(() => {
    return systemNavigationItems.map(item => {
      if (item.action !== 'toggleNotification') {
        return item;
      }

      // Logic này chỉ gắn badge cho item thông báo để reset số khi người dùng đánh dấu đã đọc.
      return {
        ...item,
        badge: unreadNotificationCount > 0 ? String(unreadNotificationCount) : undefined
      };
    });
  }, [unreadNotificationCount]);

  /** Hàm xử lý chọn trang từ sidebar. Mục đích: điều hướng trang và tắt trạng thái nhấn mạnh cài đặt ngân hàng khi rời trang. */
  const handleSelectPage = (page: OrganizationPageKey) => {
    setActivePage(page);

    if (page !== 'settings') {
      setIsBankSetupHighlighted(false);
    }
  };

  /** Hàm xử lý liên kết tài khoản ngân hàng. Mục đích: chuyển nhanh sang tab cài đặt ngân hàng để người dùng thao tác. */
  const handleLinkBankAccount = () => {
    setActivePage('settings');
    setIsBankSetupHighlighted(true);
  };


  /** Hàm kiểm tra quyền truy cập Organizations tại frontend kết hợp xác thực server để tránh bypass. */
  const verifyOrganizationAccess = useCallback(async () => {
    const sessionPayload = readAuthSession();
    if (!sessionPayload.accessToken) {
      clearAuthSession();
      router.replace('/login');
      return;
    }

    setUserDisplayName(sessionPayload.userFullName || 'Người dùng');
    setUserEmail(sessionPayload.userEmail || '');
    setUserWalletAddress(sessionPayload.userWalletAddress || '');

    // Ghi chú logic phức tạp: chặn sớm từ dữ liệu local để giảm flash UI,
    // sau đó vẫn gọi server /auth/me để chống giả mạo role ở client.
    const isOrganizationRoleFromLocal =
      sessionPayload.userRole === 'organization' || sessionPayload.userRole === 'organizations';
    if (sessionPayload.userRole && !isOrganizationRoleFromLocal) {
      clearAuthSession();
      router.replace('/');
      return;
    }

    try {
      const response = await fetch(`${backendBaseUrl}/auth/me`, {
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

      const responseData = await response.json();
      const userRole = responseData?.user?.role as string | undefined;
      const isOrganizationRoleFromServer = userRole === 'organization' || userRole === 'organizations';
      if (!isOrganizationRoleFromServer) {
        clearAuthSession();
        router.replace('/');
        return;
      }
    } catch (_error) {
      clearAuthSession();
      router.replace('/login');
      return;
    } finally {
      setIsAccessChecking(false);
    }
  }, [backendBaseUrl, router]);

  /** Hàm gọi API logout, xóa phiên cục bộ và điều hướng về login an toàn. */
  const handleLogout = useCallback(async () => {
    if (isLogoutProcessing) {
      return;
    }

    setIsLogoutProcessing(true);
    const sessionPayload = readAuthSession();

    try {
      if (sessionPayload.accessToken) {
        await fetch(`${backendBaseUrl}/auth/logout-all`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${sessionPayload.accessToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({})
        });
      }
    } catch (_error) {
      // Ghi chú logic phức tạp: vẫn tiếp tục clear session local để chắc chắn đóng phiên client.
    } finally {
      clearAuthSession();
      window.sessionStorage.clear();
      router.replace('/login');
      router.refresh();
      setIsLogoutProcessing(false);
    }
  }, [backendBaseUrl, isLogoutProcessing, router]);
  /** Hàm đánh dấu toàn bộ thông báo đã đọc. Mục đích: cập nhật trạng thái thông báo thật và xóa badge. */
  const handleMarkAllNotificationsAsRead = async () => {
    const authSession = readAuthSession();
    if (!authSession?.accessToken) {
      setNotificationErrorMessage('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.');
      return;
    }

    try {
      const response = await fetchApi<NotificationListResponse>(buildApiUrl('/api/notifications/read-all'), {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${authSession.accessToken}` }
      });
      applyNotificationResponse(response.data);
    } catch (error: unknown) {
      setNotificationErrorMessage(resolveApiErrorMessage(error, 'Không thể đánh dấu thông báo đã đọc. Vui lòng thử lại sau.'));
    }
  };

  /** Hàm đóng dropdown thông báo. Mục đích: gom một điểm xử lý đóng popup để tái sử dụng. */
  const handleCloseNotificationDropdown = () => {
    setIsNotificationOpen(false);
  };

  /** Hàm mở thông báo từ topbar. Mục đích: đồng bộ thao tác chuông thông báo giữa topbar và sidebar. */
  const handleOpenTopbarNotification = () => {
    setIsNotificationOpen(currentState => !currentState);
    void loadNotificationsFromApi();
  };

  /** Hàm mở menu mobile. Mục đích: giữ tương thích API của Topbar trong khi sidebar hiện tại là desktop cố định. */
  const handleOpenMobileMenu = () => {
    setIsMobileMenuOpen(true);
  };

  /** Hàm chạy guard phân quyền khi component mount. */
  useEffect(() => {
    void verifyOrganizationAccess();
  }, [verifyOrganizationAccess]);

  useEffect(() => {
    if (activePage !== 'settings') {
      setIsBankSetupHighlighted(false);
    }
  }, [activePage]);

  useEffect(() => {
    if (isAccessChecking) {
      return;
    }

    void Promise.all([
      loadProjectsFromApi(),
      loadCreateProjectEligibility(),
      loadOrganizationKycSubmissions(),
      loadDisbursementsFromApi(),
      loadRankingFromApi(),
      loadNotificationsFromApi()
    ]);
  }, [isAccessChecking, loadNotificationsFromApi]);

  useEffect(() => {
    if (isAccessChecking) {
      return;
    }

    const authSession = readAuthSession();
    if (!authSession?.accessToken) {
      return;
    }

    const abortController = new AbortController();
    let pollingInterval: ReturnType<typeof setInterval> | null = null;

    /** Hàm bật polling dự phòng. Mục đích: vẫn nhận thông báo khi stream bị proxy/trình duyệt ngắt. */
    const startFallbackPolling = () => {
      if (pollingInterval) {
        return;
      }

      void loadNotificationsFromApi();
      pollingInterval = setInterval(() => {
        void loadNotificationsFromApi();
      }, 5000);
    };

    /** Hàm xử lý từng gói SSE. Mục đích: parse snapshot realtime và cập nhật badge thông báo. */
    const handleNotificationStreamChunk = (streamChunk: string) => {
      const dataLine = streamChunk.split('\n').find(lineItem => lineItem.startsWith('data: '));
      if (!dataLine) {
        return;
      }

      try {
        applyNotificationResponse(JSON.parse(dataLine.replace('data: ', '')) as NotificationListResponse);
        setNotificationErrorMessage(null);
      } catch (_error) {
        startFallbackPolling();
      }
    };

    /** Hàm kết nối stream thông báo. Mục đích: nhận realtime bằng Authorization header thay vì đưa token lên URL. */
    const connectNotificationStream = async () => {
      try {
        const streamResponse = await fetch(buildApiUrl('/api/notifications/stream'), {
          method: 'GET',
          headers: { Authorization: `Bearer ${authSession.accessToken}` },
          signal: abortController.signal
        });

        if (!streamResponse.ok || !streamResponse.body) {
          startFallbackPolling();
          return;
        }

        const streamReader = streamResponse.body.getReader();
        const textDecoder = new TextDecoder();
        let bufferedText = '';

        while (true) {
          const { value, done } = await streamReader.read();
          if (done) {
            break;
          }

          bufferedText += textDecoder.decode(value, { stream: true });
          const streamChunkList = bufferedText.split('\n\n');
          bufferedText = streamChunkList.pop() || '';
          streamChunkList.forEach(handleNotificationStreamChunk);
        }
      } catch (error: unknown) {
        if (!abortController.signal.aborted) {
          startFallbackPolling();
        }
      }
    };

    void connectNotificationStream();

    return () => {
      abortController.abort();
      if (pollingInterval) {
        clearInterval(pollingInterval);
      }
    };
  }, [applyNotificationResponse, isAccessChecking, loadNotificationsFromApi]);

  useEffect(() => {
    if (isAccessChecking) {
      return;
    }

    void loadDashboardDonationHistory(createdProjects);
  }, [createdProjects, isAccessChecking, loadDashboardDonationHistory]);

  useEffect(() => {
    if (activePage !== 'projects') {
      return;
    }

    // Khi người dùng vào tab dự án, luôn re-check eligibility để đồng bộ trạng thái chặn/mở nút tạo dự án ngay lập tức.
    void loadCreateProjectEligibility();
  }, [activePage]);

  if (isAccessChecking) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#F8FAFB] text-[#0D1117]">
        <p className="text-sm font-medium text-[#4B5563]">Đang kiểm tra quyền truy cập...</p>
      </main>
    );
  }

  const dashboardSectionProps: ComponentProps<typeof DashboardSection> = {
    onLinkBankAccount: handleLinkBankAccount,
    hasApprovedBeneficiaryBankAccount: isCreateProjectAllowed,
    statisticItemList: dashboardStatisticItemList,
    dashboardTimelineItemList,
    dashboardDonationHistoryItemList,
    featuredProject: dashboardFeaturedProject,
    isDashboardLoading,
    isDonationHistoryLoading,
    dashboardErrorMessage,
    donationHistoryErrorMessage,
    onRetryLoadDashboardData: handleRetryLoadDashboardData,
    onRetryLoadDonationHistory: handleRetryLoadDonationHistory
  };

  return (
    <main className="min-h-screen bg-[#F8FAFB] text-[#0D1117]">
      <div className="flex">
        <aside className="fixed left-0 top-0 z-30 hidden h-screen w-[248px] flex-col border-r border-[#0F6B5D] bg-gradient-to-b from-[#0E7C6B] via-[#0A5C50] to-[#08473F] lg:flex">
          <div className="border-b border-white/10 px-5 py-5">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/15 shadow-[0_8px_20px_rgba(0,0,0,0.18)] ring-1 ring-white/20">
                <svg viewBox="0 0 24 24" className="h-5 w-5 text-white" fill="currentColor" aria-hidden="true">
                  <path d="M12 21.7C5.8 17.5 2 13.2 2 9a6 6 0 0112 0 6 6 0 0112 0c0 4.2-3.8 8.5-10 12.7z" />
                </svg>
              </div>
              <div>
                <p className="text-[15px] font-bold leading-none text-white">DCP</p>
                <p className="mt-1 text-[10px] uppercase tracking-[0.12em] text-white/55">Decentralized Charity Platform</p>
              </div>
            </div>
          </div>

          <div className="border-b border-white/10 px-5 py-4">
            <p className="text-xs font-semibold text-white">Quỹ Hy Vọng Xanh</p>
            <p className="mt-1 text-[10px] text-[#4ADE80]">● Đã xác minh KYC</p>
          </div>

          <div className="px-4 py-4 text-[10px] font-semibold uppercase tracking-[0.14em] text-white/45">CHÍNH</div>
          <div className="space-y-1 px-3">
            {primaryNavigationItems.map(item => (
              <SidebarItem
                key={item.label}
                item={item}
                activePage={activePage}
                onSelectPage={handleSelectPage}
                onTriggerAction={handleSidebarAction}
              />
            ))}
          </div>

          <div className="px-4 py-4 text-[10px] font-semibold uppercase tracking-[0.14em] text-white/45">TÀI CHÍNH</div>
          <div className="space-y-1 px-3">
            {financeNavigationItems.map(item => (
              <SidebarItem
                key={item.label}
                item={item}
                activePage={activePage}
                onSelectPage={handleSelectPage}
                onTriggerAction={handleSidebarAction}
              />
            ))}
          </div>

          <div className="px-4 py-4 text-[10px] font-semibold uppercase tracking-[0.14em] text-white/45">HỆ THỐNG</div>
          <div className="space-y-1 px-3">
            {systemNavigationItemsWithNotificationState.map(item => (
              <SidebarItem
                key={item.label}
                item={item}
                activePage={activePage}
                onSelectPage={handleSelectPage}
                onTriggerAction={handleSidebarAction}
              />
            ))}
          </div>

          <div className="m-4 mt-auto">
            <button
              type="button"
              onClick={() => {
                void handleLogout();
              }}
              disabled={isLogoutProcessing}
              className="w-full rounded-xl border border-white/15 bg-white/10 px-3 py-2 text-xs font-semibold text-white transition hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isLogoutProcessing ? 'Đang đăng xuất...' : 'Đăng xuất'}
            </button>
          </div>
        </aside>

        <section className="flex min-h-screen flex-1 flex-col lg:ml-[248px]">
          <Topbar
            breadcrumbTitle={pageTitle}
            userDisplayName={userDisplayName}
            userEmail={userEmail}
            userWalletAddress={userWalletAddress}
            notificationCount={unreadNotificationCount}
            onOpenMobileMenu={handleOpenMobileMenu}
            onOpenNotification={handleOpenTopbarNotification}
            onLogout={() => {
              void handleLogout();
            }}
          />

          <div className="px-4 py-4 sm:px-5 sm:py-5 lg:p-7">
            {activePage === 'dashboard' ? (
              <DashboardSection {...dashboardSectionProps} />
            ) : null}
            {activePage === 'projects' ? (
              <ProjectsSection
                createdProjects={createdProjects}
                raisedAmountByProjectIdMap={new Map(Array.from(rankingItemByProjectIdMap.entries()).map(([projectId, rankingItem]) => [projectId, rankingItem.totalRaisedAmount]))}
                isProjectsLoading={isProjectsLoading}
                projectsErrorMessage={projectsErrorMessage}
                onRetryLoadProjects={loadProjectsFromApi}
                onOpenCreateProjectModal={() => {
                  void handleOpenCreateProjectModal();
                }}
                isCreateProjectAllowed={isCreateProjectAllowed}
                createProjectBlockReason={createProjectBlockReason}
                onGoToBankSettings={handleLinkBankAccount}
                onProjectSubmitted={handleProjectSubmitted}
                onProjectUpdated={handleProjectUpdated}
              />
            ) : null}
            {activePage === 'disbursement' ? (
              <DisbursementSection
                activeDisbursementTab={activeDisbursementTab}
                onChangeDisbursementTab={setActiveDisbursementTab}
                disbursements={disbursements}
                isDisbursementsLoading={isDisbursementsLoading}
                disbursementsErrorMessage={disbursementsErrorMessage}
                onRetryLoadDisbursements={loadDisbursementsFromApi}
                createdProjects={createdProjects}
                raisedAmountByProjectIdMap={new Map(Array.from(rankingItemByProjectIdMap.entries()).map(([projectId, rankingItem]) => [projectId, rankingItem.totalRaisedAmount]))}
                onOpenCreateDisbursementModal={handleOpenCreateDisbursementModal}
              />
            ) : null}
            {activePage === 'transparency' ? <TransparencySection /> : null}
            {activePage === 'settings' ? (
              <SettingsSection
                isBankSetupHighlighted={isBankSetupHighlighted}
                organizationKycSubmissionList={organizationKycSubmissionList}
                isOrganizationKycLoading={isOrganizationKycLoading}
                organizationKycErrorMessage={organizationKycErrorMessage}
                onRetryLoadOrganizationKycSubmissions={loadOrganizationKycSubmissions}
                onBankSubmissionSuccess={handleBankSubmissionSuccess}
              />
            ) : null}
          </div>
        </section>
      </div>

      {isMobileMenuOpen ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            aria-label="Đóng menu điều hướng"
            onClick={() => setIsMobileMenuOpen(false)}
            className="absolute inset-0 bg-black/45"
          />
          <aside className="relative z-10 flex h-full w-[248px] max-w-[86vw] flex-col border-r border-[#0F6B5D] bg-gradient-to-b from-[#0E7C6B] via-[#0A5C50] to-[#08473F] shadow-2xl">
            <div className="flex items-center justify-between border-b border-white/10 px-5 py-5">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/15 shadow-[0_8px_20px_rgba(0,0,0,0.18)] ring-1 ring-white/20">
                  <svg viewBox="0 0 24 24" className="h-5 w-5 text-white" fill="currentColor" aria-hidden="true">
                    <path d="M12 21.7C5.8 17.5 2 13.2 2 9a6 6 0 0112 0 6 6 0 0112 0c0 4.2-3.8 8.5-10 12.7z" />
                  </svg>
                </div>
                <div className="min-w-0">
                  <p className="text-[15px] font-bold leading-none text-white">DCP</p>
                  <p className="mt-1 text-[10px] uppercase tracking-[0.12em] text-white/55">Decentralized Charity Platform</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setIsMobileMenuOpen(false)}
                className="rounded-lg bg-white/10 px-2.5 py-1.5 text-sm font-semibold text-white"
              >
                X
              </button>
            </div>

            <div className="border-b border-white/10 px-5 py-4">
              <p className="text-xs font-semibold text-white">Quỹ Hy Vọng Xanh</p>
              <p className="mt-1 text-[10px] text-[#4ADE80]">● Đã xác minh KYC</p>
            </div>

            <div className="overflow-y-auto px-1 pb-4">
              <div className="px-4 py-4 text-[10px] font-semibold uppercase tracking-[0.14em] text-white/45">CHÍNH</div>
              <div className="space-y-1 px-3">
                {primaryNavigationItems.map(item => (
                  <SidebarItem
                    key={`mobile-${item.label}`}
                    item={item}
                    activePage={activePage}
                    onSelectPage={page => {
                      handleSelectPage(page);
                      setIsMobileMenuOpen(false);
                    }}
                    onTriggerAction={action => {
                      handleSidebarAction(action);
                      setIsMobileMenuOpen(false);
                    }}
                  />
                ))}
              </div>

              <div className="px-4 py-4 text-[10px] font-semibold uppercase tracking-[0.14em] text-white/45">TÀI CHÍNH</div>
              <div className="space-y-1 px-3">
                {financeNavigationItems.map(item => (
                  <SidebarItem
                    key={`mobile-${item.label}`}
                    item={item}
                    activePage={activePage}
                    onSelectPage={page => {
                      handleSelectPage(page);
                      setIsMobileMenuOpen(false);
                    }}
                    onTriggerAction={action => {
                      handleSidebarAction(action);
                      setIsMobileMenuOpen(false);
                    }}
                  />
                ))}
              </div>

              <div className="px-4 py-4 text-[10px] font-semibold uppercase tracking-[0.14em] text-white/45">HỆ THỐNG</div>
              <div className="space-y-1 px-3">
                {systemNavigationItemsWithNotificationState.map(item => (
                  <SidebarItem
                    key={`mobile-${item.label}`}
                    item={item}
                    activePage={activePage}
                    onSelectPage={page => {
                      handleSelectPage(page);
                      setIsMobileMenuOpen(false);
                    }}
                    onTriggerAction={action => {
                      handleSidebarAction(action);
                      setIsMobileMenuOpen(false);
                    }}
                  />
                ))}
              </div>
            </div>
          </aside>
        </div>
      ) : null}

      {isNotificationOpen ? (
        <NotificationDropdown
          notificationItemList={notificationItemList}
          unreadNotificationCount={unreadNotificationCount}
          isNotificationLoading={isNotificationLoading}
          notificationErrorMessage={notificationErrorMessage}
          onMarkAllAsRead={handleMarkAllNotificationsAsRead}
          onRequestClose={handleCloseNotificationDropdown}
        />
      ) : null}
      {realtimeToastNotification ? (
        <button
          type="button"
          onClick={() => {
            setRealtimeToastNotification(null);
            setIsNotificationOpen(true);
            void loadNotificationsFromApi();
          }}
          className="fixed left-3 right-3 top-[72px] z-50 w-auto rounded-2xl border border-[#D1FAE5] bg-white p-3 text-left shadow-[0_18px_55px_rgba(15,23,42,0.18)] transition hover:-translate-y-0.5 hover:shadow-[0_22px_65px_rgba(15,23,42,0.22)] sm:left-auto sm:right-6 sm:top-20 sm:w-[360px] sm:max-w-[calc(100vw-32px)] sm:p-4"
        >
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-[#ECFDF5] text-lg" aria-hidden="true">
              {realtimeToastNotification.notificationType === 'DONATION_RECEIVED' ? '💚' : '✍️'}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold text-[#064E3B]">{realtimeToastNotification.title}</p>
              <p className="mt-1 text-sm leading-5 text-[#374151]">{realtimeToastNotification.content}</p>
              <p className="mt-2 text-xs font-semibold text-[#0F766E]">Bấm để xem danh sách thông báo</p>
            </div>
            <span
              role="button"
              tabIndex={0}
              onClick={event => {
                event.stopPropagation();
                setRealtimeToastNotification(null);
              }}
              onKeyDown={event => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  event.stopPropagation();
                  setRealtimeToastNotification(null);
                }
              }}
              className="rounded-full px-2 text-lg leading-none text-[#9CA3AF] hover:bg-[#F3F4F6] hover:text-[#374151]"
              aria-label="Đóng thông báo realtime"
            >
              ×
            </span>
          </div>
        </button>
      ) : null}
      {isCreateProjectOpen ? (
        <CreateProjectModal
          onClose={() => setIsCreateProjectOpen(false)}
          onProjectCreated={handleProjectCreated}
        />
      ) : null}
      {selectedDisbursementProject && approvedBeneficiaryBankAccount ? (
        <CreateDisbursementModal
          project={selectedDisbursementProject}
          beneficiaryBankAccount={approvedBeneficiaryBankAccount}
          onClose={() => setSelectedDisbursementProject(null)}
          onCreated={handleDisbursementCreated}
        />
      ) : null}
    </main>
  );
}
