'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { buildApiUrl, fetchApi } from '@/app/utils/apiClient';
import { readAuthSession } from '@/app/utils/authSession';
import type { DrawerTabKey, UrgentRequestItem } from './types';
import IpfsEvidencePreviewCard from '../../common/IpfsEvidencePreviewCard';

type RequestDrawerProps = {
  selectedUrgentRequestItem: UrgentRequestItem | null;
  selectedDrawerTabKey: DrawerTabKey;
  onClose: () => void;
  onChangeTab: (drawerTabKey: DrawerTabKey) => void;
  onApprove: () => Promise<void>;
  onReject: (rejectReason: string) => Promise<void>;
};

type SignerRole = 'ADMIN_SIGNER' | 'ORG_SIGNER' | 'REGULATORY_SIGNER';

type DisbursementStatus =
  | 'NONE'
  | 'PENDING'
  | 'APPROVED'
  | 'EXECUTING'
  | 'COMPLETED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'CANCELLED';

type DisbursementApprovalItem = {
  signerRole: SignerRole;
  signerUserId: string;
  signerAddress: string;
  signedAt: string;
  comment?: string;
};

type DisbursementRejectionItem = {
  signerRole: SignerRole;
  signerUserId: string;
  signerAddress: string;
  reason: string;
  rejectedAt: string;
};

type DisbursementDetailItem = {
  requestId: string;
  requestMode: 'NORMAL' | 'EMERGENCY';
  emergencyReason: string | null;
  raisedRatioBpsAtCreation: number;
  requiredApprovals: number;
  amount: number;
  status: DisbursementStatus;
  approvals: DisbursementApprovalItem[];
  rejection: DisbursementRejectionItem | null;
  timeoutDeadline: string | null;
  payosTransferStatus: string | null;
  createdAt: string;
  updatedAt: string;
  expiredAt: string | null;
  completedAt: string | null;
};

type SignatureStatusTone = 'signed' | 'waiting' | 'rejected' | 'pendingCurrentUser';

type SignatureDisplayItem = {
  signerRole: SignerRole;
  roleLabelText: string;
  statusLabelText: string;
  detailText: string;
  eventTimeText: string | null;
  statusTone: SignatureStatusTone;
};

type HistoryTone = 'neutral' | 'success' | 'warning' | 'error';

type HistoryDisplayItem = {
  eventKey: string;
  titleText: string;
  detailText: string;
  eventTimeText: string;
  eventTimestamp: number;
  tone: HistoryTone;
};

const drawerTabList: { key: DrawerTabKey; label: string }[] = [
  { key: 'overview', label: 'Tổng quan' },
  { key: 'evidence', label: 'Chứng từ' },
  { key: 'signature', label: 'Chữ ký' },
  { key: 'history', label: 'Lịch sử' }
];

const signerRoleDisplayOrder: SignerRole[] = ['REGULATORY_SIGNER', 'ADMIN_SIGNER', 'ORG_SIGNER'];

/** Hàm ánh xạ signer role sang nhãn tiếng Việt chuẩn hóa. Mục đích: đồng nhất ngôn ngữ hiển thị ở tab chữ ký và lịch sử. */
function mapSignerRoleToLabelText(signerRole: SignerRole): string {
  if (signerRole === 'ADMIN_SIGNER') {
    return 'Admin hệ thống';
  }

  if (signerRole === 'ORG_SIGNER') {
    return 'Đại diện tổ chức';
  }

  return 'Cơ quan giám sát';
}

/** Hàm ánh xạ trạng thái yêu cầu sang tiếng Việt dễ hiểu. Mục đích: giúp người dùng đọc nhanh trạng thái nghiệp vụ hiện tại. */
function mapDisbursementStatusToLabelText(disbursementStatus: DisbursementStatus): string {
  if (disbursementStatus === 'PENDING') return 'Đang chờ ký duyệt';
  if (disbursementStatus === 'APPROVED') return 'Đã đủ chữ ký';
  if (disbursementStatus === 'EXECUTING') return 'Đang xử lý chuyển khoản';
  if (disbursementStatus === 'COMPLETED') return 'Đã hoàn tất giải ngân';
  if (disbursementStatus === 'REJECTED') return 'Đã bị từ chối';
  if (disbursementStatus === 'EXPIRED') return 'Đã hết hạn xử lý';
  if (disbursementStatus === 'CANCELLED') return 'Đã hủy';
  return 'Chưa khởi tạo';
}

