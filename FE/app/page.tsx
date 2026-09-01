'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import Link from 'next/link';
import { buildApiUrl, fetchApi } from './utils/apiClient';
import { authenticationSessionUpdatedEventName, clearAuthSession, readAuthSession } from './utils/authSession';
import { useLogoutConfirmation } from '@/app/hooks/useLogoutConfirmation';
import IpfsEvidencePreviewCard from '@/app/components/common/IpfsEvidencePreviewCard';
import { buildIpfsGatewayUrl, getIpfsContentType, resolveIpfsPreviewKind } from './utils/ipfs';
import FairRankingTab from '@/app/components/fairRanking/FairRankingTab';
import { PublicCommitteeGovernanceFeed } from '@/app/components/governance/PublicCommitteeGovernanceFeed';


type HomeProjectEvidenceFile = {
  cid: string;
  fileName: string;
  mimeType: string;
};

type HomeSupportProject = {
  projectId: string;
  name: string;
  description: string;
  goalAmount: number;
  deadline?: string;
  status: string;
  evidenceCids: string[];
  evidenceFiles?: HomeProjectEvidenceFile[];
  updatedAt: string;
  createdAt: string;
};

type HomeSupportProjectDetail = {
  projectId: string;
  name: string;
  description: string;
  goalAmount: number;
  status: string;
  lastDonationAt: string | null;
  evidenceCids: string[];
  evidenceFiles?: HomeProjectEvidenceFile[];
  creatorName: string | null;
};

type HomeDonationCampaignDetail = {
  projectId: string;
  name: string;
  description: string;
  goalAmount: number;
  donatedAmount: number;
  donationCount: number;
  status: string;
  deadline?: string;
};

type HomeDonationCampaignSummary = {
  projectId: string;
  donatedAmount: number;
};




type RankingItem = {
  projectId: string;
  projectName: string;
  organizationName: string;
  rankPosition: number;
  totalRaisedAmount: number;
  uniqueDonorCount: number;
  quadraticScoreRaw: number;
  matchingAmount: number;
  totalFundingScore: number;
};

type RankingSnapshotResponse = {
  snapshot: {
    calculatedAt: string;
    calculationWindowHours: number;
    totalValidDonations: number;
  } | null;
  items: RankingItem[];
  metadata: {
    totalItems: number;
    totalPages: number;
    currentPage: number;
    pageSize: number;
  };
};

type TransactionItem = {
  id: string;
  type: 'donation' | 'disbursement';
  displayName: string;
  project: string;
  amount: string;
  time: string;
  amountColor?: string;
};

type LiveFeedApiTransactionItem = {
  id: string;
  type: 'donation' | 'disbursement';
  displayName: string;
  transactionHash: string;
  projectId: string;
  projectName: string;
  organizationName: string | null;
  amount: number;
  currencySymbol: string;
  occurredAt: string;
  explorerUrl: string | null;
  displayDirection: 'inflow' | 'outflow';
};

type StatItem = {
  id: number;
  value: number;
  suffix: string;
  label: string;
  delay?: number;
};

const projectCardIconList = ['🏫', '🏥', '🌊', '👶', '💧', '🌱'];
const projectCardBackgroundList = [
  'linear-gradient(135deg,#E6F7F4,#B2EEE4)',
  'linear-gradient(135deg,#FEF3C7,#FDE68A)',
  'linear-gradient(135deg,#EDE9FE,#C4B5FD)',
  'linear-gradient(135deg,#FEE2E2,#FCA5A5)',
  'linear-gradient(135deg,#DBEAFE,#93C5FD)',
  'linear-gradient(135deg,#DCFCE7,#86EFAC)'
];

const stats: StatItem[] = [
  { id: 1, value: 2847500000, suffix: '₫', label: 'Tổng quyên góp' },
  { id: 2, value: 89, suffix: '', label: 'Dự án hoàn thành', delay: 0.1 },
  { id: 3, value: 15842, suffix: '', label: 'Nhà hảo tâm', delay: 0.2 },
  { id: 4, value: 98, suffix: '%', label: 'Giao dịch thành công', delay: 0.3 }
];
const chartData = [
  45, 72, 58, 91, 68, 110, 95, 130, 88, 145, 162, 138, 155, 178, 142, 190, 168, 205, 182, 220, 195, 245,
  210, 260, 238, 280, 255, 300, 272, 295
];

const trustItems = [
  { label: '💰 Tổng quyên góp', value: '2,847,500,000₫' },
  { label: '📋 Dự án hoạt động', value: '127' },
  { label: '👥 Nhà hảo tâm', value: '15,842' },
  { label: '⛓ Giao dịch on-chain', value: '98,341' },
  { label: '🏆 Dự án hoàn thành', value: '89' }
];

/** Hàm định dạng thời gian tương đối. Mục đích: hiển thị cảm giác realtime dễ đọc cho live feed homepage. */
const formatRelativeTime = (occurredAtIso: string): string => {
  const occurredAtDate = new Date(occurredAtIso);
  const occurredAtTimestamp = occurredAtDate.getTime();

  if (!Number.isFinite(occurredAtTimestamp)) {
    return 'Vừa cập nhật';
  }

  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - occurredAtTimestamp) / 1000));

  if (elapsedSeconds < 5) {
    return 'Vừa xong';
  }

  if (elapsedSeconds < 60) {
    return `${elapsedSeconds} giây trước`;
  }

  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) {
    return `${elapsedMinutes} phút trước`;
  }

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) {
    return `${elapsedHours} giờ trước`;
  }

  const elapsedDays = Math.floor(elapsedHours / 24);
  return `${elapsedDays} ngày trước`;
};

/** Hàm map dữ liệu API thành item hiển thị. Mục đích: cô lập logic render live feed thật để UI không phụ thuộc trực tiếp backend shape. */
const mapLiveFeedApiTransactionToViewModel = (transactionItem: LiveFeedApiTransactionItem): TransactionItem => {
  const amountPrefix = transactionItem.displayDirection === 'inflow' ? '+' : '-';
  const amountColor = transactionItem.type === 'disbursement' ? '#3B82F6' : undefined;
  const projectPrefix = transactionItem.type === 'disbursement' ? 'Giải ngân → ' : '→ ';

  return {
    id: transactionItem.id,
    type: transactionItem.type,
    displayName: transactionItem.displayName,
    project: `${projectPrefix}${transactionItem.projectName}`,
    amount: `${amountPrefix}${formatCurrencyVnd(transactionItem.amount)}${transactionItem.currencySymbol}`,
    time: formatRelativeTime(transactionItem.occurredAt),
    amountColor
  };
};

/**
 * Hàm định dạng số liệu đếm theo phong cách thống kê gốc.
 * Mục đích: giữ đúng định dạng chữ số tại phần thống kê.
 */
const formatStatValue = (value: number, suffix: string) => {
  if (value > 1000000) {
    return `${(value / 1000000).toFixed(0)}M${suffix}`;
  }

  if (value > 999) {
    return `${value.toLocaleString('vi')}${suffix}`;
  }

  return `${value}${suffix}`;
};

/** Hàm định dạng số tiền theo chuẩn tiền Việt. Mục đích: hiển thị mục tiêu gây quỹ rõ ràng cho người dùng. */
const formatCurrencyVnd = (amountValue: number): string => {
  return new Intl.NumberFormat('vi-VN').format(amountValue);
};