/** Hàm ánh xạ loại yêu cầu giải ngân sang nhãn tiếng Việt. Mục đích: hiển thị rõ đây là giải ngân thông thường hay khẩn cấp. */
function mapDisbursementRequestModeToLabelText(requestMode: 'NORMAL' | 'EMERGENCY' | null | undefined): string {
  if (requestMode === 'EMERGENCY') {
    return 'Giải ngân khẩn cấp';
  }

  if (requestMode === 'NORMAL') {
    return 'Giải ngân thông thường';
  }

  return 'Chưa có thông tin phân loại';
}

/** Hàm ánh xạ loại yêu cầu giải ngân sang style badge. Mục đích: người dùng nhận diện nhanh mức độ ưu tiên của yêu cầu. */
function mapDisbursementRequestModeBadgeClassName(requestMode: 'NORMAL' | 'EMERGENCY' | null | undefined): string {
  if (requestMode === 'EMERGENCY') {
    return 'bg-red-100 text-red-700 border border-red-200';
  }

  if (requestMode === 'NORMAL') {
    return 'bg-emerald-100 text-emerald-700 border border-emerald-200';
  }

  return 'bg-slate-100 text-slate-600 border border-slate-200';
}

/** Hàm chuyển đổi basis points sang phần trăm. Mục đích: hiển thị tỷ lệ theo chuẩn nghiệp vụ FR7 một cách dễ đọc. */
function formatPercentFromBasisPoints(basisPointsValue: number | undefined): string {
  const normalizedBasisPointsValue = Number.isFinite(basisPointsValue)
    ? Math.max(0, basisPointsValue as number)
    : 0;

  const percentValue = normalizedBasisPointsValue / 100;
  return `${new Intl.NumberFormat('vi-VN', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2
  }).format(percentValue)}%`;
}

/** Hàm ánh xạ role đăng nhập sang signer role. Mục đích: xác định đúng vai trò hiện tại để hiển thị trạng thái "đang chờ bạn ký". */
function mapUserRoleToSignerRole(userRoleValue: string | undefined): SignerRole | null {
  const normalizedUserRole = (userRoleValue || '').trim().toLowerCase();
  if (normalizedUserRole === 'admin') {
    return 'ADMIN_SIGNER';
  }

  if (normalizedUserRole === 'organizations') {
    return 'ORG_SIGNER';
  }

  if (normalizedUserRole === 'regulatory') {
    return 'REGULATORY_SIGNER';
  }

  return null;
}

/** Hàm chuẩn hóa thời gian sang định dạng vi-VN. Mục đích: hiển thị timestamp nhất quán cho chữ ký và lịch sử thao tác. */
function formatDateTimeText(dateValue: string | Date | null | undefined): string {
  if (!dateValue) {
    return 'Không xác định';
  }

  const parsedDate = new Date(dateValue);
  if (Number.isNaN(parsedDate.getTime())) {
    return 'Không xác định';
  }

  return new Intl.DateTimeFormat('vi-VN', {
    hour12: false,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(parsedDate);
}

/** Hàm định dạng số tiền VND. Mục đích: tái sử dụng định dạng tiền khi dựng dòng lịch sử sự kiện. */
function formatCurrencyVietnamDong(amountValue: number): string {
  return `${new Intl.NumberFormat('vi-VN').format(amountValue)}₫`;
}

/** Hàm rút gọn địa chỉ ví để hiển thị. Mục đích: giúp nhìn nhanh signer address mà vẫn giữ khả năng nhận diện. */
function formatCompactWalletAddress(walletAddressValue: string | undefined): string {
  const normalizedWalletAddress = (walletAddressValue || '').trim();
  if (!normalizedWalletAddress) {
    return 'Không có địa chỉ ví';
  }

  if (normalizedWalletAddress.length <= 14) {
    return normalizedWalletAddress;
  }

  return `${normalizedWalletAddress.slice(0, 8)}...${normalizedWalletAddress.slice(-6)}`;
}

/** Hàm quy đổi timestamp deadline thành trạng thái còn lại. Mục đích: cung cấp cảnh báo thời gian xử lý thông minh cho người ký duyệt. */
function formatDeadlineRemainingText(deadlineValue: string | null | undefined): string {
  if (!deadlineValue) {
    return 'Không có thông tin deadline';
  }

  const deadlineTimestamp = new Date(deadlineValue).getTime();
  if (Number.isNaN(deadlineTimestamp)) {
    return 'Không có thông tin deadline';
  }

  const remainMilliseconds = deadlineTimestamp - Date.now();
  if (remainMilliseconds <= 0) {
    return 'Đã quá hạn xử lý';
  }

  const remainMinutes = Math.floor(remainMilliseconds / (60 * 1000));
  if (remainMinutes < 60) {
    return `Còn ${remainMinutes} phút`;
  }

  const remainHours = Math.floor(remainMinutes / 60);
  if (remainHours < 24) {
    return `Còn ${remainHours} giờ`;
  }

  const remainDays = Math.floor(remainHours / 24);
  return `Còn ${remainDays} ngày`;
}

/** Hàm parse thời gian về milliseconds để sort. Mục đích: đảm bảo thứ tự timeline chuẩn ngay cả khi có timestamp thiếu hoặc lỗi định dạng. */
function parseDateToTimestamp(dateValue: string | null | undefined): number {
  if (!dateValue) {
    return Number.MAX_SAFE_INTEGER;
  }

  const parsedTimestamp = new Date(dateValue).getTime();
  return Number.isNaN(parsedTimestamp) ? Number.MAX_SAFE_INTEGER : parsedTimestamp;
}

/** Hàm dựng danh sách trạng thái chữ ký từ dữ liệu thật. Mục đích: thay thế hoàn toàn nội dung mock trong tab "Chữ ký". */
function buildSignatureDisplayItemList(
  disbursementDetailItem: DisbursementDetailItem | null,
  currentUserSignerRole: SignerRole | null
): SignatureDisplayItem[] {
  if (!disbursementDetailItem) {
    return [];
  }

  return signerRoleDisplayOrder.map((signerRole) => {
    const matchedApprovalItem = disbursementDetailItem.approvals.find((approvalItem) => approvalItem.signerRole === signerRole);
    const matchedRejectionItem = disbursementDetailItem.rejection?.signerRole === signerRole
      ? disbursementDetailItem.rejection
      : null;

    if (matchedRejectionItem) {
      return {
        signerRole,
        roleLabelText: mapSignerRoleToLabelText(signerRole),
        statusLabelText: 'Đã từ chối',
        detailText: `Lý do: ${matchedRejectionItem.reason}`,
        eventTimeText: formatDateTimeText(matchedRejectionItem.rejectedAt),
        statusTone: 'rejected'
      };
    }

    if (matchedApprovalItem) {
      return {
        signerRole,
        roleLabelText: mapSignerRoleToLabelText(signerRole),
        statusLabelText: 'Đã ký duyệt',
        detailText: matchedApprovalItem.comment?.trim()
          ? `${formatCompactWalletAddress(matchedApprovalItem.signerAddress)} · Ghi chú: ${matchedApprovalItem.comment.trim()}`
          : `${formatCompactWalletAddress(matchedApprovalItem.signerAddress)} · Không có ghi chú`,
        eventTimeText: formatDateTimeText(matchedApprovalItem.signedAt),
        statusTone: 'signed'
      };
    }

    if (disbursementDetailItem.status === 'PENDING' && signerRole === currentUserSignerRole) {
      return {
        signerRole,
        roleLabelText: mapSignerRoleToLabelText(signerRole),
        statusLabelText: 'Đang chờ bạn ký',
        detailText: 'Vui lòng rà soát chứng từ trước khi thực hiện ký duyệt.',
        eventTimeText: null,
        statusTone: 'pendingCurrentUser'
      };
    }

    if (disbursementDetailItem.requiredApprovals < 3 && disbursementDetailItem.status !== 'PENDING') {
      return {
        signerRole,
        roleLabelText: mapSignerRoleToLabelText(signerRole),
        statusLabelText: 'Không bắt buộc',
        detailText: 'Yêu cầu đã đạt ngưỡng chữ ký động trước vai trò này.',
        eventTimeText: null,
        statusTone: 'waiting'
      };
    }

    return {
      signerRole,
      roleLabelText: mapSignerRoleToLabelText(signerRole),
      statusLabelText: 'Đang chờ ký',
      detailText: 'Vai trò này chưa thực hiện ký duyệt.',
      eventTimeText: null,
      statusTone: 'waiting'
    };
  });
}

/** Hàm dựng timeline lịch sử từ dữ liệu thật. Mục đích: thay thế mock event để phản ánh tiến trình xử lý yêu cầu chính xác. */
function buildHistoryDisplayItemList(disbursementDetailItem: DisbursementDetailItem | null): HistoryDisplayItem[] {
  if (!disbursementDetailItem) {
    return [];
  }

  const historyDisplayItemList: HistoryDisplayItem[] = [];

  historyDisplayItemList.push({
    eventKey: `${disbursementDetailItem.requestId}-created`,
    titleText: 'Tạo yêu cầu giải ngân',
    detailText: `${formatCurrencyVietnamDong(disbursementDetailItem.amount)} · ${disbursementDetailItem.requestMode === 'EMERGENCY' ? 'Chế độ khẩn cấp' : 'Chế độ thông thường'}`,
    eventTimeText: formatDateTimeText(disbursementDetailItem.createdAt),
    eventTimestamp: parseDateToTimestamp(disbursementDetailItem.createdAt),
    tone: 'neutral'
  });

  const sortedApprovalItemList = [...disbursementDetailItem.approvals].sort(
    (leftApprovalItem, rightApprovalItem) => parseDateToTimestamp(leftApprovalItem.signedAt) - parseDateToTimestamp(rightApprovalItem.signedAt)
  );

  sortedApprovalItemList.forEach((approvalItem, approvalItemIndex) => {
    historyDisplayItemList.push({
      eventKey: `${disbursementDetailItem.requestId}-signed-${approvalItemIndex}`,
      titleText: `${mapSignerRoleToLabelText(approvalItem.signerRole)} đã ký duyệt`,
      detailText: approvalItem.comment?.trim() ? `Ghi chú: ${approvalItem.comment.trim()}` : 'Không có ghi chú bổ sung.',
      eventTimeText: formatDateTimeText(approvalItem.signedAt),
      eventTimestamp: parseDateToTimestamp(approvalItem.signedAt),
      tone: 'success'
    });
  });

  if (disbursementDetailItem.rejection) {
    historyDisplayItemList.push({
      eventKey: `${disbursementDetailItem.requestId}-rejected`,
      titleText: `${mapSignerRoleToLabelText(disbursementDetailItem.rejection.signerRole)} đã từ chối yêu cầu`,
      detailText: `Lý do: ${disbursementDetailItem.rejection.reason}`,
      eventTimeText: formatDateTimeText(disbursementDetailItem.rejection.rejectedAt),
      eventTimestamp: parseDateToTimestamp(disbursementDetailItem.rejection.rejectedAt),
      tone: 'error'
    });
  }

  if (disbursementDetailItem.status === 'APPROVED' || disbursementDetailItem.status === 'EXECUTING' || disbursementDetailItem.status === 'COMPLETED') {
    historyDisplayItemList.push({
      eventKey: `${disbursementDetailItem.requestId}-approved`,
      titleText: 'Yêu cầu đã đạt ngưỡng chữ ký',
      detailText: `Đã thu thập ${disbursementDetailItem.approvals.length}/${disbursementDetailItem.requiredApprovals} chữ ký hợp lệ.`,
      eventTimeText: formatDateTimeText(disbursementDetailItem.updatedAt),
      eventTimestamp: parseDateToTimestamp(disbursementDetailItem.updatedAt),
      tone: 'success'
    });
  }

  if (disbursementDetailItem.status === 'COMPLETED') {
    historyDisplayItemList.push({
      eventKey: `${disbursementDetailItem.requestId}-completed`,
      titleText: 'Giải ngân hoàn tất',
      detailText: 'Hệ thống đã hoàn tất quy trình xử lý yêu cầu giải ngân.',
      eventTimeText: formatDateTimeText(disbursementDetailItem.completedAt),
      eventTimestamp: parseDateToTimestamp(disbursementDetailItem.completedAt),
      tone: 'success'
    });
  }

  if (disbursementDetailItem.status === 'EXPIRED') {
    const expiredAtValue = disbursementDetailItem.expiredAt || disbursementDetailItem.timeoutDeadline;
    historyDisplayItemList.push({
      eventKey: `${disbursementDetailItem.requestId}-expired`,
      titleText: 'Yêu cầu đã hết hạn',
      detailText: 'Yêu cầu không đạt đủ chữ ký trong thời hạn quy định.',
      eventTimeText: formatDateTimeText(expiredAtValue),
      eventTimestamp: parseDateToTimestamp(expiredAtValue),
      tone: 'warning'
    });
  }

  if (disbursementDetailItem.status === 'CANCELLED') {
    historyDisplayItemList.push({
      eventKey: `${disbursementDetailItem.requestId}-cancelled`,
      titleText: 'Yêu cầu đã bị hủy',
      detailText: 'Yêu cầu giải ngân đã bị hủy khỏi quy trình xử lý.',
      eventTimeText: formatDateTimeText(disbursementDetailItem.updatedAt),
      eventTimestamp: parseDateToTimestamp(disbursementDetailItem.updatedAt),
      tone: 'warning'
    });
  }

  return historyDisplayItemList.sort((leftHistoryItem, rightHistoryItem) => leftHistoryItem.eventTimestamp - rightHistoryItem.eventTimestamp);
}

/** Hàm bóc tách thông điệp lỗi API. Mục đích: hiển thị lỗi thân thiện thay vì object raw từ fetchApi. */
function resolveApiErrorMessage(errorValue: unknown): string {
  if (
    typeof errorValue === 'object'
    && errorValue
    && 'message' in errorValue
    && typeof (errorValue as { message: unknown }).message === 'string'
  ) {
    return (errorValue as { message: string }).message;
  }

  return 'Không thể tải chi tiết yêu cầu giải ngân. Vui lòng thử lại.';
}

/** Hàm component RequestDrawer. Mục đích: hiển thị chi tiết yêu cầu giải ngân với dữ liệu thật từ backend cho các tab nghiệp vụ. */
export default function RequestDrawer({
  selectedUrgentRequestItem,
  selectedDrawerTabKey,
  onClose,
  onChangeTab,
  onApprove,
  onReject
}: RequestDrawerProps) {
  const [isSubmittingAction, setIsSubmittingAction] = useState(false);
  const [isDetailLoading, setIsDetailLoading] = useState(false);
  const [detailErrorText, setDetailErrorText] = useState('');
  const [isRejectReasonVisible, setIsRejectReasonVisible] = useState(false);
  const [rejectReasonText, setRejectReasonText] = useState('');
  const [rejectReasonErrorText, setRejectReasonErrorText] = useState('');
  const [disbursementDetailItem, setDisbursementDetailItem] = useState<DisbursementDetailItem | null>(null);

  const selectedRequestId = selectedUrgentRequestItem?.id?.trim() || '';

  /** Hàm tải chi tiết request từ backend. Mục đích: cung cấp dữ liệu thật cho tab chữ ký và lịch sử. */
  const loadDisbursementDetail = useCallback(async (): Promise<void> => {
    if (!selectedRequestId) {
      setDisbursementDetailItem(null);
      setDetailErrorText('');
      setIsDetailLoading(false);
      return;
    }

    setIsDetailLoading(true);
    setDetailErrorText('');

    try {
      const authSession = readAuthSession();
      const accessTokenValue = authSession.accessToken?.trim() || '';

      if (!accessTokenValue) {
        throw new Error('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.');
      }

      const response = await fetchApi<DisbursementDetailItem>(buildApiUrl(`/api/disbursement/${encodeURIComponent(selectedRequestId)}`), {
        headers: {
          Authorization: `Bearer ${accessTokenValue}`
        }
      });

      setDisbursementDetailItem(response.data ?? null);
    } catch (errorValue) {
      setDisbursementDetailItem(null);
      setDetailErrorText(resolveApiErrorMessage(errorValue));
    } finally {
      setIsDetailLoading(false);
    }
  }, [selectedRequestId]);

  useEffect(() => {
    void loadDisbursementDetail();
  }, [loadDisbursementDetail]);

  useEffect(() => {
    setIsRejectReasonVisible(false);
    setRejectReasonText('');
    setRejectReasonErrorText('');
  }, [selectedRequestId]);

  const currentUserSignerRole = mapUserRoleToSignerRole(readAuthSession().userRole);

  const signatureDisplayItemList = useMemo(
    () => buildSignatureDisplayItemList(disbursementDetailItem, currentUserSignerRole),
    [currentUserSignerRole, disbursementDetailItem]
  );

  const historyDisplayItemList = useMemo(
    () => buildHistoryDisplayItemList(disbursementDetailItem),
    [disbursementDetailItem]
  );

  /** Hàm xử lý ký duyệt bất đồng bộ, khóa nút để tránh gửi request trùng. */
  async function handleApprove(): Promise<void> {
    if (isSubmittingAction) {
      return;
    }

    setIsSubmittingAction(true);
    try {
      await onApprove();
    } finally {
      setIsSubmittingAction(false);
    }
  }

  /** Hàm xử lý từ chối bất đồng bộ, yêu cầu nhập lý do trước khi gửi lên backend. */
  async function handleReject(): Promise<void> {
    if (isSubmittingAction) {
      return;
    }

    if (!isRejectReasonVisible) {
      setIsRejectReasonVisible(true);
      setRejectReasonErrorText('');
      return;
    }

    const normalizedRejectReason = rejectReasonText.trim();
    if (normalizedRejectReason.length < 5) {
      setRejectReasonErrorText('Lý do từ chối phải có tối thiểu 5 ký tự.');
      return;
    }

    setIsSubmittingAction(true);
    try {
      await onReject(normalizedRejectReason);
    } finally {
      setIsSubmittingAction(false);
    }
  }

  if (!selectedUrgentRequestItem) {
    return null;
  }

  return (
    <>
      <button
        type="button"
        className="fixed inset-0 z-40 bg-slate-900/50 backdrop-blur-[1px]"
        onClick={onClose}
        aria-label="Đóng drawer"
        disabled={isSubmittingAction}
      />

      <aside className="fixed right-0 top-0 z-50 flex h-full w-full max-w-[600px] flex-col bg-white shadow-2xl">
        <div className="flex items-start justify-between border-b border-emerald-900/15 px-6 py-4">
          <div>
            <p className="text-lg font-bold text-slate-900">Chi tiết yêu cầu giải ngân</p>
            <p className="mt-1 text-xs text-slate-500">{selectedUrgentRequestItem.id} · {selectedUrgentRequestItem.projectName}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-emerald-900/15 px-2.5 py-1 text-sm"
            disabled={isSubmittingAction}
          >
            ×
          </button>
        </div>

        <div className="flex border-b border-emerald-900/15 bg-slate-50 px-3">
          {drawerTabList.map((drawerTabItem) => (
            <button
              key={drawerTabItem.key}
              type="button"
              onClick={() => onChangeTab(drawerTabItem.key)}
              className={`relative px-3.5 py-3 text-[12px] font-medium tracking-[0.01em] transition ${selectedDrawerTabKey === drawerTabItem.key ? 'text-[#0A5C50]' : 'text-slate-500 hover:text-slate-700'}`}
            >
              {drawerTabItem.label}
              {selectedDrawerTabKey === drawerTabItem.key ? <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-cyan-500" /> : null}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {selectedDrawerTabKey === 'overview' ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-lg bg-slate-50 p-3">
                <p className="text-[10px] uppercase tracking-wider text-slate-500">Tổ chức</p>
                <p className="mt-1 text-sm font-semibold">{selectedUrgentRequestItem.organizationName}</p>
              </div>
              <div className="rounded-lg bg-slate-50 p-3">
                <p className="text-[10px] uppercase tracking-wider text-slate-500">Số tiền</p>
                <p className="mt-1 font-mono text-base font-semibold text-[#0A5C50]">{selectedUrgentRequestItem.amountText}</p>
              </div>
              <div className="rounded-lg bg-slate-50 p-3 sm:col-span-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-[10px] uppercase tracking-wider text-slate-500">Phân loại yêu cầu</p>
                  <span
                    className={`inline-flex rounded-full px-2.5 py-1 text-[11px] font-semibold ${mapDisbursementRequestModeBadgeClassName(disbursementDetailItem?.requestMode)}`}
                  >
                    {mapDisbursementRequestModeToLabelText(disbursementDetailItem?.requestMode)}
                  </span>
                </div>
              </div>
              <div className="rounded-lg bg-slate-50 p-3 sm:col-span-2">
                <p className="text-[10px] uppercase tracking-wider text-slate-500">Tỷ lệ giải ngân & số tiền</p>
                <p className="mt-1 text-sm font-semibold text-slate-900">
                  {`Tỷ lệ huy động tại thời điểm tạo yêu cầu: ${formatPercentFromBasisPoints(disbursementDetailItem?.raisedRatioBpsAtCreation)}`}
                </p>
                <p className="mt-1 text-sm text-slate-700">
                  {`Số tiền đề nghị giải ngân: ${selectedUrgentRequestItem.amountText}`}
                </p>
              </div>
              {disbursementDetailItem?.requestMode === 'EMERGENCY' && disbursementDetailItem.emergencyReason?.trim() ? (
                <div className="rounded-lg border border-red-200 bg-red-50 p-3 sm:col-span-2">
                  <p className="text-[10px] uppercase tracking-wider text-red-600">Lý do khẩn cấp</p>
                  <p className="mt-1 text-sm leading-6 text-red-700">
                    {disbursementDetailItem.emergencyReason.trim()}
                  </p>
                </div>
              ) : null}
              <div className="rounded-lg bg-slate-50 p-3 sm:col-span-2">
                <p className="text-[10px] uppercase tracking-wider text-slate-500">Mục đích sử dụng tiền</p>
                <p className="mt-1 text-sm leading-6 text-slate-700">{selectedUrgentRequestItem.usagePurpose || 'Chưa có thông tin mục đích sử dụng tiền.'}</p>
              </div>
            </div>
          ) : null}

          {/*
            Ghi chú logic phức tạp:
            Mount sẵn nội dung tab chứng từ (ẩn bằng CSS khi chưa chọn tab) để browser
            tải IPFS sớm ngay lúc mở drawer, giúp khi bấm tab "Chứng từ" hiển thị nhanh hơn.
          */}
          <div className={selectedDrawerTabKey === 'evidence' ? 'space-y-4' : 'hidden'}>
            {selectedUrgentRequestItem.ipfsCid ? (
              <IpfsEvidencePreviewCard
                cid={selectedUrgentRequestItem.ipfsCid}
                fileName={selectedUrgentRequestItem.fileName}
                documentTypeLabel="Tài liệu minh chứng"
              />
            ) : (
              <div className="rounded-lg border border-slate-200 p-3 text-center text-sm text-slate-500">
                Không có tài liệu minh chứng
              </div>
            )}
          </div>

          {selectedDrawerTabKey === 'signature' ? (
            <div className="space-y-3">
              {isDetailLoading ? (
                <div className="space-y-2">
                  {Array.from({ length: 3 }).map((_, indexValue) => (
                    <div key={indexValue} className="h-16 animate-pulse rounded-lg border border-slate-200 bg-slate-100" />
                  ))}
                </div>
              ) : detailErrorText ? (
                <div className="rounded-lg border border-red-200 bg-red-50 p-3">
                  <p className="text-sm font-semibold text-red-700">Không thể tải dữ liệu chữ ký</p>
                  <p className="mt-1 text-xs text-red-600">{detailErrorText}</p>
                  <button
                    type="button"
                    onClick={() => {
                      void loadDisbursementDetail();
                    }}
                    className="mt-3 rounded-md bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700"
                  >
                    Thử lại
                  </button>
                </div>
              ) : (
                <>
                  <div className="rounded-lg border border-emerald-900/15 bg-slate-50 p-3">
                    <p className="text-[10px] font-semibold uppercase tracking-[0.06em] text-slate-500">Tổng quan ký duyệt</p>
                    <p className="mt-1 text-sm font-semibold text-slate-900">
                      {disbursementDetailItem ? mapDisbursementStatusToLabelText(disbursementDetailItem.status) : 'Không xác định'}
                    </p>
                    <p className="mt-1 text-xs text-slate-600">
                      Đã thu thập {disbursementDetailItem?.approvals.length || 0}/{disbursementDetailItem?.requiredApprovals || 0} chữ ký hợp lệ.
                    </p>
                    {disbursementDetailItem?.status === 'PENDING' ? (
                      <p className="mt-1 text-xs text-amber-700">
                        {formatDeadlineRemainingText(disbursementDetailItem.timeoutDeadline || disbursementDetailItem.expiredAt)}
                      </p>
                    ) : null}
                  </div>

                  {signatureDisplayItemList.map((signatureDisplayItem) => (
                    <div
                      key={signatureDisplayItem.signerRole}
                      className={`rounded-lg border p-3 ${
                        signatureDisplayItem.statusTone === 'signed'
                          ? 'border-emerald-200 bg-emerald-50'
                          : signatureDisplayItem.statusTone === 'rejected'
                            ? 'border-red-200 bg-red-50'
                            : signatureDisplayItem.statusTone === 'pendingCurrentUser'
                              ? 'border-cyan-300 bg-cyan-50'
                              : 'border-slate-200 bg-white'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-sm font-semibold text-slate-900">{signatureDisplayItem.roleLabelText}</p>
                        <span
                          className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                            signatureDisplayItem.statusTone === 'signed'
                              ? 'bg-emerald-100 text-emerald-700'
                              : signatureDisplayItem.statusTone === 'rejected'
                                ? 'bg-red-100 text-red-700'
                                : signatureDisplayItem.statusTone === 'pendingCurrentUser'
                                  ? 'bg-cyan-100 text-cyan-700'
                                  : 'bg-slate-100 text-slate-600'
                          }`}
                        >
                          {signatureDisplayItem.statusLabelText}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-slate-600">{signatureDisplayItem.detailText}</p>
                      {signatureDisplayItem.eventTimeText ? (
                        <p className="mt-1 font-mono text-[11px] text-slate-500">{signatureDisplayItem.eventTimeText}</p>
                      ) : null}
                    </div>
                  ))}
                </>
              )}
            </div>
          ) : null}

          {selectedDrawerTabKey === 'history' ? (
            <div className="space-y-3">
              {isDetailLoading ? (
                <div className="space-y-2">
                  {Array.from({ length: 4 }).map((_, indexValue) => (
                    <div key={indexValue} className="h-14 animate-pulse rounded-lg border border-slate-200 bg-slate-100" />
                  ))}
                </div>
              ) : detailErrorText ? (
                <div className="rounded-lg border border-red-200 bg-red-50 p-3">
                  <p className="text-sm font-semibold text-red-700">Không thể tải lịch sử yêu cầu</p>
                  <p className="mt-1 text-xs text-red-600">{detailErrorText}</p>
                  <button
                    type="button"
                    onClick={() => {
                      void loadDisbursementDetail();
                    }}
                    className="mt-3 rounded-md bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700"
                  >
                    Thử lại
                  </button>
                </div>
              ) : historyDisplayItemList.length === 0 ? (
                <div className="rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-500">
                  Chưa có bản ghi lịch sử cho yêu cầu này.
                </div>
              ) : (
                historyDisplayItemList.map((historyDisplayItem) => (
                  <div
                    key={historyDisplayItem.eventKey}
                    className={`rounded-lg border p-3 ${
                      historyDisplayItem.tone === 'success'
                        ? 'border-emerald-200 bg-emerald-50'
                        : historyDisplayItem.tone === 'warning'
                          ? 'border-amber-200 bg-amber-50'
                          : historyDisplayItem.tone === 'error'
                            ? 'border-red-200 bg-red-50'
                            : 'border-slate-200 bg-white'
                    }`}
                  >
                    <p className="text-sm font-semibold text-slate-900">{historyDisplayItem.titleText}</p>
                    <p className="mt-1 text-xs text-slate-600">{historyDisplayItem.detailText}</p>
                    <p className="mt-1 font-mono text-[11px] text-slate-500">{historyDisplayItem.eventTimeText}</p>
                  </div>
                ))
              )}
            </div>
          ) : null}
        </div>

        <div className="space-y-3 border-t border-emerald-900/15 bg-slate-50 px-6 py-4">
          {isRejectReasonVisible ? (
            <div>
              <label htmlFor="regulatory-reject-reason" className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                Lý do từ chối
              </label>
              <textarea
                id="regulatory-reject-reason"
                value={rejectReasonText}
                onChange={(event) => {
                  setRejectReasonText(event.target.value);
                  setRejectReasonErrorText('');
                }}
                disabled={isSubmittingAction}
                maxLength={500}
                rows={3}
                placeholder="Nhập lý do từ chối yêu cầu giải ngân..."
                className="mt-2 w-full resize-none rounded-lg border border-red-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-red-400 focus:ring-2 focus:ring-red-100 disabled:cursor-not-allowed disabled:opacity-60"
              />
              {rejectReasonErrorText ? <p className="mt-1 text-xs font-medium text-red-600">{rejectReasonErrorText}</p> : null}
            </div>
          ) : null}
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => {
                void handleReject();
              }}
              disabled={isSubmittingAction}
              className="flex-1 rounded-lg border-2 border-red-600 py-2 text-sm font-bold text-red-600 transition hover:bg-red-600 hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isRejectReasonVisible ? 'Xác nhận từ chối' : 'Từ chối'}
            </button>
            <button
              type="button"
              onClick={() => {
                void handleApprove();
              }}
              disabled={isSubmittingAction}
              className="flex-[2] rounded-lg bg-gradient-to-r from-emerald-500 to-emerald-600 py-2 text-sm font-bold text-white disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isSubmittingAction ? 'Đang xử lý...' : 'Xác nhận ký duyệt'}
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