/** Hàm định dạng thời gian cập nhật. Mục đích: hiển thị mốc cập nhật gần nhất của dự án ở section homepage. */
const formatUpdatedTime = (updatedAtIso: string): string => {
  const parsedUpdatedAt = new Date(updatedAtIso);

  if (Number.isNaN(parsedUpdatedAt.getTime())) {
    return 'Không xác định';
  }

  return parsedUpdatedAt.toLocaleString('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
};

/** Hàm định dạng điểm QF hiển thị. Mục đích: giữ số thập phân ngắn gọn và đồng nhất trong bảng xếp hạng. */
const formatRankingScore = (scoreValue: number): string => {
  return Number(scoreValue || 0).toFixed(2);
};

/** Hàm định dạng timestamp ranking. Mục đích: hiển thị thời điểm cập nhật bảng xếp hạng cho người dùng. */
const formatRankingCalculatedAt = (calculatedAtIso: string): string => {
  const parsedCalculatedAt = new Date(calculatedAtIso);
  if (Number.isNaN(parsedCalculatedAt.getTime())) {
    return '';
  }

  return parsedCalculatedAt.toLocaleString('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
};

/** Hàm kiểm tra campaign còn hạn donate. Mục đích: chặn thao tác quyên góp với dự án đã hết hạn. */
const isCampaignBeforeDeadline = (deadlineIso?: string): boolean => {
  if (!deadlineIso) {
    return true;
  }

  const parsedDeadline = new Date(deadlineIso);
  if (Number.isNaN(parsedDeadline.getTime())) {
    return true;
  }

  return parsedDeadline.getTime() >= Date.now();
};

/** Hàm kiểm tra campaign đủ điều kiện donate. Mục đích: gom rule nghiệp vụ UC3.1 tại Home. */
const isCampaignEligibleForDonation = (campaignItem: HomeDonationCampaignDetail): boolean => {
  return campaignItem.status === 'ACTIVE' && isCampaignBeforeDeadline(campaignItem.deadline);
};

/** Hàm kiểm tra project card còn được phép quyên góp hay không. Mục đích: ẩn CTA quyên góp nếu dự án đã quá deadline. */
const isSupportProjectDonationAvailable = (projectItem: HomeSupportProject): boolean => {
  return projectItem.status === 'ACTIVE' && isCampaignBeforeDeadline(projectItem.deadline);
};

/** Hàm chuẩn hóa projectId cho relay. Mục đích: hỗ trợ cả mã thuần số và mã có chứa số như PRJ-1001. */
const resolveRelayProjectId = (projectId: string): string => {
  const normalizedProjectId = projectId.trim();
  if (/^[0-9]+$/.test(normalizedProjectId)) {
    return normalizedProjectId;
  }

  const numericPartMatch = normalizedProjectId.match(/([0-9]+)/);
  if (numericPartMatch?.[1]) {
    return numericPartMatch[1];
  }

  return '';
};

/** Hàm map lỗi donation sang thông điệp dễ hiểu. Mục đích: phân loại lỗi đúng ngữ cảnh cho luồng relay backend. */
const mapDonationErrorMessage = (error: unknown): string => {
  const apiError = error as { statusCode?: number; message?: string; errorCode?: string };
  if (apiError?.statusCode === 401) return 'Bạn chưa đăng nhập hoặc phiên đã hết hạn. Vui lòng đăng nhập lại để quyên góp.';
  if (apiError?.errorCode === 'CHAIN_MISMATCH') return 'Hệ thống relay đang ở sai mạng blockchain. Vui lòng thử lại sau.';
  if (apiError?.errorCode === 'TRANSACTION_TIMEOUT') return 'Giao dịch đang pending quá lâu. Vui lòng đợi thêm hoặc thử lại sau.';
  if (apiError?.errorCode === 'TRANSACTION_REVERTED') return 'Giao dịch bị từ chối trên blockchain. Vui lòng kiểm tra lại số dư token.';
  if (apiError?.errorCode === 'PAYMASTER_POLICY_MISMATCH') return 'Hệ thống tài trợ phí gas chưa cấu hình policy phù hợp cho giao dịch quyên góp. Vui lòng liên hệ quản trị viên.';
  if (apiError?.errorCode === 'VALIDATION_ERROR') {
    return apiError.message || 'Dữ liệu quyên góp không hợp lệ. Vui lòng kiểm tra lại thông tin.';
  }
  return apiError?.message || (error as Error)?.message || 'Không thể gửi giao dịch quyên góp lúc này. Vui lòng thử lại sau.';
};
/** Hàm hiển thị nhãn trạng thái dự án thân thiện. Mục đích: chuẩn hóa trạng thái kỹ thuật thành tiếng Việt dễ hiểu. */
const getPublicProjectStatusLabel = (statusValue: string): string => {
  if (statusValue === 'ACTIVE') {
    return 'Đang hoạt động';
  }

  if (statusValue === 'PENDING_APPROVAL') {
    return 'Chờ duyệt';
  }

  if (statusValue === 'PENDING_ACTIVATION') {
    return 'Đang niêm yết chờ kích hoạt';
  }

  if (statusValue === 'DISPUTED') {
    return 'Đang tranh chấp';
  }

  return statusValue;
};

/** Hàm kiểm tra CID IPFS cơ bản. Mục đích: chỉ cho phép render link với CID hợp lệ để tránh URL rác. */

/** Hàm lấy icon và nền card theo vị trí. Mục đích: giữ giao diện đồng nhất khi dữ liệu dự án đến từ API thật. */
const getProjectVisualByIndex = (indexNumber: number): { icon: string; background: string } => {
  const normalizedIndexNumber = Math.abs(indexNumber);
  const icon = projectCardIconList[normalizedIndexNumber % projectCardIconList.length] || '📌';
  const background =
    projectCardBackgroundList[normalizedIndexNumber % projectCardBackgroundList.length] ||
    'linear-gradient(135deg,#E5E7EB,#D1D5DB)';

  return { icon, background };
};

/** Hàm lấy CID ảnh đầu tiên theo metadata dự án. Mục đích: ưu tiên thông tin mimeType/fileName đã có sẵn từ backend. */
const getFirstProjectImageCidFromMetadata = (projectItem: HomeSupportProject): string => {
  const evidenceFileList = projectItem.evidenceFiles || [];
  const firstImageEvidenceFile = evidenceFileList.find(fileItem =>
    resolveIpfsPreviewKind({ mimeType: fileItem.mimeType, fileName: fileItem.fileName }) === 'image'
  );

  return firstImageEvidenceFile?.cid || '';
};

/** Hàm tìm CID ảnh đầu tiên qua danh sách CID Pinata. Mục đích: kiểm tra song song để giảm độ trễ nhưng vẫn giữ đúng thứ tự ảnh đầu tiên. */
const resolveFirstProjectImageCid = async (projectItem: HomeSupportProject): Promise<string> => {
  const imageCidFromMetadata = getFirstProjectImageCidFromMetadata(projectItem);
  if (imageCidFromMetadata) {
    return imageCidFromMetadata;
  }

  const evidenceCidList = (projectItem.evidenceCids || []).filter(evidenceCid => Boolean(evidenceCid?.trim()));
  const evidenceContentTypeList = await Promise.all(evidenceCidList.map(evidenceCid => getIpfsContentType(evidenceCid)));
  const firstImageIndex = evidenceContentTypeList.findIndex(contentType => resolveIpfsPreviewKind({ contentType }) === 'image');

  return firstImageIndex >= 0 ? evidenceCidList[firstImageIndex] : '';
};

/**
 * Hàm tính toán đường biểu đồ để vẽ SVG.
 * Mục đích: đồng bộ đường line và vùng fill giống file mẫu.
 */
const useChartPath = () => {
  return useMemo(() => {
    const width = 480;
    const height = 180;
    const maxValue = Math.max(...chartData);
    const points = chartData.map((value, index) => [
      index * (width / (chartData.length - 1)),
      height - (value / maxValue) * height
    ]);

    const linePath = points
      .map((point, index) => `${index === 0 ? 'M' : 'L'}${point[0].toFixed(1)},${point[1].toFixed(1)}`)
      .join(' ');
    const areaPath = `${linePath} L${points[points.length - 1][0]},${height} L0,${height} Z`;

    return { linePath, areaPath, points };
  }, []);
};

/**
 * Hàm trang chủ.
 * Mục đích: hiển thị toàn bộ cấu trúc giao diện trang Home theo mẫu HTML.
 */
export default function HomePage() {
  const [isNavbarScrolled, setIsNavbarScrolled] = useState(false);
  const [isHeroReady, setIsHeroReady] = useState(false);
  const [visibleCards, setVisibleCards] = useState({
    steps: false,
    projects: false,
    why: false,
    stats: false,
    ranking: false
  });
  const [supportProjectList, setSupportProjectList] = useState<HomeSupportProject[]>([]);
  const [donatedAmountByProjectId, setDonatedAmountByProjectId] = useState<Record<string, number>>({});
  const [supportProjectCoverImageUrlById, setSupportProjectCoverImageUrlById] = useState<Record<string, string>>({});
  const [isSupportProjectsLoading, setIsSupportProjectsLoading] = useState(true);
  const [supportProjectsErrorMessage, setSupportProjectsErrorMessage] = useState('');
  const [isShowingAllSupportProjects, setIsShowingAllSupportProjects] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [isProjectDetailModalVisible, setIsProjectDetailModalVisible] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [isProjectDetailLoading, setIsProjectDetailLoading] = useState(false);
  const [projectDetailErrorMessage, setProjectDetailErrorMessage] = useState('');
  const [selectedProjectDetail, setSelectedProjectDetail] = useState<HomeSupportProjectDetail | null>(null);
  const [isDonationModalVisible, setIsDonationModalVisible] = useState(false);
  const [selectedDonationCampaignDetail, setSelectedDonationCampaignDetail] = useState<HomeDonationCampaignDetail | null>(null);
  const [donationAmountInput, setDonationAmountInput] = useState('');
  const [donationErrorMessage, setDonationErrorMessage] = useState('');
  const [donationSuccessMessage, setDonationSuccessMessage] = useState('');
  const [isDonationDataLoading, setIsDonationDataLoading] = useState(false);
  const [isDonationSubmitting, setIsDonationSubmitting] = useState(false);
  const [isDonationConfirmModalVisible, setIsDonationConfirmModalVisible] = useState(false);
  const [pendingDonationAmount, setPendingDonationAmount] = useState<number | null>(null);
  const [userTokenBalance, setUserTokenBalance] = useState(0);
  const [isLoginRequiredDialogVisible, setIsLoginRequiredDialogVisible] = useState(false);
  const [statValues, setStatValues] = useState(() => stats.map(() => 0));
  const [transactions, setTransactions] = useState<TransactionItem[]>([]);
  const [isLiveFeedLoading, setIsLiveFeedLoading] = useState(true);
  const [isLiveFeedConnected, setIsLiveFeedConnected] = useState(false);
  const [liveFeedErrorMessage, setLiveFeedErrorMessage] = useState('');
  const [hasClientMounted, setHasClientMounted] = useState(false);
  const [rankingItemList, setRankingItemList] = useState<RankingItem[]>([]);
  const [isRankingLoading, setIsRankingLoading] = useState(true);
  const [rankingErrorMessage, setRankingErrorMessage] = useState('');
  const [rankingCalculatedAtLabel, setRankingCalculatedAtLabel] = useState('');
  const [authenticatedUserName, setAuthenticatedUserName] = useState('');
  const [isUserMenuVisible, setIsUserMenuVisible] = useState(false);
  const userMenuContainerRef = useRef<HTMLDivElement | null>(null);
  const userMenuButtonRef = useRef<HTMLButtonElement | null>(null);
  const logoutMenuItemRef = useRef<HTMLButtonElement | null>(null);
  const projectDetailCacheRef = useRef<Map<string, HomeSupportProjectDetail | null>>(new Map());
  const userMenuId = 'headerUserMenu';
  const { linePath, areaPath, points } = useChartPath();

  useEffect(() => {
    const handleScroll = () => {
      setIsNavbarScrolled(window.scrollY > 10);
    };

    handleScroll();
    window.addEventListener('scroll', handleScroll);

    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  useEffect(() => {
    const timeout = window.setTimeout(() => setIsHeroReady(true), 500);
    return () => window.clearTimeout(timeout);
  }, []);

  useEffect(() => {
    setHasClientMounted(true);
  }, []);

  useEffect(() => {
    const observer = new IntersectionObserver(
      entries => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            const target = entry.target as HTMLElement;
            const group = target.dataset.group;
            if (group) {
              setVisibleCards(current => ({ ...current, [group]: true }));
            }
          }
        });
      },
      { threshold: 0.12 }
    );

    const elements = document.querySelectorAll('[data-observe]');
    elements.forEach(element => observer.observe(element));

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visibleCards.stats) {
      return;
    }

    const duration = 1800;
    const startTime = Date.now();

    const animate = () => {
      const elapsed = Date.now() - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);

      const nextValues = stats.map(stat => Math.floor(eased * stat.value));
      setStatValues(nextValues);

      if (progress < 1) {
        requestAnimationFrame(animate);
      }
    };

    requestAnimationFrame(animate);
  }, [visibleCards.stats]);

  /** Hàm tải snapshot live feed. Mục đích: lấy dữ liệu thật cho lần render đầu và cho fallback polling. */
  const loadLiveFeedTransactionList = useCallback(async () => {
    setIsLiveFeedLoading(true);
    setLiveFeedErrorMessage('');

    try {
      const liveFeedResponse = await fetchApi<LiveFeedApiTransactionItem[]>(buildApiUrl('/donations/live-feed?limit=6'), {
        method: 'GET',
        cache: 'no-store'
      });

      setTransactions(liveFeedResponse.data.map(mapLiveFeedApiTransactionToViewModel));
    } catch (error) {
      const fallbackErrorMessage = 'Không thể tải giao dịch thời gian thực. Vui lòng thử lại sau.';
      const normalizedErrorMessage = error instanceof Error ? error.message : fallbackErrorMessage;
      setLiveFeedErrorMessage(normalizedErrorMessage || fallbackErrorMessage);
      setTransactions([]);
    } finally {
      setIsLiveFeedLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadLiveFeedTransactionList();
  }, [loadLiveFeedTransactionList]);

  useEffect(() => {
    let reconnectTimeoutId: number | null = null;
    let fallbackPollingIntervalId: number | null = null;
    let isEffectDisposed = false;
    let liveFeedEventSource: EventSource | null = null;

    /** Hàm khởi tạo fallback polling. Mục đích: giữ live feed tiếp tục cập nhật khi SSE bị lỗi hoặc bị proxy chặn. */
    const startFallbackPolling = () => {
      if (fallbackPollingIntervalId) {
        return;
      }

      fallbackPollingIntervalId = window.setInterval(() => {
        void loadLiveFeedTransactionList();
      }, 30000);
    };

    /** Hàm dừng fallback polling. Mục đích: tránh gọi API trùng khi SSE đã hoạt động ổn định. */
    const stopFallbackPolling = () => {
      if (!fallbackPollingIntervalId) {
        return;
      }

      window.clearInterval(fallbackPollingIntervalId);
      fallbackPollingIntervalId = null;
    };

    /** Hàm kết nối SSE live feed. Mục đích: nhận snapshot giao dịch thật theo thời gian thực từ backend. */
    const connectLiveFeedStream = () => {
      if (isEffectDisposed) {
        return;
      }

      try {
        liveFeedEventSource = new EventSource(buildApiUrl('/donations/live-feed/stream?limit=6'));
      } catch {
        setIsLiveFeedConnected(false);
        startFallbackPolling();
        reconnectTimeoutId = window.setTimeout(connectLiveFeedStream, 5000);
        return;
      }

      liveFeedEventSource.addEventListener('live-feed', event => {
        const parsedData = JSON.parse(event.data) as LiveFeedApiTransactionItem[];

        // Ghi chú logic phức tạp: backend SSE luôn đẩy snapshot hoàn chỉnh, nên frontend chỉ cần replace state để tránh lệch thứ tự sự kiện.
        setTransactions(parsedData.map(mapLiveFeedApiTransactionToViewModel));
        setIsLiveFeedConnected(true);
        setIsLiveFeedLoading(false);
        setLiveFeedErrorMessage('');
        stopFallbackPolling();
      });

      liveFeedEventSource.addEventListener('heartbeat', () => {
        setIsLiveFeedConnected(false);
        startFallbackPolling();
      });

      liveFeedEventSource.onerror = () => {
        setIsLiveFeedConnected(false);
        startFallbackPolling();
        liveFeedEventSource?.close();
        liveFeedEventSource = null;

        if (!isEffectDisposed) {
          reconnectTimeoutId = window.setTimeout(connectLiveFeedStream, 5000);
        }
      };
    };

    connectLiveFeedStream();

    return () => {
      isEffectDisposed = true;
      stopFallbackPolling();

      if (reconnectTimeoutId) {
        window.clearTimeout(reconnectTimeoutId);
      }

      liveFeedEventSource?.close();
    };
  }, [loadLiveFeedTransactionList]);

  useEffect(() => {
    /**
     * Hàm đồng bộ trạng thái đăng nhập từ localStorage vào header trang chủ.
     * Mục đích: giữ đúng hiển thị sau refresh và sau khi đăng nhập Google.
     */
    const syncAuthenticatedUserName = () => {
      const authSession = readAuthSession();
      const hasAccessToken = Boolean(authSession.accessToken);

      // Ghi chú logic phức tạp: chỉ hiện tên người dùng khi đã có access token hợp lệ trong session.
      if (!hasAccessToken) {
        setAuthenticatedUserName('');
        setIsUserMenuVisible(false);
        return;
      }

      setAuthenticatedUserName(authSession.userFullName || 'Người dùng');
    };

    syncAuthenticatedUserName();
    window.addEventListener(authenticationSessionUpdatedEventName, syncAuthenticatedUserName);

    return () => {
      window.removeEventListener(authenticationSessionUpdatedEventName, syncAuthenticatedUserName);
    };
  }, []);

  /**
   * Hàm bật/tắt menu người dùng trên header.
   * Mục đích: hiển thị menu dropdown chứa hành động đăng xuất.
   */

  /** Hàm tải danh sách dự án hỗ trợ. Mục đích: cho phép lấy dữ liệu preview hoặc toàn bộ danh sách theo hành động người dùng. */
  const loadSupportProjectList = useCallback(async (shouldLoadAllProjects: boolean) => {
    setIsSupportProjectsLoading(true);
    setSupportProjectsErrorMessage('');

    try {
      const supportProjectApiPath = shouldLoadAllProjects ? '/projects/public-support?limit=12' : '/projects/public-support?limit=6';
      const supportProjectsResponse = await fetchApi<HomeSupportProject[]>(buildApiUrl(supportProjectApiPath), {
        method: 'GET',
        cache: 'no-store'
      });

      setSupportProjectList(supportProjectsResponse.data);
    } catch (error) {
      const fallbackErrorMessage = 'Không thể tải danh sách dự án cần hỗ trợ. Vui lòng thử lại sau.';
      const normalizedErrorMessage = error instanceof Error ? error.message : fallbackErrorMessage;
      console.error('Fetch support projects failed.', error);
      setSupportProjectsErrorMessage(normalizedErrorMessage || fallbackErrorMessage);
      setSupportProjectList([]);
    } finally {
      setIsSupportProjectsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSupportProjectList(false);
  }, [loadSupportProjectList]);

  /** Hàm tải tổng số tiền đã quyên góp theo dự án. Mục đích: bổ sung dữ liệu hiển thị cho card homepage mà không thay đổi nguồn dữ liệu chính hiện tại. */
  const loadDonatedAmountMap = useCallback(async () => {
    try {
      const donationCampaignResponse = await fetchApi<HomeDonationCampaignSummary[]>(buildApiUrl('/donations/campaigns?limit=12'), {
        method: 'GET',
        cache: 'no-store'
      });

      const nextDonatedAmountByProjectId = donationCampaignResponse.data.reduce<Record<string, number>>((projectAmountMap, campaignItem) => {
        projectAmountMap[campaignItem.projectId] = Number(campaignItem.donatedAmount || 0);
        return projectAmountMap;
      }, {});

      setDonatedAmountByProjectId(nextDonatedAmountByProjectId);
    } catch (error) {
      // Ghi chú logic phức tạp: đây là dữ liệu phụ cho UI nên nếu lỗi thì không làm hỏng luồng homepage hiện tại.
      console.error('Fetch donated amount map failed.', error);
      setDonatedAmountByProjectId({});
    }
  }, []);

  useEffect(() => {
    void loadDonatedAmountMap();
  }, [loadDonatedAmountMap]);

  useEffect(() => {
    let isCoverResolveCancelled = false;

    /** Hàm resolve ảnh bìa từ IPFS cho danh sách dự án. Mục đích: tìm CID ảnh đầu tiên thật sự trước khi set background card. */
    const resolveSupportProjectCoverImageUrls = async (): Promise<void> => {
      const coverImageEntryList = await Promise.all(
        supportProjectList.map(async projectItem => {
          const imageCid = await resolveFirstProjectImageCid(projectItem);
          return [projectItem.projectId, buildIpfsGatewayUrl(imageCid)] as const;
        })
      );

      if (isCoverResolveCancelled) {
        return;
      }

      setSupportProjectCoverImageUrlById(Object.fromEntries(coverImageEntryList));
    };

    if (supportProjectList.length === 0) {
      setSupportProjectCoverImageUrlById({});
      return;
    }

    resolveSupportProjectCoverImageUrls().catch(error => {
      console.error('Resolve support project cover image failed.', error);
      if (!isCoverResolveCancelled) {
        setSupportProjectCoverImageUrlById({});
      }
    });

    return () => {
      isCoverResolveCancelled = true;
    };
  }, [supportProjectList]);


  /** Hàm tải bảng xếp hạng QF. Mục đích: đồng bộ dữ liệu ranking từ backend để hiển thị realtime trên Home. */
  const loadRankingSnapshot = useCallback(async () => {
    setIsRankingLoading(true);
    setRankingErrorMessage('');

    try {
      const rankingResponse = await fetchApi<RankingSnapshotResponse>(buildApiUrl('/rankings?page=1&limit=10&sortBy=rankPosition&sortDirection=asc'), {
        method: 'GET',
        cache: 'no-store'
      });

      const rankingPayload = rankingResponse.data;
      setRankingItemList(rankingPayload.items || []);
      setRankingCalculatedAtLabel(rankingPayload.snapshot?.calculatedAt ? formatRankingCalculatedAt(rankingPayload.snapshot.calculatedAt) : '');
    } catch (error) {
      const fallbackErrorMessage = 'Không thể tải bảng xếp hạng QF. Vui lòng thử lại sau.';
      const normalizedErrorMessage = error instanceof Error ? error.message : fallbackErrorMessage;
      console.error('Fetch ranking snapshot failed.', error);
      setRankingErrorMessage(normalizedErrorMessage || fallbackErrorMessage);
      setRankingItemList([]);
      setRankingCalculatedAtLabel('');
    } finally {
      setIsRankingLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadRankingSnapshot();

    // Ghi chú logic phức tạp: polling theo chu kỳ giúp UI gần realtime nhưng vẫn kiểm soát số lượng request.
    const refreshIntervalId = window.setInterval(() => {
      void loadRankingSnapshot();
    }, 30000);

    return () => {
      window.clearInterval(refreshIntervalId);
    };
  }, [loadRankingSnapshot]);
  /** Hàm xử lý mở toàn bộ danh sách dự án hỗ trợ. Mục đích: chuyển từ chế độ preview sang hiển thị đầy đủ ngay trên Home. */
  const handleShowAllSupportProjects = async () => {
    // Ghi chú logic UI quan trọng: tránh bấm lặp khi đang tải để không tạo request chồng chéo.
    if (isSupportProjectsLoading || isShowingAllSupportProjects) {
      return;
    }

    setIsShowingAllSupportProjects(true);
    await loadSupportProjectList(true);
  };


  /** Hàm tải số dư token từ backend. Mục đích: phục vụ validate số token trước khi gửi giao dịch donate. */
  const loadUserTokenBalance = useCallback(async (): Promise<number> => {
    const authSession = readAuthSession();
    if (!authSession.accessToken) {
      setUserTokenBalance(0);
      return 0;
    }

    /** Hàm chuẩn hóa token balance từ nhiều kiểu payload sidebar. Mục đích: tương thích response có bọc `data` và response object trực tiếp. */
    const resolveTokenBalanceFromSidebarPayload = (sidebarPayload: unknown): number => {
      const payloadRecord = sidebarPayload as { tokenBalance?: number; data?: { tokenBalance?: number } };
      const resolvedTokenBalance = Number(payloadRecord?.data?.tokenBalance ?? payloadRecord?.tokenBalance ?? 0);
      return Number.isFinite(resolvedTokenBalance) ? resolvedTokenBalance : 0;
    };

    /** Hàm gọi 1 endpoint sidebar và trả token balance. Mục đích: tái sử dụng cho nhiều endpoint tương thích môi trường. */
    const loadTokenBalanceFromSingleEndpoint = async (endpointPath: string): Promise<number> => {
      const response = await fetch(buildApiUrl(endpointPath), {
        method: 'GET',
        headers: { Authorization: `Bearer ${authSession.accessToken}` },
        cache: 'no-store'
      });

      if (!response.ok) {
        throw new Error('Không thể tải số dư token.');
      }

      const responsePayload = (await response.json().catch(() => null)) as unknown;
      return resolveTokenBalanceFromSidebarPayload(responsePayload);
    };

    try {
      // Ghi chú logic phức tạp: ưu tiên endpoint đang được trang Deposit sử dụng thực tế.
      const normalizedTokenBalance = await loadTokenBalanceFromSingleEndpoint('/api/deposit/sidebar');
      setUserTokenBalance(normalizedTokenBalance);
      return normalizedTokenBalance;
    } catch (_primaryError) {
      try {
        const normalizedTokenBalance = await loadTokenBalanceFromSingleEndpoint('/deposits/sidebar');
        setUserTokenBalance(normalizedTokenBalance);
        return normalizedTokenBalance;
      } catch (_secondaryError) {
        try {
          const normalizedTokenBalance = await loadTokenBalanceFromSingleEndpoint('/deposit/sidebar');
          setUserTokenBalance(normalizedTokenBalance);
          return normalizedTokenBalance;
        } catch (_fallbackError) {
          setUserTokenBalance(0);
          return 0;
        }
      }
    }
  }, []);

  /** Hàm tải chi tiết campaign donate. Mục đích: hiển thị số đã quyên góp và kiểm tra điều kiện ACTIVE trước khi gửi giao dịch. */
  const loadDonationCampaignDetail = useCallback(async (projectId: string): Promise<HomeDonationCampaignDetail | null> => {
    const campaignResponse = await fetchApi<HomeDonationCampaignDetail | null>(buildApiUrl(`/donations/campaigns/${projectId}`), {
      method: 'GET',
      cache: 'no-store'
    });

    return campaignResponse.data;
  }, []);

  /** Hàm gửi donation qua relay backend. Mục đích: gửi giao dịch on-chain mà không cần MetaMask trên frontend. */
  const submitDonationViaRelay = useCallback(async (projectId: string, amount: number) => {
    const authSession = readAuthSession();
    if (!authSession.accessToken) {
      throw { statusCode: 401, message: 'Bạn chưa đăng nhập. Vui lòng đăng nhập để quyên góp.' };
    }

    const relayProjectId = resolveRelayProjectId(projectId);
    if (!relayProjectId) {
      throw { statusCode: 400, errorCode: 'VALIDATION_ERROR', message: 'Mã dự án không hợp lệ để gửi giao dịch.' };
    }

    return fetchApi<{ transactionHash: string }>(buildApiUrl('/donations/one-click'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${authSession.accessToken}` },
      body: JSON.stringify({ projectId: relayProjectId, amount, isAnonymous: false })
    });
  }, []);

  const handleToggleUserMenu = () => {
    setIsUserMenuVisible(currentState => !currentState);
  };

  /**
   * Hàm xử lý phím trên nút người dùng.
   * Mục đích: mở menu bằng Enter/Space để cải thiện truy cập bàn phím.
   */
  const handleUserMenuButtonKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') {
      return;
    }

    event.preventDefault();
    setIsUserMenuVisible(true);
  };

  /**
   * Kết thúc phiên từ menu người dùng sau khi hộp thoại xác nhận đã được chấp thuận.
   */
  const handleConfirmedHeaderUserLogout = (): void => {
    clearAuthSession();
    setAuthenticatedUserName('');
    setIsUserMenuVisible(false);
  };

  const { requestLogout, logoutConfirmationDialog } = useLogoutConfirmation(handleConfirmedHeaderUserLogout);

  /** Hàm đóng modal chi tiết dự án. Mục đích: reset trạng thái mở modal theo mọi cách đóng (nút, overlay, Escape). */
  const closeProjectDetailModal = () => {
    setIsProjectDetailModalVisible(false);
    setIsProjectDetailLoading(false);
    setProjectDetailErrorMessage('');
    setSelectedProjectId('');
  };

  /** Hàm đóng modal quyên góp Home. Mục đích: reset toàn bộ input và trạng thái giao dịch của luồng donate tại chỗ. */
  const closeDonationModal = () => {
    setIsDonationModalVisible(false);
    setIsDonationConfirmModalVisible(false);
    setPendingDonationAmount(null);
    setSelectedDonationCampaignDetail(null);
    setDonationAmountInput('');
    setDonationErrorMessage('');
    setDonationSuccessMessage('');
    setIsDonationDataLoading(false);
    setIsDonationSubmitting(false);
  };

  /** Hàm điều hướng đến trang đăng nhập. Mục đích: xử lý tập trung thao tác chuyển trang từ hộp thoại yêu cầu đăng nhập. */
  const redirectToLoginPage = () => {
    window.location.assign('/login');
  };

  /** Hàm đóng hộp thoại yêu cầu đăng nhập. Mục đích: cho phép người dùng ở lại Home mà không chuyển trang. */
  const closeLoginRequiredDialog = () => {
    setIsLoginRequiredDialogVisible(false);
  };

  /** Hàm mở modal donate tại Home. Mục đích: nạp dữ liệu campaign + số dư token mà không điều hướng route. */
  const handleOpenDonationModal = async (projectId: string, projectPreview?: HomeSupportProject) => {
    const authSession = readAuthSession();
    const hasAccessToken = Boolean(authSession.accessToken?.trim());

    // Ghi chú logic phức tạp: chặn toàn bộ flow donate khi chưa đăng nhập và hiển thị hộp thoại UI thay vì alert thô.
    if (!hasAccessToken) {
      setIsLoginRequiredDialogVisible(true);
      return;
    }

    const normalizedProjectId = projectId.trim();
    if (!normalizedProjectId) {
      return;
    }

    setIsDonationModalVisible(true);
    setDonationAmountInput('');
    setDonationErrorMessage('');
    setDonationSuccessMessage('');
    setIsDonationDataLoading(true);

    const fallbackProject =
      projectPreview || supportProjectList.find(projectItem => projectItem.projectId === normalizedProjectId) || null;

    if (fallbackProject) {
      setSelectedDonationCampaignDetail({
        projectId: fallbackProject.projectId,
        name: fallbackProject.name,
        description: fallbackProject.description,
        goalAmount: fallbackProject.goalAmount,
        donatedAmount: 0,
        donationCount: 0,
        status: fallbackProject.status
      });
    }

    try {
      await loadUserTokenBalance();

      const campaignDetail = await loadDonationCampaignDetail(normalizedProjectId);
      if (campaignDetail) {
        setSelectedDonationCampaignDetail(campaignDetail);
        return;
      }

      setDonationErrorMessage('Không tìm thấy dữ liệu campaign từ hệ thống.');
      if (!fallbackProject) {
        setSelectedDonationCampaignDetail(null);
      }
    } catch (error) {
      // Ghi chú logic phức tạp: vẫn hiển thị modal với fallback để không vỡ UX, nhưng luôn báo lỗi rõ ràng khi API trả lỗi.
      setDonationErrorMessage(mapDonationErrorMessage(error));
      if (!fallbackProject) {
        setSelectedDonationCampaignDetail(null);
      }
    } finally {
      setIsDonationDataLoading(false);
    }
  };

  /** Hàm mở modal và lấy chi tiết dự án. Mục đích: chỉ gọi API khi người dùng bấm nút “Chi tiết”. */
  const handleOpenProjectDetailModal = async (projectId: string) => {
    const normalizedProjectId = projectId.trim();
    if (!normalizedProjectId) {
      return;
    }

    setSelectedProjectId(normalizedProjectId);
    setIsProjectDetailModalVisible(true);
    setIsProjectDetailLoading(true);
    setProjectDetailErrorMessage('');
    setSelectedProjectDetail(null);

    if (projectDetailCacheRef.current.has(normalizedProjectId)) {
      const cachedProjectDetail = projectDetailCacheRef.current.get(normalizedProjectId) || null;
      setSelectedProjectDetail(cachedProjectDetail);
      setIsProjectDetailLoading(false);
      return;
    }

    try {
      const projectDetailResponse = await fetchApi<HomeSupportProjectDetail | null>(
        buildApiUrl(`/projects/public-support/${normalizedProjectId}`),
        {
          method: 'GET',
          cache: 'no-store'
        }
      );

      projectDetailCacheRef.current.set(normalizedProjectId, projectDetailResponse.data);
      setSelectedProjectDetail(projectDetailResponse.data);
    } catch (error) {
      const fallbackErrorMessage = 'Không thể tải chi tiết dự án. Vui lòng thử lại sau.';
      const normalizedErrorMessage = error instanceof Error ? error.message : fallbackErrorMessage;
      console.error('Fetch support project detail failed.', error);
      setProjectDetailErrorMessage(normalizedErrorMessage || fallbackErrorMessage);
      setSelectedProjectDetail(null);
    } finally {
      setIsProjectDetailLoading(false);
    }
  };

  useEffect(() => {
    /**
     * Hàm đóng menu khi người dùng click ra ngoài vùng menu.
     * Mục đích: đảm bảo dropdown hoạt động đúng UX phổ biến.
     */
    const handleClickOutsideUserMenu = (event: MouseEvent) => {
      // Ghi chú logic phức tạp: kiểm tra phần tử chứa để tránh đóng menu khi click bên trong.
      if (!userMenuContainerRef.current?.contains(event.target as Node)) {
        setIsUserMenuVisible(false);
      }
    };

    window.addEventListener('mousedown', handleClickOutsideUserMenu);
    return () => {
      window.removeEventListener('mousedown', handleClickOutsideUserMenu);
    };
  }, []);

  useEffect(() => {
    /**
     * Hàm xử lý bàn phím cho menu người dùng.
     * Mục đích: hỗ trợ phím Escape để đóng menu theo chuẩn truy cập cơ bản.
     */
    const handleEscapeForUserMenu = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }

      setIsUserMenuVisible(false);
      userMenuButtonRef.current?.focus();
    };

    window.addEventListener('keydown', handleEscapeForUserMenu);
    return () => {
      window.removeEventListener('keydown', handleEscapeForUserMenu);
    };
  }, []);

  useEffect(() => {
    // Ghi chú logic phức tạp: khi menu mở, đưa focus vào action chính để thao tác bàn phím nhanh và rõ ràng.
    if (isUserMenuVisible) {
      logoutMenuItemRef.current?.focus();
    }
  }, [isUserMenuVisible]);

  useEffect(() => {
    /** Hàm xử lý phím Escape cho modal chi tiết. Mục đích: đóng modal nhanh bằng bàn phím theo UX chuẩn. */
    const handleEscapeForProjectDetailModal = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !isProjectDetailModalVisible) {
        return;
      }

      closeProjectDetailModal();
    };

    window.addEventListener('keydown', handleEscapeForProjectDetailModal);
    return () => {
      window.removeEventListener('keydown', handleEscapeForProjectDetailModal);
    };
  }, [isProjectDetailModalVisible]);

  useEffect(() => {
    /** Hàm xử lý phím Escape cho modal quyên góp. Mục đích: đóng modal donate nhanh bằng bàn phím khi chưa gửi giao dịch. */
    const handleEscapeForDonationModal = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !isDonationModalVisible || isDonationSubmitting) {
        return;
      }

      closeDonationModal();
    };

    window.addEventListener('keydown', handleEscapeForDonationModal);
    return () => {
      window.removeEventListener('keydown', handleEscapeForDonationModal);
    };
  }, [isDonationModalVisible, isDonationSubmitting]);

  useEffect(() => {
    const handleEscapeForMobileMenu = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && isMobileMenuOpen) {
        setIsMobileMenuOpen(false);
      }
    };

    window.addEventListener('keydown', handleEscapeForMobileMenu);
    return () => {
      window.removeEventListener('keydown', handleEscapeForMobileMenu);
    };
  }, [isMobileMenuOpen]);

  /**
   * Hàm khóa overflow trên body khi menu mobile mở.
   * Mục đích: ngăn nền phía sau tiếp tục cuộn hoặc bị dịch chuyển khi drawer menu hiển thị trên mobile.
   */
  useEffect(() => {
    if (!isMobileMenuOpen) {
      document.body.style.overflow = '';
      return;
    }
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = '';
    };
  }, [isMobileMenuOpen]);

  /** Hàm kiểm tra dữ liệu donation trước khi mở xác nhận. Mục đích: gom validate để tái sử dụng cho nhiều bước submit. */
  const validateDonationInput = (): number | null => {
    const normalizedAmount = Number(donationAmountInput);
    if (!Number.isFinite(normalizedAmount) || normalizedAmount <= 0) {
      setDonationErrorMessage('Vui lòng nhập số token lớn hơn 0.');
      return null;
    }

    if (!selectedDonationCampaignDetail?.projectId) {
      setDonationErrorMessage('Không tìm thấy thông tin dự án để quyên góp.');
      return null;
    }

    if (!isCampaignEligibleForDonation(selectedDonationCampaignDetail)) {
      setDonationErrorMessage('Dự án hiện không đủ điều kiện nhận quyên góp.');
      return null;
    }

    if (normalizedAmount > userTokenBalance) {
      setDonationErrorMessage('Số token quyên góp vượt quá số dư hiện có của bạn.');
      return null;
    }

    return normalizedAmount;
  };

  /** Hàm mở modal xác nhận donation. Mục đích: đảm bảo người dùng chỉ xác nhận đúng 1 lần trước khi gửi giao dịch. */
  const handleOpenDonationConfirmModal = () => {
    const validatedAmount = validateDonationInput();
    if (validatedAmount === null) {
      return;
    }

    setPendingDonationAmount(validatedAmount);
    setIsDonationConfirmModalVisible(true);
  };

  /** Hàm đóng modal xác nhận donation. Mục đích: xóa trạng thái xác nhận tạm để tránh gửi nhầm dữ liệu cũ. */
  const handleCloseDonationConfirmModal = () => {
    setIsDonationConfirmModalVisible(false);
    setPendingDonationAmount(null);
  };

  /** Hàm gửi giao dịch donation sau khi xác nhận. Mục đích: submit đúng một lần qua relay backend và đồng bộ dữ liệu sau giao dịch. */
  const handleConfirmDonationSubmit = async () => {
    // Ghi chú logic phức tạp: chặn double-submit tuyệt đối khi người dùng bấm xác nhận liên tiếp.
    if (isDonationSubmitting) {
      return;
    }

    if (!selectedDonationCampaignDetail?.projectId || pendingDonationAmount === null) {
      setDonationErrorMessage('Không tìm thấy thông tin dự án để quyên góp.');
      handleCloseDonationConfirmModal();
      return;
    }

    setDonationErrorMessage('');
    setDonationSuccessMessage('');

    try {
      // Bước 1: flushSync force synchronous render isDonationSubmitting=true.
      // Đảm bảo React re-render sub-modal với text "Đang ghi nhận..." TRƯỚC khi đóng.
      flushSync(() => {
        setIsDonationSubmitting(true);
      });

      // Bước 2: setTimeout delay đủ lâu để trình duyệt paint loading state,
      // user NHÌN THẤY "Đang ghi nhận vào hệ thống..." trước khi modal đóng.
      window.setTimeout(() => {
        handleCloseDonationConfirmModal();
      }, 300);

      // Gọi API relay để gửi giao dịch quyên góp. Response không hiển thị cho user nên không cần lưu trữ.
      void submitDonationViaRelay(selectedDonationCampaignDetail.projectId, pendingDonationAmount);

      const refreshedCampaignDetailPromise = loadDonationCampaignDetail(selectedDonationCampaignDetail.projectId);
      const refreshedBalancePromise = loadUserTokenBalance();

      await Promise.all([
        loadSupportProjectList(isShowingAllSupportProjects),
        loadDonatedAmountMap(),
        refreshedCampaignDetailPromise,
        refreshedBalancePromise
      ]);

      const refreshedCampaignDetail = await refreshedCampaignDetailPromise;
      if (refreshedCampaignDetail) {
        setSelectedDonationCampaignDetail(refreshedCampaignDetail);
      }

      setDonationSuccessMessage('Quyên góp thành công! Cảm ơn bạn vì tấm lòng sẻ chia.');
      // Hiển thị message thành công trong 5 giây để người dùng kịp đọc trước khi đóng modal.
      window.setTimeout(() => {
        closeDonationModal();
      }, 3500);
    } catch (error) {
      setDonationErrorMessage(mapDonationErrorMessage(error));
    } finally {
      setIsDonationSubmitting(false);
    }
  };

  return (
    <main className="home-root">
      <nav id="navbar" className={isNavbarScrolled ? 'scrolled' : ''}>
        <a href="#" className="logo">
          <div className="logo-icon">
            <svg viewBox="0 0 24 24">
              <path d="M12 21.7C5.8 17.5 2 13.2 2 9a6 6 0 0112 0 6 6 0 0112 0c0 4.2-3.8 8.5-10 12.7z" />
            </svg>
          </div>
          <div>
            <span className="logo-text">DCP</span>
            <span className="logo-tag">Minh bạch tuyệt đối</span>
          </div>
        </a>
        <ul className="nav-links">
          <li>
            <a href="#projects">Dự án</a>
          </li>
          <li>
            <a href="#ranking">Bảng xếp hạng</a>
          </li>
          <li>
            <a href="#transparency">Minh bạch</a>
          </li>
          <li>
            <a href="#how">Cách hoạt động</a>
          </li>
        </ul>
        <div className="nav-actions">
          {authenticatedUserName ? (
            <div className="relative" ref={userMenuContainerRef}>
              <button
                ref={userMenuButtonRef}
                type="button"
                className="btn-ghost focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0e7c6b] focus-visible:ring-offset-2"
                aria-label="Mở menu người dùng"
                aria-haspopup="menu"
                aria-expanded={isUserMenuVisible}
                aria-controls={userMenuId}
                onClick={handleToggleUserMenu}
                onKeyDown={handleUserMenuButtonKeyDown}
              >
                <span aria-hidden="true">👤</span> {authenticatedUserName}
              </button>
              <div
                id={userMenuId}
                role="menu"
                aria-hidden={!isUserMenuVisible}
                className={`absolute right-0 top-[calc(100%+10px)] z-20 min-w-[170px] rounded-xl border border-[#e5e7eb] bg-white p-1.5 shadow-[0_12px_32px_rgba(13,17,23,0.14)] transition-all duration-150 ease-out ${isUserMenuVisible ? 'pointer-events-auto translate-y-0 opacity-100' : 'pointer-events-none -translate-y-1 opacity-0'
                  }`}
              >
                <button
                  ref={logoutMenuItemRef}
                  type="button"
                  role="menuitem"
                  className="flex min-h-[44px] w-full items-center justify-start rounded-lg px-3.5 py-2.5 text-sm font-semibold text-[#0d1117] transition-colors duration-150 hover:bg-[#f3f4f6] active:bg-[#e5e7eb] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0e7c6b]"
                  onClick={requestLogout}
                >
                  Đăng xuất
                </button>
              </div>
            </div>
          ) : (
            <a href="/login" className="btn-ghost">
              Đăng nhập
            </a>
          )}
          <a href="/deposit" className="btn-amber">
            💰 Nạp tiền
          </a>
          <button
            type="button"
            className={`mobile-hamburger${isMobileMenuOpen ? ' is-open' : ''}`}
            aria-label={isMobileMenuOpen ? 'Đóng menu' : 'Mở menu'}
            aria-expanded={isMobileMenuOpen}
            aria-controls="mobile-menu"
            onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
          >
            <svg
              className="mobile-hamburger-svg"
              viewBox="0 0 24 24"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              aria-hidden="true"
            >
              <g className="hamburger-bars">
                <path d="M4 7H20" stroke="white" strokeWidth="2.5" strokeLinecap="round" />
                <path d="M4 12H20" stroke="white" strokeWidth="2.5" strokeLinecap="round" />
                <path d="M4 17H20" stroke="white" strokeWidth="2.5" strokeLinecap="round" />
              </g>
              <g className="hamburger-close">
                <path d="M5 5L19 19" stroke="white" strokeWidth="2.5" strokeLinecap="round" />
                <path d="M19 5L5 19" stroke="white" strokeWidth="2.5" strokeLinecap="round" />
              </g>
            </svg>
          </button>
        </div>
      </nav>

      {isMobileMenuOpen && (
        <>
          <div
            className="mobile-menu-overlay"
            onClick={() => setIsMobileMenuOpen(false)}
            aria-hidden="true"
          />
          <div
            id="mobile-menu"
            className="mobile-menu-drawer"
            role="dialog"
            aria-modal="true"
            aria-label="Menu điều hướng"
          >
            <div className="mobile-menu-header">
              <span className="logo-text">DCP</span>
              <button
                type="button"
                className="mobile-menu-close"
                aria-label="Đóng menu"
                onClick={() => setIsMobileMenuOpen(false)}
              >
                <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
                  <path d="M2 2L16 16M16 2L2 16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </button>
            </div>
            <ul className="mobile-menu-links">
              <li>
                <a href="#projects" onClick={() => setIsMobileMenuOpen(false)}>
                  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                    <path d="M2 6C2 4.9 2.9 4 4 4H7L9 6H16C17.1 6 18 6.9 18 8V14C18 15.1 17.1 16 16 16H4C2.9 16 2 15.1 2 14V6Z" fill="#F59E0B" />
                    <path d="M2 8H18V14C18 15.1 17.1 16 16 16H4C2.9 16 2 15.1 2 14V8Z" fill="#FBBF24" />
                    <path d="M10 9V12M8.5 10.5H11.5" stroke="#FEFCE8" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                  Dự án
                </a>
              </li>
              <li>
                <a href="#ranking" onClick={() => setIsMobileMenuOpen(false)}>
                  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                    <rect x="2" y="12" width="5" height="6" rx="1.5" fill="#B45309" />
                    <rect x="7.5" y="8" width="5" height="10" rx="1.5" fill="#D97706" />
                    <rect x="13" y="5" width="5" height="13" rx="1.5" fill="#F59E0B" />
                    <circle cx="4.5" cy="9.5" r="1.5" fill="#FEFCE8" />
                    <circle cx="10" cy="5.5" r="1.5" fill="#FEFCE8" />
                    <circle cx="15.5" cy="2.5" r="1.5" fill="#FEFCE8" />
                    <path d="M10 2L10.4 3.3H11.7L10.5 4.1L10.9 5.4L10 4.6L9.1 5.4L9.5 4.1L8.3 3.3H9.6L10 2Z" fill="#FEFCE8" />
                  </svg>
                  Bảng xếp hạng
                </a>
              </li>
              <li>
                <a href="#transparency" onClick={() => setIsMobileMenuOpen(false)}>
                  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                    <path d="M10 2L17 5V10C17 13.5 14 16.5 10 18C6 16.5 3 13.5 3 10V5L10 2Z" fill="#0E7C6B" />
                    <path d="M10 2L17 5V10C17 13.5 14 16.5 10 18C6 16.5 3 13.5 3 10V5L10 2Z" stroke="#0D9488" strokeWidth="1.5" />
                    <path d="M7 10L9 12L13 8" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  Minh bạch
                </a>
              </li>
              <li>
                <a href="#how" onClick={() => setIsMobileMenuOpen(false)}>
                  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                    <circle cx="10" cy="10" r="3" stroke="#0E7C6B" strokeWidth="2" />
                    <path d="M10 2V4.5" stroke="#0E7C6B" strokeWidth="2" strokeLinecap="round" />
                    <path d="M10 15.5V18" stroke="#0E7C6B" strokeWidth="2" strokeLinecap="round" />
                    <path d="M2 10H4.5" stroke="#0E7C6B" strokeWidth="2" strokeLinecap="round" />
                    <path d="M15.5 10H18" stroke="#0E7C6B" strokeWidth="2" strokeLinecap="round" />
                    <path d="M4.2 4.2L5.8 5.8" stroke="#0D9488" strokeWidth="1.8" strokeLinecap="round" />
                    <path d="M14.2 14.2L15.8 15.8" stroke="#0D9488" strokeWidth="1.8" strokeLinecap="round" />
                    <path d="M15.8 4.2L14.2 5.8" stroke="#0D9488" strokeWidth="1.8" strokeLinecap="round" />
                    <path d="M5.8 14.2L4.2 15.8" stroke="#0D9488" strokeWidth="1.8" strokeLinecap="round" />
                  </svg>
                  Cách hoạt động
                </a>
              </li>
            </ul>
            <div className="mobile-menu-actions">
              {authenticatedUserName ? (
                <>
                  <div className="mobile-menu-user">
                    <div className="mobile-menu-avatar">
                      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                        <circle cx="10" cy="7" r="4" fill="#0E7C6B" />
                        <path d="M2 18C2 14.5 5.5 12 10 12C14.5 12 18 14.5 18 18" stroke="#0E7C6B" strokeWidth="2" strokeLinecap="round" />
                      </svg>
                    </div>
                    <div className="mobile-menu-user-info">
                      <span className="mobile-menu-user-name" title={authenticatedUserName}>
                        {authenticatedUserName.length > 14
                          ? authenticatedUserName.slice(0, 14) + '…'
                          : authenticatedUserName}
                      </span>
                      <span className="mobile-menu-user-badge">Đã đăng nhập</span>
                    </div>
                  </div>
                  <a href="/deposit" className="btn-amber" onClick={() => setIsMobileMenuOpen(false)}>
                    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
                      <path d="M2 5H16C16.55 5 17 5.45 17 6V14C17 14.55 16.55 15 16 15H2C1.45 15 1 14.55 1 14V6C1 5.45 1.45 5 2 5Z" fill="#059669" />
                      <path d="M2 5H16C16.55 5 17 5.45 17 6V9H1V6C1 5.45 1.45 5 2 5Z" fill="#10B981" />
                      <rect x="1" y="6" width="16" height="3" fill="#10B981" />
                      <circle cx="9" cy="12.5" r="3" fill="#34D399" />
                      <path d="M9 11V14M7.5 12.5H10.5" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
                    </svg>
                    Nạp tiền
                  </a>
                  <button
                    type="button"
                    className="mobile-menu-logout"
                    onClick={() => {
                      setIsMobileMenuOpen(false);
                      requestLogout();
                    }}
                  >
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <path d="M6 3H3C2.45 3 2 3.45 2 4V12C2 12.55 2.45 13 3 13H6" stroke="#DC2626" strokeWidth="1.5" strokeLinecap="round" />
                      <path d="M10 11L13 8L10 5" stroke="#DC2626" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      <path d="M13 8H5" stroke="#DC2626" strokeWidth="1.5" strokeLinecap="round" />
                    </svg>
                    Đăng xuất
                  </button>
                </>
              ) : (
                <>
                  <a href="/login" className="btn-ghost" onClick={() => setIsMobileMenuOpen(false)}>
                    Đăng nhập
                  </a>
                  <a href="/deposit" className="btn-amber" onClick={() => setIsMobileMenuOpen(false)}>
                    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
                      <path d="M2 5H16C16.55 5 17 5.45 17 6V14C17 14.55 16.55 15 16 15H2C1.45 15 1 14.55 1 14V6C1 5.45 1.45 5 2 5Z" fill="#059669" />
                      <path d="M2 5H16C16.55 5 17 5.45 17 6V9H1V6C1 5.45 1.45 5 2 5Z" fill="#10B981" />
                      <rect x="1" y="6" width="16" height="3" fill="#10B981" />
                      <circle cx="9" cy="12.5" r="3" fill="#34D399" />
                      <path d="M9 11V14M7.5 12.5H10.5" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
                    </svg>
                    Nạp tiền
                  </a>
                </>
              )}
            </div>
          </div>
        </>
      )}

      <section className="hero" id="home">
        <div className="hero-bg" />
        <div className="hero-pattern" />
        <div className="hero-hex" />

        <div className="hero-content">
          <div className="hero-badge">
            <span /> ⛓ Powered by Blockchain × PayOS
          </div>
          <h1>
            Quyên góp <em>minh bạch.</em>
            <br />
            Mọi đồng tiền
            <br />
            kiểm chứng được.
          </h1>
          <p className="hero-desc">
            Nền tảng từ thiện đầu tiên kết hợp Blockchain + PayOS tại Việt Nam. 100% giao dịch ghi nhận on-chain — không
            trung gian, không gian lận.
          </p>
          <div className="hero-actions">
            <a href="#projects" className="btn-primary">
              Khám phá dự án <span>→</span>
            </a>
            <a href="https://www.youtube.com/watch?v=I6lp2qo-18k" className="btn-play">
              <div className="play-circle">
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path d="M4 2.5l7 4.5-7 4.5V2.5z" fill="#0E7C6B" />
                </svg>
              </div>
              Xem cách quyên góp
            </a>
          </div>
        </div>

        <div className="hero-visual">
          <div className="hero-card-wrapper">
            <div className="floating-badges">
              <div className="f-badge-1">
                <div className="donor-stack">
                  <div className="donor-av" style={{ background: '#10B981' }}>
                    N
                  </div>
                  <div className="donor-av" style={{ background: '#3B82F6' }}>
                    T
                  </div>
                  <div className="donor-av" style={{ background: '#F59E0B' }}>
                    L
                  </div>
                </div>
                <span className="donor-count">+248 người đã ủng hộ</span>
              </div>
            </div>
            <div className="project-card-hero">
              <div className="card-img">
                <div className="card-img-overlay" />
                <div className="card-img-text">
                  🏫 Trường học vùng cao Hà Giang
                  <small>Tổ chức: Ánh Sáng Việt Nam ✓</small>
                </div>
                <div className="badge-verified">⛓ Xác minh on-chain</div>
              </div>
              <div className="card-body">
                <div className="card-org">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ color: '#0e7c6b', flexShrink: 0 }}>
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  Ánh Sáng Việt Nam
                </div>
                <div className="card-title">Xây dựng phòng học cho 120 em học sinh dân tộc thiểu số</div>
                <div className="progress-wrap">
                  <div className="progress-label">
                    <span className="progress-value">458,000,000₫</span>
                    <span className="progress-goal">
                      / 630,000,000₫ <strong>73%</strong>
                    </span>
                  </div>
                  <div className="progress-bar">
                    <div className="progress-fill" style={{ width: isHeroReady ? '73%' : '0%' }} />
                  </div>
                </div>
                <div className="card-stats">
                  <span>👥 248 donors</span>
                  <span>📅 12 ngày còn lại</span>
                  <span>⛓ 1,247 tx</span>
                </div>
              </div>
            </div>
            <div className="f-badge-2">🔒 Smart Contract bảo vệ</div>
          </div>
        </div>
      </section>

      <div className="trust-bar">
        <div className="trust-scroll">
          {[...trustItems, ...trustItems].map((item, index) => (
            <div className="trust-item" key={`${item.label}-${index}`}>
              {item.label} <strong>{item.value}</strong>
              <span className="trust-sep">·</span>
            </div>
          ))}
        </div>
      </div>

      <section className="how" id="how">
        <div className="how-header">
          <div className="section-label">Quy trình</div>
          <h2 className="section-title">Đơn giản — Minh bạch — Bảo mật</h2>
          <p className="section-sub">
            3 bước từ ví tiền của bạn đến tay người cần giúp đỡ, mọi bước đều ghi nhận on-chain
          </p>
        </div>
        <div className="how-steps">
          {[
            {
              icon: '💳',
              title: 'Nạp tiền VNĐ',
              href: '/deposit',
              description:
                'Chuyển khoản qua PayOS — hệ thống tự động mint Charity Token vào ví Smart Account của bạn. Tỷ lệ 1₫ = 1 Token.',
              delay: 0
            },
            {
              icon: '🎯',
              title: 'Chọn & Quyên góp',
              href: '/#projects',
              description:
                'Duyệt danh sách dự án được xếp hạng bằng Quadratic Funding, quyên góp Token — giao dịch ghi nhận ngay lên Blockchain.',
              delay: 0.15
            },
            {
              icon: '🔍',
              title: 'Theo dõi Minh bạch',
              href: '/#projects',
              description:
                'Xem lịch sử toàn bộ on-chain bất kỳ lúc nào. Giải ngân cần 2/3 admin ký trên Smart Contract — không ai có thể tự ý sử dụng.',
              delay: 0.3
            }
          ].map((step, index) => (
            <div
              className={`step ${visibleCards.steps ? 'visible' : ''}`}
              key={step.title}
              style={{ transitionDelay: `${step.delay}s` }}
              data-observe
              data-group="steps"
            >
              <div className="step-icon-wrapper">
                <a href={step.href} aria-label={step.title} className="block">
                  <div className="step-icon">
                    <span>{step.icon}</span>
                  </div>
                </a>
                <div className="step-num">{index + 1}</div>
              </div>
              <h3>{step.title}</h3>
              <p>{step.description}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="projects" id="projects">
        <div className="projects-header">
          <div>
            <div className="section-label">Dự án</div>
            <h2 className="section-title">Đang cần hỗ trợ</h2>
          </div>
        </div>
        <div className="projects-grid">
          {isSupportProjectsLoading && (
            <div className="pcard visible" data-observe data-group="projects">
              <div className="pcard-body">
                <div className="pcard-title">Đang tải dữ liệu dự án...</div>
                <div className="pcard-desc">Hệ thống đang lấy dữ liệu thật từ server.</div>
              </div>
            </div>
          )}

          {!isSupportProjectsLoading && supportProjectsErrorMessage && (
            <div className="pcard visible" data-observe data-group="projects">
              <div className="pcard-body">
                <div className="pcard-title">Không thể tải danh sách dự án</div>
                <div className="pcard-desc">{supportProjectsErrorMessage}</div>
              </div>
            </div>
          )}

          {!isSupportProjectsLoading && !supportProjectsErrorMessage && supportProjectList.length === 0 && (
            <div className="pcard visible" data-observe data-group="projects">
              <div className="pcard-body">
                <div className="pcard-title">Chưa có dự án cần hỗ trợ</div>
                <div className="pcard-desc">Hiện tại chưa có dự án đang hoạt động để hiển thị.</div>
              </div>
            </div>
          )}

          {!isSupportProjectsLoading &&
            !supportProjectsErrorMessage &&
            supportProjectList.map((project, projectIndex) => {
              const projectVisual = getProjectVisualByIndex(projectIndex);
              const projectCoverImageUrl = supportProjectCoverImageUrlById[project.projectId] || '';
              const donatedAmount = donatedAmountByProjectId[project.projectId] ?? 0;
              const isDonationAvailable = isSupportProjectDonationAvailable(project);
              const projectCoverStyle = projectCoverImageUrl
                ? { backgroundImage: `linear-gradient(rgba(15, 23, 42, 0.08), rgba(15, 23, 42, 0.18)), url(${projectCoverImageUrl})` }
                : { background: projectVisual.background };
              return (
                <Link
                  href={`/donations/${project.projectId}`}
                  className="pcard visible"
                  key={project.projectId}
                  style={{ transitionDelay: `${projectIndex * 0.1}s` }}
                  data-observe
                  data-group="projects"
                >
                  <div className="pcard-img">
                    <div className={`pcard-img-bg ${projectCoverImageUrl ? 'pcard-img-bg-cover' : ''}`} style={projectCoverStyle}>
                      {projectCoverImageUrl ? null : projectVisual.icon}
                    </div>
                    <div className="pcard-status status-active">● {getPublicProjectStatusLabel(project.status)}</div>
                  </div>
                  <div className="pcard-body">
                    <div className="pcard-org">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ color: '#0e7c6b', flexShrink: 0 }}>
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                      Dự án đã xác minh
                    </div>
                    <div className="pcard-title">{project.name}</div>
                    <div className="pcard-desc">{project.description}</div>
                    <div className="progress-wrap">
                      <div className="progress-label">
                        <span className="progress-value font-bold">Mục tiêu {formatCurrencyVnd(project.goalAmount)}VND</span>
                        <span>Cập nhật {formatUpdatedTime(project.updatedAt)}</span>
                      </div>
                      <div className="progress-bar mt-1">
                        <div
                          className="progress-fill"
                          style={{ width: `${Math.min((donatedAmount / project.goalAmount) * 100, 100)}%` }}
                        />
                      </div>
                    </div>
                    <div className="pcard-meta justify-between">
                      <span className="text-[#334155]">Đã quyên góp: {formatCurrencyVnd(donatedAmount)} VND</span>
                    </div>
                  </div>
                </Link>
              );
            })}
        </div>
        <div className="projects-footer">
          {!isShowingAllSupportProjects ? (
            <button
              type="button"
              className="btn-ghost btn-ghost-large"
              onClick={() => void handleShowAllSupportProjects()}
              disabled={isSupportProjectsLoading}
            >
              {isSupportProjectsLoading ? 'Đang tải danh sách dự án...' : 'Xem tất cả dự án →'}
            </button>
          ) : (
            <span className="btn-ghost btn-ghost-large" aria-live="polite">
              Đang hiển thị toàn bộ dự án
            </span>
          )}
        </div>
      </section>

      {isLoginRequiredDialogVisible && (
        <div className="fixed inset-0 z-[130] flex items-center justify-center bg-[#0f172a]/55 p-4 backdrop-blur-[3px]" role="presentation" onClick={closeLoginRequiredDialog}>
          <div
            className="w-full max-w-md overflow-hidden rounded-2xl border border-[#b7e4d6] bg-white shadow-[0_28px_70px_rgba(14,124,107,0.24)]"
            role="dialog"
            aria-modal="true"
            aria-labelledby="login-required-dialog-title"
            onClick={event => event.stopPropagation()}
          >
            <div className="bg-gradient-to-r from-[#0e7c6b] via-[#10b981] to-[#34d399] px-5 py-4 text-white">
              <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[#d1fae5]">Yêu cầu đăng nhập</p>
              <h3 id="login-required-dialog-title" className="mt-1 text-lg font-bold">
                Vui lòng đăng nhập để tiếp tục quyên góp
              </h3>
            </div>

            <div className="space-y-3 px-5 py-4">
              <p className="text-sm leading-6 text-[#334155]">
                Bạn cần đăng nhập trước khi thực hiện giao dịch quyên góp để hệ thống ghi nhận đúng số dư và lịch sử đóng góp.
              </p>
              <div className="rounded-lg border border-[#bbf7d0] bg-[#f0fdf4] p-3 text-xs text-[#166534]">
                Sau khi đăng nhập thành công, bạn quay lại Home và bấm <span className="font-semibold">💛 Quyên góp ngay</span> để tiếp tục.
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-[#d1fae5] bg-[#f0fdf4] px-5 py-3">
              <button
                type="button"
                className="inline-flex h-10 items-center justify-center rounded-lg border border-[#a7f3d0] px-4 text-sm font-semibold text-[#065f46] transition hover:bg-white"
                onClick={closeLoginRequiredDialog}
              >
                Ở lại trang
              </button>
              <button
                type="button"
                className="inline-flex h-10 items-center justify-center rounded-lg bg-gradient-to-r from-[#0e7c6b] to-[#10b981] px-4 text-sm font-semibold text-white transition hover:opacity-95"
                onClick={redirectToLoginPage}
              >
                Đến trang đăng nhập
              </button>
            </div>
          </div>
        </div>
      )}

      {isDonationModalVisible && (
        <div
          className="fixed inset-0 z-[125] flex items-center justify-center bg-black/50 p-3 backdrop-blur-[2px] md:p-5"
          role="presentation"
          onClick={() => {
            if (!isDonationSubmitting) {
              closeDonationModal();
            }
          }}
        >
          <div
            className="w-full max-w-xl rounded-2xl border border-[#d1e7e2] bg-white shadow-[0_28px_70px_rgba(14,124,107,0.2)]"
            role="dialog"
            aria-modal="true"
            aria-labelledby="home-donation-modal-title"
            onClick={event => event.stopPropagation()}
          >
            <div className="border-b border-[#e6f3f0] px-4 py-3 md:px-5 md:py-4">
              <h3 id="home-donation-modal-title" className="text-lg font-bold text-[#0d1117]">
                Quyên góp ngay tại Home
              </h3>
              <p className="mt-1 text-sm text-[#4b5563]">Hoàn tất giao dịch mà không rời khỏi trang hiện tại.</p>
            </div>

            <div className="space-y-3 px-4 py-3 md:px-5 md:py-4">
              {isDonationDataLoading && <p className="text-sm text-[#4b5563]">Đang tải dữ liệu quyên góp...</p>}

              {!isDonationDataLoading && selectedDonationCampaignDetail && (
                <>
                  <div className="rounded-lg border border-[#e5e7eb] bg-[#f8fafc] p-3">
                    <p className="text-xs text-[#6b7280]">Dự án</p>
                    <p className="mt-1 text-sm font-semibold text-[#111827]">{selectedDonationCampaignDetail.name}</p>
                    <p className="mt-2 text-xs text-[#6b7280]">
                      Tổng tiền quyên góp đến hiện tại: {Number(selectedDonationCampaignDetail.donatedAmount || 0).toLocaleString('vi-VN')} token · Số lượt quyên góp:{' '}
                      {Number(selectedDonationCampaignDetail.donationCount || 0).toLocaleString('vi-VN')}
                    </p>
                    <p className="mt-1 text-xs text-[#6b7280]">Số dư của bạn: {Number(userTokenBalance).toLocaleString('vi-VN')} token</p>
                  </div>

                  {!isCampaignEligibleForDonation(selectedDonationCampaignDetail) && (
                    <p className="rounded-lg border border-[#fde68a] bg-[#fffbeb] p-3 text-sm text-[#92400e]">
                      Dự án đã quá thời hạn quyên góp nên chức năng quyên góp hiện không khả dụng.
                    </p>
                  )}

                  {isCampaignEligibleForDonation(selectedDonationCampaignDetail) && (
                    <div>
                      <label htmlFor="homeDonationAmountInput" className="text-sm font-semibold text-[#111827]">
                        Số token muốn quyên góp
                      </label>
                      <input
                        id="homeDonationAmountInput"
                        className="mt-2 w-full rounded-lg border border-[#d1d5db] px-3 py-2 text-sm text-[#111827] outline-none focus:border-[#0e7c6b] focus:ring-2 focus:ring-[#0e7c6b]/20"
                        type="number"
                        min={1}
                        step={1}
                        inputMode="numeric"
                        value={donationAmountInput}
                        onChange={event => setDonationAmountInput(event.target.value)}
                        disabled={isDonationSubmitting}
                        placeholder="Ví dụ: 100"
                      />
                    </div>
                  )}
                </>
              )}

              {!isDonationDataLoading && !selectedDonationCampaignDetail && !donationErrorMessage && (
                <p className="rounded-lg border border-[#e5e7eb] bg-[#f8fafc] p-3 text-sm text-[#4b5563]">Không có dữ liệu campaign để quyên góp.</p>
              )}

              {donationErrorMessage && <p className="rounded-lg border border-[#fecaca] bg-[#fff1f2] p-3 text-sm text-[#b91c1c]">{donationErrorMessage}</p>}
              {donationSuccessMessage && <p className="rounded-lg border border-[#bbf7d0] bg-[#f0fdf4] p-3 text-sm text-[#166534]">{donationSuccessMessage}</p>}
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-[#e6f3f0] px-4 py-3 md:px-5">
              <button
                type="button"
                className="inline-flex h-10 items-center justify-center rounded-lg border border-[#d1d5db] px-4 text-sm font-semibold text-[#374151] transition hover:bg-[#f9fafb] disabled:cursor-not-allowed disabled:opacity-50"
                onClick={closeDonationModal}
                disabled={isDonationSubmitting}
              >
                Hủy
              </button>
              <button
                type="button"
                className="inline-flex h-10 items-center justify-center rounded-lg bg-[#0e7c6b] px-4 text-sm font-semibold text-white transition hover:bg-[#0b6759] disabled:cursor-not-allowed disabled:opacity-50"
                onClick={handleOpenDonationConfirmModal}
                disabled={isDonationSubmitting || isDonationDataLoading || !selectedDonationCampaignDetail || !isCampaignEligibleForDonation(selectedDonationCampaignDetail)}
              >
                Quyên góp
              </button>
            </div>

            {isDonationConfirmModalVisible && (
              <div
                className="fixed inset-0 z-[126] flex items-center justify-center bg-black/45 p-3 backdrop-blur-[1px] md:p-5"
                role="presentation"
                onClick={() => {
                  if (!isDonationSubmitting) {
                    handleCloseDonationConfirmModal();
                  }
                }}
              >
                <div
                  className="w-full max-w-md rounded-xl border border-[#d1e7e2] bg-white shadow-[0_20px_50px_rgba(14,124,107,0.2)]"
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="home-donation-confirm-modal-title"
                  onClick={event => event.stopPropagation()}
                >
                  <div className="border-b border-[#e6f3f0] px-4 py-3">
                    <h4 id="home-donation-confirm-modal-title" className="text-base font-bold text-[#0d1117]">
                      Xác nhận quyên góp
                    </h4>
                  </div>

                  <div className="px-4 py-4">
                    <p className="text-sm text-[#374151]">
                      Bạn muốn quyên góp {Number(pendingDonationAmount || 0).toLocaleString('vi-VN')} token cho dự án này?
                    </p>
                  </div>

                  <div className="flex items-center justify-end gap-2 border-t border-[#e6f3f0] px-4 py-3">
                    {isDonationSubmitting ? null : (
                      <button
                        type="button"
                        className="inline-flex h-10 items-center justify-center rounded-lg border border-[#d1d5db] px-4 text-sm font-semibold text-[#374151] transition hover:bg-[#f9fafb]"
                        onClick={handleCloseDonationConfirmModal}
                      >
                        Hủy
                      </button>
                    )}
                    <button
                      type="button"
                      className="inline-flex h-10 items-center justify-center rounded-lg bg-[#0e7c6b] px-4 text-sm font-semibold text-white transition hover:bg-[#0b6759] disabled:cursor-not-allowed disabled:opacity-50"
                      onClick={() => void handleConfirmDonationSubmit()}
                      disabled={isDonationSubmitting}
                    >
                      {isDonationSubmitting ? 'Đang ghi nhận vào hệ thống...' : 'Xác nhận'}
                    </button>
                  </div>
                </div>
              </div>
            )}

          </div>
        </div>
      )}

      {isProjectDetailModalVisible && (
        <div
          className="fixed inset-0 z-[120] flex items-center justify-center bg-black/45 p-3 backdrop-blur-[2px] md:p-5"
          role="presentation"
          onClick={closeProjectDetailModal}
        >
          <div
            className="flex max-h-[calc(100vh-1.5rem)] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-[#d1e7e2] bg-white shadow-[0_28px_70px_rgba(14,124,107,0.2)] md:max-h-[calc(100vh-2.5rem)]"
            role="dialog"
            aria-modal="true"
            aria-labelledby="project-detail-modal-title"
            onClick={event => event.stopPropagation()}
          >
            <div className="flex items-start justify-between border-b border-[#e6f3f0] px-4 py-3 md:px-5 md:py-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[#0e7c6b]">Thông tin công khai</p>
                <h3 id="project-detail-modal-title" className="mt-1 text-lg font-bold text-[#0d1117] md:text-xl">
                  Chi tiết dự án
                </h3>
              </div>
              <button
                type="button"
                className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-[#d7ebe7] text-base font-semibold text-[#0e7c6b] transition hover:bg-[#f1faf8]"
                onClick={closeProjectDetailModal}
                aria-label="Đóng hộp thoại chi tiết dự án"
              >
                ✕
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-4 py-3 md:px-5 md:py-4">
              {isProjectDetailLoading && (
                <div className="rounded-xl border border-[#e5e7eb] bg-[#f8fafc] p-5 text-center" aria-live="polite">
                  <div className="project-detail-modal-spinner mx-auto" aria-hidden="true" />
                  <p className="mt-3 text-sm font-medium text-[#4b5563]">Đang tải chi tiết dự án...</p>
                </div>
              )}

              {!isProjectDetailLoading && projectDetailErrorMessage && (
                <div className="rounded-xl border border-[#fecaca] bg-[#fff1f2] p-4" role="alert">
                  <p className="text-sm font-medium text-[#b91c1c]">{projectDetailErrorMessage}</p>
                </div>
              )}

              {!isProjectDetailLoading && !projectDetailErrorMessage && !selectedProjectDetail && (
                <div className="rounded-xl border border-[#e5e7eb] bg-[#f8fafc] p-4">
                  <p className="text-sm text-[#4b5563]">Không tìm thấy dữ liệu chi tiết cho dự án {selectedProjectId}.</p>
                </div>
              )}

              {!isProjectDetailLoading && !projectDetailErrorMessage && selectedProjectDetail && (
                <div className="grid gap-3 lg:grid-cols-[1.5fr_1fr] lg:gap-4">
                  <section className="rounded-xl border border-[#e3efec] bg-[#fbfefd] p-3 md:p-4">
                    <h4 className="mb-3 text-sm font-semibold text-[#0e7c6b]">Thông tin chính</h4>
                    <div className="grid grid-cols-2 gap-2.5">
                      <div className="rounded-lg bg-white p-2.5">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.04em] text-[#6b7280]">Tên dự án</p>
                        <p className="mt-1 text-sm font-semibold text-[#111827]">{selectedProjectDetail.name}</p>
                      </div>
                      <div className="rounded-lg bg-white p-2.5">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.04em] text-[#6b7280]">Trạng thái</p>
                        <p className="mt-1 text-sm font-semibold text-[#111827]">{getPublicProjectStatusLabel(selectedProjectDetail.status)}</p>
                      </div>
                      <div className="rounded-lg bg-white p-2.5">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.04em] text-[#6b7280]">Mục tiêu</p>
                        <p className="mt-1 text-sm font-semibold text-[#111827]">{formatCurrencyVnd(selectedProjectDetail.goalAmount)}₫</p>
                      </div>
                      <div className="rounded-lg bg-white p-2.5">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.04em] text-[#6b7280]">Quyên góp gần nhất</p>
                        <p className="mt-1 text-sm font-semibold text-[#111827]">
                          {selectedProjectDetail.lastDonationAt
                            ? formatUpdatedTime(selectedProjectDetail.lastDonationAt)
                            : 'Chưa có donation'}
                        </p>
                      </div>
                      {selectedProjectDetail.creatorName && (
                        <div className="rounded-lg bg-white p-2.5">
                          <p className="text-[11px] font-semibold uppercase tracking-[0.04em] text-[#6b7280]">Người tạo dự án</p>
                          <p className="mt-1 text-sm font-semibold text-[#111827]">{selectedProjectDetail.creatorName}</p>
                        </div>
                      )}
                    </div>
                    <div className="mt-3 rounded-lg border border-[#e5e7eb] bg-white p-3">
                      <h5 className="text-sm font-semibold text-[#0e7c6b]">Mô tả dự án</h5>
                      <p className="mt-1.5 text-sm leading-5 text-[#374151] whitespace-pre-line">
                        {selectedProjectDetail.description}
                      </p>
                      <div className="mt-3 flex flex-col gap-2 border-t border-[#eef2f7] pt-3">
                        <a
                          href={`/donors?projectId=${encodeURIComponent(selectedProjectDetail.projectId)}`}
                          className="inline-flex items-center text-sm font-semibold text-[#0e7c6b] transition hover:text-[#0b6759] hover:underline"
                        >
                          Xem danh sách nhà hảo tâm đã quyên góp →
                        </a>
                        <a
                          href={`/disbursements?projectId=${encodeURIComponent(selectedProjectDetail.projectId)}`}
                          className="inline-flex items-center text-sm font-semibold text-[#0e7c6b] transition hover:text-[#0b6759] hover:underline"
                        >
                          Xem toàn bộ quá trình giải ngân →
                        </a>
                      </div>
                    </div>
                  </section>

                  <section className="rounded-xl border border-[#e3efec] bg-[#fbfefd] p-3 md:p-4">
                    <div className="mb-2 flex items-center justify-between">
                      <h4 className="text-sm font-semibold text-[#0e7c6b]">Bằng chứng IPFS</h4>
                      <span className="rounded-full bg-[#e6f7f4] px-2 py-0.5 text-xs font-semibold text-[#0e7c6b]">
                        {selectedProjectDetail.evidenceCids.length}
                      </span>
                    </div>
                    {selectedProjectDetail.evidenceCids.length === 0 ? (
                      <p className="rounded-lg border border-dashed border-[#d1d5db] bg-white p-3 text-sm text-[#6b7280]">Chưa có bằng chứng IPFS.</p>
                    ) : (
                      <div className="grid gap-3 sm:grid-cols-2">
                        {selectedProjectDetail.evidenceCids.slice(0, 4).map((evidenceCid, evidenceIndex) => {
                          const evidenceFileItem = selectedProjectDetail.evidenceFiles?.find(fileItem => fileItem.cid === evidenceCid);

                          return (
                            <IpfsEvidencePreviewCard
                              key={`${selectedProjectDetail.projectId}-${evidenceCid}-${evidenceIndex}`}
                              cid={evidenceCid}
                              fileName={evidenceFileItem?.fileName || `Bằng chứng #${evidenceIndex + 1}`}
                              mimeType={evidenceFileItem?.mimeType}
                              compact
                            />
                          );
                        })}
                      </div>
                    )}
                    {selectedProjectDetail.evidenceCids.length > 4 && (
                      <p className="mt-2 text-xs text-[#6b7280]">+{selectedProjectDetail.evidenceCids.length - 4} CID khác.</p>
                    )}
                  </section>
                </div>
              )}
            </div>

            <div className="flex justify-end border-t border-[#e6f3f0] px-4 py-3 md:px-5 md:py-3.5">
              <button
                type="button"
                className="inline-flex h-9 items-center justify-center rounded-lg bg-[#0e7c6b] px-4 text-sm font-semibold text-white transition hover:bg-[#0b6759]"
                onClick={closeProjectDetailModal}
              >
                Đóng
              </button>
            </div>
          </div>
        </div>
      )}


      <section className="transparency" id="transparency">
        <div className="trans-header">
          <div className="section-label">Minh bạch</div>
          <h2 className="section-title">Giao dịch thời gian thực</h2>
          <p className="section-sub">Mọi giao dịch đều công khai và kiểm chứng được trên Blockchain</p>
        </div>
        <div className="trans-grid">
          <div className="live-feed-wrap">
            <div className="live-header">
              <h3 className="live-title">Live Feed</h3>
              <div className="live-label">
                <span className="live-dot" /> {hasClientMounted && isLiveFeedConnected ? 'Đang cập nhật realtime' : 'Đang đồng bộ dữ liệu thật'}
              </div>
            </div>
            <div className="tx-list">
              {!hasClientMounted ? (
                <div className="tx-item">
                  <div className="tx-info">
                    <div className="tx-hash">Đang tải giao dịch thật...</div>
                    <div className="tx-project">Hệ thống đang chuẩn bị đồng bộ live feed.</div>
                  </div>
                </div>
              ) : isLiveFeedLoading ? (
                <div className="tx-item">
                  <div className="tx-info">
                    <div className="tx-hash">Đang tải giao dịch thật...</div>
                    <div className="tx-project">Hệ thống đang đồng bộ dữ liệu on-chain mới nhất.</div>
                  </div>
                </div>
              ) : liveFeedErrorMessage ? (
                <div className="tx-item">
                  <div className="tx-info">
                    <div className="tx-hash">Chưa thể tải live feed</div>
                    <div className="tx-project">{liveFeedErrorMessage}</div>
                  </div>
                </div>
              ) : transactions.length === 0 ? (
                <div className="tx-item">
                  <div className="tx-info">
                    <div className="tx-hash">Chưa có giao dịch</div>
                    <div className="tx-project">Live Feed sẽ tự động hiển thị khi có dữ liệu thật từ hệ thống.</div>
                  </div>
                </div>
              ) : (
                transactions.map(transaction => (
                  <div className="tx-item" key={transaction.id}>
                    <div className={`tx-dot ${transaction.type}`} />
                    <div className="tx-info">
                      <div className="tx-hash">{transaction.displayName}</div>
                      <div className="tx-project">{transaction.project}</div>
                    </div>
                    <div>
                      <div className="tx-amount" style={transaction.amountColor ? { color: transaction.amountColor } : {}}>
                        {transaction.amount}
                      </div>
                      <div className="tx-time">{transaction.time}</div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="chart-wrap">
            <div className="chart-title">Tổng quyên góp 30 ngày</div>
            <div className="chart-sub">Đơn vị: triệu VNĐ</div>
            <svg className="chart-svg" viewBox="0 0 480 200" preserveAspectRatio="none">
              <defs>
                <linearGradient id="chartGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#0E7C6B" stopOpacity=".25" />
                  <stop offset="100%" stopColor="#0E7C6B" stopOpacity="0" />
                </linearGradient>
              </defs>
              <line x1="0" y1="40" x2="480" y2="40" stroke="#E6F7F4" strokeWidth="1" />
              <line x1="0" y1="80" x2="480" y2="80" stroke="#E6F7F4" strokeWidth="1" />
              <line x1="0" y1="120" x2="480" y2="120" stroke="#E6F7F4" strokeWidth="1" />
              <line x1="0" y1="160" x2="480" y2="160" stroke="#E6F7F4" strokeWidth="1" />
              <path id="chartArea" fill="url(#chartGrad)" d={areaPath} />
              <path
                id="chartLine"
                fill="none"
                stroke="#0E7C6B"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                d={linePath}
              />
              <g id="chartDots">
                {points.map((point, index) => {
                  if (index % 5 !== 0 && index !== points.length - 1) {
                    return null;
                  }

                  return (
                    <circle
                      key={`${point[0]}-${point[1]}`}
                      cx={point[0]}
                      cy={point[1]}
                      r={4}
                      fill="#0E7C6B"
                      stroke="white"
                      strokeWidth={2}
                    />
                  );
                })}
              </g>
              <text x="0" y="195" fontSize="10" fill="#9CA3AF" fontFamily="Lexend">
                1/2
              </text>
              <text x="60" y="195" fontSize="10" fill="#9CA3AF" fontFamily="Lexend">
                5/2
              </text>
              <text x="120" y="195" fontSize="10" fill="#9CA3AF" fontFamily="Lexend">
                10/2
              </text>
              <text x="180" y="195" fontSize="10" fill="#9CA3AF" fontFamily="Lexend">
                15/2
              </text>
              <text x="240" y="195" fontSize="10" fill="#9CA3AF" fontFamily="Lexend">
                20/2
              </text>
              <text x="300" y="195" fontSize="10" fill="#9CA3AF" fontFamily="Lexend">
                24/2
              </text>
              <text x="360" y="195" fontSize="10" fill="#9CA3AF" fontFamily="Lexend">
                27/2
              </text>
              <text x="430" y="195" fontSize="10" fill="#9CA3AF" fontFamily="Lexend">
                1/3
              </text>
            </svg>
            <div className="chart-footer">
              <div className="chart-legend">
                <span className="chart-line" />Quyên góp
              </div>
              <div className="chart-total">Tổng 30 ngày: 847,500,000₫</div>
            </div>
          </div>
        </div>
      </section>

      <section className="why">
        <div className="why-header">
          <div className="section-label">Tại sao DCP</div>
          <h2 className="section-title">Tin tưởng có cơ sở</h2>
          <p className="section-sub">Không chỉ là lời hứa — mọi cam kết đều được thực thi bởi Smart Contract</p>
        </div>
        <div className="why-grid">
          {[
            {
              icon: '🔒',
              title: 'Không thể giả mạo',
              description:
                'Smart Contract tự động thực thi, không ai — kể cả admin — có thể thay đổi dữ liệu giao dịch đã ghi nhận.',
              delay: 0
            },
            {
              icon: '👁',
              title: '100% Minh bạch',
              description: 'Mọi giao dịch đều công khai trên Blockchain. Bất kỳ ai cũng có thể kiểm chứng qua Block Explorer.',
              delay: 0.1
            },
            {
              icon: '✍️',
              title: 'Đa chữ ký an toàn',
              description: 'Cần 2/3 admin ký tên mới có thể giải ngân. Một người không thể tự ý chuyển tiền ra ngoài.',
              delay: 0.2
            },
            {
              icon: '⚡',
              title: 'Quadratic Funding',
              description:
                'Thuật toán QF đảm bảo phân bổ công bằng — dự án được nhiều người ủng hộ sẽ được ưu tiên, không phải chỉ người giàu nhất.',
              delay: 0.3
            }
          ].map(card => (
            <div
              className={`why-card ${visibleCards.why ? 'visible' : ''}`}
              key={card.title}
              style={{ transitionDelay: `${card.delay}s` }}
              data-observe
              data-group="why"
            >
              <span className="why-icon">{card.icon}</span>
              <h3>{card.title}</h3>
              <p>{card.description}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="stats" id="stats">
        <div className="section-label">Con số thực tế</div>
        <h2 className="section-title">Tác động thực sự</h2>
        <div className="stats-grid" data-observe data-group="stats">
          {stats.map((stat, index) => (
            <div
              className={`stat-item ${visibleCards.stats ? 'visible' : ''}`}
              key={stat.id}
              style={{ transitionDelay: `${stat.delay ?? 0}s` }}
            >
              <span className="stat-num">
                {formatStatValue(statValues[index] ?? 0, stat.suffix)}
              </span>
              <span className="stat-label">{stat.label}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="ranking" id="ranking">
        <div className="rank-header">
          <div>
            <div className="section-label">Bảng xếp hạng</div>
            <h2 className="section-title">Top Quadratic Funding</h2>
            {rankingCalculatedAtLabel && <p className="section-sub">Cập nhật lúc: {rankingCalculatedAtLabel}</p>}
          </div>
          <button className="rank-link" type="button" onClick={() => void loadRankingSnapshot()} disabled={isRankingLoading}>
            {isRankingLoading ? 'Đang tải...' : 'Làm mới ↻'}
          </button>
        </div>

        {rankingErrorMessage && (
          <p className="project-empty" role="alert">
            {rankingErrorMessage}
          </p>
        )}

        {!rankingErrorMessage && !isRankingLoading && rankingItemList.length === 0 && (
          <p className="project-empty">Chưa có dữ liệu xếp hạng QF ở thời điểm hiện tại.</p>
        )}

        {!rankingErrorMessage && rankingItemList.length > 0 && (
          <>
            {/* Top 3 Grid: reorder to [2, 1, 3] so rank-1 sits in wider center column — matching dcp-home.html */}
            {(() => {
              const top3 = rankingItemList.slice(0, 3);

              // Reorder items: [2, 1, 3] layout — rank 1 always in the wider center column
              let orderedTop3: typeof top3 = [];
              if (top3.length === 3) {
                orderedTop3 = [top3[1], top3[0], top3[2]]; // [rank2, rank1, rank3]
              } else if (top3.length === 2) {
                orderedTop3 = [top3[1], top3[0]];           // [rank2, rank1]
              } else {
                orderedTop3 = [...top3];                    // [rank1]
              }

              return (
                <div className="top3-grid">
                  {orderedTop3.map((item, index) => {
                    const isFirst = index === 1; // rank 1 luôn ở vị trí giữa sau khi reorder

                    // Xác định medal emoji theo số lượng items và index trong mảng đã reorder
                    const medal = (() => {
                      if (orderedTop3.length === 1) return '🥇';
                      if (orderedTop3.length === 2) return index === 0 ? '🥈' : '🥇';
                      if (index === 1) return '🥇';
                      return index === 0 ? '🥈' : '🥉';
                    })();

                    return (
                      <div
                        className={`rank-card ${isFirst ? 'first' : ''} visible`}
                        key={item.projectId}
                        style={{ transitionDelay: `${index * 0.1}s` }}
                        data-observe
                        data-group="ranking"
                      >
                        <span className="rank-medal">{medal}</span>
                        <div className="rank-name">{item.projectName}</div>
                        <div className="rank-org">{item.organizationName || 'Tổ chức chưa cập nhật'}</div>
                        <div className="rank-raised">
                          <span className="raised-amount">{formatCurrencyVnd(item.totalRaisedAmount)}₫</span>
                          <span className="raised-donors">👥 {item.uniqueDonorCount}</span>
                        </div>
                        <span className="qf-score-big">QF Score {formatRankingScore(item.totalFundingScore)}</span>
                      </div>
                    );
                  })}
                </div>
              );
            })()}
            <div className="rank-table-wrapper">
            <table className="rank-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Dự án</th>
                  <th>Tổ chức</th>
                  <th>QF Score</th>
                  <th>Đã gây quỹ</th>
                  <th>Số người đã quyên góp</th>
                </tr>
              </thead>
              <tbody>
                {rankingItemList.map(item => (
                  <tr key={item.projectId}>
                    <td className="rank-number">{item.rankPosition}</td>
                    <td className="rank-project">{item.projectName}</td>
                    <td className="rank-organization">{item.organizationName || 'Chưa cập nhật'}</td>
                    <td>
                      <span className="rank-score">{formatRankingScore(item.totalFundingScore)}</span>
                    </td>
                    <td>{`${formatCurrencyVnd(item.totalRaisedAmount)}₫`}</td>
                    <td>{item.uniqueDonorCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
            <FairRankingTab projects={rankingItemList.map(item => ({ projectId: item.projectId, projectName: item.projectName }))} />
          </>
        )}
      </section>

      <PublicCommitteeGovernanceFeed />
      <section className="cta-section">
        <h2>
          Bắt đầu hành trình
          <br />
          từ thiện minh bạch
        </h2>
        <p>Tạo tài khoản miễn phí — chỉ cần email hoặc Google, không cần biết về Blockchain</p>
        <div className="cta-actions">
          <a className="btn-white" href="/register?role=donor">
            🚀 Tạo tài khoản miễn phí
          </a>
          <a className="btn-outline-white" href="/register?role=organization">
            🏢 Tôi là tổ chức từ thiện
          </a>
        </div>
      </section>

      <footer>
        <div className="footer-grid">
          <div className="footer-brand">
            <a href="#" className="logo footer-logo">
              <div className="logo-icon">
                <svg viewBox="0 0 24 24" className="footer-logo-icon">
                  <path d="M12 21.7C5.8 17.5 2 13.2 2 9a6 6 0 0112 0 6 6 0 0112 0c0 4.2-3.8 8.5-10 12.7z" />
                </svg>
              </div>
              <div>
                <span className="logo-text">DCP</span>
                <span className="logo-tag">Minh bạch tuyệt đối</span>
              </div>
            </a>
            <p className="footer-desc">
              Nền tảng từ thiện phi tập trung đầu tiên tại Việt Nam, kết hợp Blockchain và hệ thống thanh toán truyền thống.
            </p>
            <div className="social-links">
              <a href="https://zalo.me/0367400325" className="social-btn" target="_blank" rel="noopener noreferrer">
                𝕏
              </a>
              <a href="https://zalo.me/0367400325" className="social-btn" target="_blank" rel="noopener noreferrer">
                f
              </a>
              <a href="https://zalo.me/0367400325" className="social-btn" target="_blank" rel="noopener noreferrer">
                in
              </a>
              <a href="https://zalo.me/0367400325" className="social-btn" target="_blank" rel="noopener noreferrer">
                ⛓
              </a>
            </div>
          </div>
          <div className="footer-col">
            <h4>Nền tảng</h4>
            <ul>
              <li>
                <a href="/pending-projects">Dự án đang niêm yết chờ kích hoạt</a>
              </li>
              <li>
                <a href="/impact-gallery">Impact NFT Gallery</a>
              </li>
              <li>
                <a href="#">Bảng xếp hạng QF</a>
              </li>
              <li>
                <a href="#">Transparency Dashboard</a>
              </li>
              <li>
                <a href="#">Đăng ký tổ chức</a>
              </li>
            </ul>
          </div>
          <div className="footer-col">
            <h4>Về DCP</h4>
            <ul>
              <li>
                <a href="#">Giới thiệu</a>
              </li>
              <li>
                <a href="#">Cách hoạt động</a>
              </li>
              <li>
                <a href="#">Công nghệ</a>
              </li>
              <li>
                <a href="#">Blog</a>
              </li>
            </ul>
          </div>
          <div className="footer-col">
            <h4>Hỗ trợ</h4>
            <ul>
              <li>
                <a href="#">Điều khoản sử dụng</a>
              </li>
              <li>
                <a href="#">Chính sách bảo mật</a>
              </li>
              <li>
                <a href="tel:0367400325">Liên hệ: 0367400325</a>
              </li>
              <li>
                <a href="https://zalo.me/0367400325" target="_blank" rel="noopener noreferrer">Zalo: 0367400325</a>
              </li>
            </ul>
          </div>
        </div>
        <div className="footer-bottom">
          <span>© 2025 DCP — Decentralized Charity Platform. All rights reserved.</span>
          <div className="footer-tech">
            <span className="tech-badge">⛓ Polygon Amoy</span>
            <span className="tech-badge">💳 PayOS</span>
            <span className="tech-badge">🔐 ERC-4337</span>
            <span className="tech-badge">📦 IPFS</span>
          </div>
        </div>
      </footer>
      {logoutConfirmationDialog}
    </main>
  );
}
