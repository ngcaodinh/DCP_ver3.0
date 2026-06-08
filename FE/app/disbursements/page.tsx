'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import IpfsEvidencePreviewCard from '@/app/components/common/IpfsEvidencePreviewCard';
import { ApiErrorResponse, buildApiUrl, fetchApi } from '../utils/apiClient';

type DisbursementApprovalItem = {
  signerRole: string;
  signerUserId: string;
  signerAddress: string;
  transactionHash: string;
  signedAt: string;
  comment?: string;
};

type DisbursementRejectionItem = {
  signerRole: string;
  signerUserId: string;
  signerAddress: string;
  reason: string;
  rejectedAt: string;
};

type DisbursementListItem = {
  requestId: string;
  onChainRequestId: number;
  projectId: string;
  beneficiaryWalletAddress: string;
  requestMode: 'NORMAL' | 'EMERGENCY';
  emergencyReason: string | null;
  requiredApprovals: number;
  raisedRatioBpsAtCreation: number;
  amount: number;
  usagePurpose: string;
  evidenceCid: string;
  status: string;
  approvals: DisbursementApprovalItem[];
  rejection: DisbursementRejectionItem | null;
  timeoutDeadline: string | null;
  payosTransferId: string | null;
  payosTransferStatus: string | null;
  createdAt: string;
  updatedAt: string;
  expiredAt: string | null;
  completedAt: string | null;
};

type DonationCampaignDetail = {
  projectId: string;
  name: string;
};

type DisbursementPageData = {
  projectName: string;
  disbursementList: DisbursementListItem[];
};

type DisbursementStageItem = {
  id: string;
  title: string;
  subtitle: string;
  actorLabel: string;
  timeValue: string | null;
  status: 'completed' | 'active' | 'blocked' | 'pending';
  transactionHash?: string;
};

const statusLabelMap: Record<string, string> = {
  PENDING: 'Đang chờ ký duyệt',
  APPROVED: 'Đã đủ chữ ký',
  REJECTED: 'Đã từ chối',
  EXPIRED: 'Đã hết hạn',
  BANK_PROCESSING: 'Ngân hàng đang xử lý',
  COMPLETED: 'Đã hoàn tất',
  FAILED: 'Thất bại'
};

const signerRoleLabelMap: Record<string, string> = {
  admin: 'Quản trị viên hệ thống',
  ADMIN: 'Quản trị viên hệ thống',
  ADMIN_SIGNER: 'Người ký phía quản trị viên',
  organizations: 'Tổ chức từ thiện',
  organization: 'Tổ chức từ thiện',
  ORGANIZATION: 'Tổ chức từ thiện',
  ORGANIZATION_SIGNER: 'Người ký phía tổ chức từ thiện',
  ORG_SIGNER: 'Người ký phía tổ chức từ thiện',
  regulatory: 'Cơ quan giám sát',
  REGULATORY: 'Cơ quan giám sát',
  REGULATORY_SIGNER: 'Người ký phía cơ quan giám sát'
};

const transferStatusLabelMap: Record<string, string> = {
  SUCCESS: 'Chuyển khoản thành công',
  SUCCEEDED: 'Chuyển khoản thành công',
  COMPLETED: 'Chuyển khoản hoàn tất',
  PROCESSING: 'Đang xử lý chuyển khoản',
  PENDING: 'Đang chờ xử lý chuyển khoản',
  FAILED: 'Chuyển khoản thất bại',
  REJECTED: 'Chuyển khoản bị từ chối',
  CANCELLED: 'Chuyển khoản đã hủy',
  CANCELED: 'Chuyển khoản đã hủy',
  MANUAL_REVIEW: 'Cần kiểm tra thủ công'
};

/** Hàm định dạng số tiền theo chuẩn Việt Nam. Mục đích: hiển thị số tiền giải ngân rõ ràng, dễ đọc. */
function formatCurrencyVnd(amountValue: number): string {
  return `${new Intl.NumberFormat('vi-VN').format(amountValue)} Token`;
}

/** Hàm định dạng ngày giờ. Mục đích: hiển thị mốc thời gian cụ thể cho từng giai đoạn. */
function formatDateTime(dateTimeValue: string | null | undefined): string {
  if (!dateTimeValue) return 'Chưa ghi nhận';
  const parsedDateTime = new Date(dateTimeValue);
  if (Number.isNaN(parsedDateTime.getTime())) return 'Không xác định';

  return parsedDateTime.toLocaleString('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

/** Hàm rút gọn địa chỉ ví hoặc transaction hash. Mục đích: giữ giao diện gọn trên mobile. */
function shortenBlockchainValue(blockchainValue: string): string {
  if (!blockchainValue) return 'Chưa có';
  return blockchainValue.length <= 18 ? blockchainValue : `${blockchainValue.slice(0, 10)}...${blockchainValue.slice(-8)}`;
}

/** Hàm tạo link explorer cho transaction hash. Mục đích: cho phép người dùng kiểm chứng giao dịch on-chain. */
function buildTransactionExplorerUrl(transactionHashValue: string): string {
  if (!transactionHashValue) return '';
  const blockchainExplorerTxBaseUrl = String(process.env.NEXT_PUBLIC_BLOCKCHAIN_EXPLORER_TX_BASE_URL || 'https://amoy.polygonscan.com/tx').trim();
  return `${blockchainExplorerTxBaseUrl.replace(/\/$/, '')}/${encodeURIComponent(transactionHashValue)}`;
}

/** Hàm lấy nhãn trạng thái giải ngân. Mục đích: chuẩn hóa text tiếng Việt cho trạng thái từ API. */
function getDisbursementStatusLabel(statusValue: string): string {
  return statusLabelMap[statusValue] || 'Trạng thái chưa xác định';
}

/** Hàm lấy nhãn vai trò người ký. Mục đích: chuyển mã role từ hệ thống sang tiếng Việt dễ hiểu. */
function getSignerRoleLabel(signerRoleValue: string): string {
  const normalizedSignerRoleValue = signerRoleValue.trim();
  const upperSignerRoleValue = normalizedSignerRoleValue.toUpperCase();
  return signerRoleLabelMap[normalizedSignerRoleValue] || signerRoleLabelMap[upperSignerRoleValue] || 'Người ký không xác định';
}

/** Hàm lấy nhãn trạng thái chuyển khoản. Mục đích: tránh hiển thị mã kỹ thuật cho người dùng cuối. */
function getTransferStatusLabel(transferStatusValue: string | null): string {
  if (!transferStatusValue) return 'Chưa có trạng thái chuyển khoản';
  const normalizedTransferStatusValue = transferStatusValue.trim().toUpperCase();
  return transferStatusLabelMap[normalizedTransferStatusValue] || 'Trạng thái chuyển khoản chưa xác định';
}

/** Hàm lấy class màu trạng thái. Mục đích: giữ badge trạng thái đồng nhất với toàn trang. */
function getStatusBadgeClassName(statusValue: string): string {
  if (statusValue === 'COMPLETED' || statusValue === 'APPROVED') return 'border-emerald-200 bg-emerald-50 text-emerald-700';
  if (statusValue === 'REJECTED' || statusValue === 'FAILED' || statusValue === 'EXPIRED') return 'border-rose-200 bg-rose-50 text-rose-700';
  if (statusValue === 'BANK_PROCESSING' || statusValue === 'PENDING') return 'border-amber-200 bg-amber-50 text-amber-700';
  return 'border-slate-200 bg-slate-50 text-slate-700';
}

/** Hàm lấy class màu giai đoạn. Mục đích: thể hiện rõ giai đoạn đã xong, đang chạy hoặc bị chặn. */
function getStageClassName(stageStatus: DisbursementStageItem['status']): string {
  const stageClassNameMap: Record<DisbursementStageItem['status'], string> = {
    completed: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    active: 'border-sky-200 bg-sky-50 text-sky-700',
    blocked: 'border-rose-200 bg-rose-50 text-rose-700',
    pending: 'border-slate-200 bg-slate-50 text-slate-500'
  };

  return stageClassNameMap[stageStatus];
}

/** Hàm dựng các giai đoạn giải ngân. Mục đích: hiển thị logic nghiệp vụ theo flow dễ hiểu thay vì chỉ liệt kê log thô. */
function buildDisbursementStageList(disbursementItem: DisbursementListItem): DisbursementStageItem[] {
  const hasEnoughApprovals = disbursementItem.approvals.length >= disbursementItem.requiredApprovals;
  const hasBankProgress = Boolean(disbursementItem.payosTransferStatus);
  const isRejected = Boolean(disbursementItem.rejection) || ['REJECTED', 'FAILED', 'EXPIRED'].includes(disbursementItem.status);
  const isCompleted = disbursementItem.status === 'COMPLETED';

  return [
    {
      id: `${disbursementItem.requestId}-created`,
      title: '1. Tạo yêu cầu',
      subtitle: `Tổ chức gửi yêu cầu giải ngân ${formatCurrencyVnd(disbursementItem.amount)} cho mục đích: ${disbursementItem.usagePurpose}.`,
      actorLabel: 'Tổ chức từ thiện',
      timeValue: disbursementItem.createdAt,
      status: 'completed'
    },
    {
      id: `${disbursementItem.requestId}-review`,
      title: '2. Kiểm tra minh chứng IPFS',
      subtitle: disbursementItem.evidenceCid ? 'Minh chứng IPFS được đính kèm để các bên ký duyệt kiểm tra trước khi ký.' : 'Yêu cầu chưa có CID minh chứng IPFS.',
      actorLabel: 'Các bên ký duyệt',
      timeValue: disbursementItem.createdAt,
      status: disbursementItem.evidenceCid ? 'completed' : 'active'
    },
    {
      id: `${disbursementItem.requestId}-signing`,
      title: '3. Thu thập chữ ký',
      subtitle: `Đã có ${disbursementItem.approvals.length}/${disbursementItem.requiredApprovals} chữ ký hợp lệ.`,
      actorLabel: 'Quản trị viên, tổ chức từ thiện và cơ quan giám sát',
      timeValue: disbursementItem.approvals.at(-1)?.signedAt || disbursementItem.timeoutDeadline,
      status: isRejected ? 'blocked' : hasEnoughApprovals ? 'completed' : 'active'
    },
    {
      id: `${disbursementItem.requestId}-bank`,
      title: '4. Chuyển khoản',
      subtitle: hasBankProgress ? `Cổng thanh toán ghi nhận: ${getTransferStatusLabel(disbursementItem.payosTransferStatus)}.` : 'Chưa có trạng thái chuyển khoản từ cổng thanh toán.',
      actorLabel: 'Cổng thanh toán',
      timeValue: hasBankProgress ? disbursementItem.updatedAt : null,
      status: isRejected ? 'blocked' : hasBankProgress ? 'completed' : hasEnoughApprovals ? 'active' : 'pending'
    },
    {
      id: `${disbursementItem.requestId}-completed`,
      title: '5. Hoàn tất công khai',
      subtitle: isCompleted ? 'Yêu cầu đã hoàn tất và được ghi vào lịch sử công khai.' : 'Chưa hoàn tất, cộng đồng vẫn có thể theo dõi các bước trước đó.',
      actorLabel: 'Hệ thống',
      timeValue: disbursementItem.completedAt,
      status: isRejected ? 'blocked' : isCompleted ? 'completed' : 'pending'
    }
  ];
}

/** Hàm tải dữ liệu giải ngân an toàn. Mục đích: tách lỗi từng API để route lịch sử không làm hỏng toàn trang khi chưa có bản ghi. */
async function loadPublicDisbursementPageData(selectedProjectId: string): Promise<DisbursementPageData> {
  const campaignResponse = await fetchApi<DonationCampaignDetail | null>(
    buildApiUrl(`/donations/campaigns/${encodeURIComponent(selectedProjectId)}`),
    { method: 'GET', cache: 'no-store' }
  );

  try {
    const disbursementResponse = await fetchApi<DisbursementListItem[]>(
      buildApiUrl(`/api/disbursement/project/${encodeURIComponent(selectedProjectId)}`),
      { method: 'GET', cache: 'no-store' }
    );

    return {
      projectName: campaignResponse.data?.name || 'Dự án',
      disbursementList: disbursementResponse.data || []
    };
  } catch (error) {
    const apiError = error as ApiErrorResponse;
    if (apiError?.statusCode === 404) {
      return {
        projectName: campaignResponse.data?.name || 'Dự án',
        disbursementList: []
      };
    }

    throw error;
  }
}

/** Hàm render thông báo khi thiếu projectId. Mục đích: tránh gọi API sai và hướng dẫn người dùng đi đúng luồng từ trang chủ. */
function MissingProjectState() {
  return (
    <div className="rounded-3xl border border-[#b9e8df] bg-white p-6 shadow-[0_24px_70px_rgba(14,124,107,0.12)] sm:p-8">
      <p className="text-xs font-black uppercase tracking-[0.18em] text-[#0e7c6b]">Cần chọn dự án</p>
      <h1 className="mt-2 text-2xl font-black text-[#0f172a] sm:text-4xl">Lịch sử giải ngân được xem theo từng dự án</h1>
      <p className="mt-3 max-w-2xl text-sm leading-6 text-[#475569]">
        Vui lòng mở trang chủ, chọn một dự án trong phần “Chi tiết dự án”, sau đó bấm “Xem toàn bộ quá trình giải ngân”. Cách này giúp hệ thống tải đúng dòng thời gian, minh chứng IPFS và mã giao dịch của dự án đó.
      </p>
      <a href="/" className="mt-6 inline-flex rounded-xl bg-[#0e7c6b] px-5 py-3 text-sm font-bold text-white transition hover:bg-[#0b6759]">
        Về trang chủ chọn dự án
      </a>
    </div>
  );
}

/** Hàm render nội dung trang lịch sử giải ngân. Mục đích: đọc projectId từ URL và hiển thị timeline công khai của dự án. */
function DisbursementsPageContent() {
  const searchParams = useSearchParams();
  const selectedProjectId = String(searchParams.get('projectId') || '').trim();
  const [projectName, setProjectName] = useState('Dự án');
  const [disbursementList, setDisbursementList] = useState<DisbursementListItem[]>([]);
  const [isPageLoading, setIsPageLoading] = useState(Boolean(selectedProjectId));
  const [pageErrorMessage, setPageErrorMessage] = useState('');

  useEffect(() => {
    /** Hàm tải dữ liệu lịch sử giải ngân. Mục đích: chỉ gọi API khi URL có projectId hợp lệ. */
    async function loadDisbursementPageData(): Promise<void> {
      if (!selectedProjectId) {
        setIsPageLoading(false);
        setPageErrorMessage('');
        setDisbursementList([]);
        return;
      }

      setIsPageLoading(true);
      setPageErrorMessage('');

      try {
        const disbursementPageData = await loadPublicDisbursementPageData(selectedProjectId);
        setProjectName(disbursementPageData.projectName);
        setDisbursementList(disbursementPageData.disbursementList);
      } catch (error) {
        const errorMessage = error && typeof error === 'object' && 'message' in error ? String((error as { message?: string }).message || '') : '';
        setPageErrorMessage(errorMessage || 'Không thể tải lịch sử giải ngân của dự án này. Vui lòng thử lại sau.');
      } finally {
        setIsPageLoading(false);
      }
    }

    loadDisbursementPageData();
  }, [selectedProjectId]);

  return (
    <main className="min-h-screen bg-[#eefdf9] px-4 py-6 text-[#0f172a] sm:px-6 lg:px-8">
      <div className="mx-auto max-w-6xl">
        <a href="/" className="inline-flex items-center text-sm font-semibold text-[#0e7c6b] transition hover:text-[#0b6759] hover:underline">
          ← Quay lại trang chủ
        </a>

        <section className="mt-5">
          {!selectedProjectId ? (
            <MissingProjectState />
          ) : (
            <div className="overflow-hidden rounded-3xl border border-[#b9e8df] bg-white shadow-[0_24px_70px_rgba(14,124,107,0.14)]">
              <div className="bg-gradient-to-br from-[#0e7c6b] via-[#12a08b] to-[#7dd3c7] px-5 py-7 text-white sm:px-7 sm:py-9">
                <p className="text-xs font-bold uppercase tracking-[0.18em] text-[#d9fff8]">Minh bạch giải ngân</p>
                <h1 className="mt-2 text-2xl font-black leading-tight sm:text-4xl">Quá trình giải ngân của {projectName}</h1>
                <p className="mt-3 max-w-3xl text-sm leading-6 text-[#ecfffb] sm:text-base">
                  Mỗi yêu cầu được trình bày như một luồng nghiệp vụ: tạo yêu cầu, kiểm tra minh chứng IPFS, thu thập chữ ký, chuyển khoản và hoàn tất công khai.
                </p>
              </div>

              <div className="p-4 sm:p-6">
                {isPageLoading && (
                  <div className="rounded-2xl border border-[#d1fae5] bg-[#f0fdfa] p-6 text-center text-sm font-semibold text-[#0f766e]">
                    Đang tải quá trình giải ngân...
                  </div>
                )}

                {!isPageLoading && pageErrorMessage && (
                  <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5" role="alert">
                    <p className="text-sm font-bold text-amber-800">Chưa thể tải timeline giải ngân.</p>
                    <p className="mt-1 text-sm leading-6 text-amber-700">{pageErrorMessage}</p>
                    <p className="mt-2 text-xs text-amber-700">Nếu bạn mở trực tiếp URL này, hãy quay lại trang chủ và vào từ link “Xem toàn bộ quá trình giải ngân”.</p>
                  </div>
                )}

                {!isPageLoading && !pageErrorMessage && disbursementList.length === 0 && (
                  <div className="rounded-2xl border border-dashed border-[#99f6e4] bg-[#f8fffd] p-8 text-center">
                    <p className="text-lg font-bold text-[#0f766e]">Dự án chưa có yêu cầu giải ngân công khai.</p>
                    <p className="mt-2 text-sm text-[#64748b]">Khi tổ chức tạo yêu cầu và có dữ liệu ký duyệt, toàn bộ giai đoạn sẽ xuất hiện tại đây.</p>
                  </div>
                )}

                {!isPageLoading && !pageErrorMessage && disbursementList.length > 0 && (
                  <div className="space-y-5">
                    {disbursementList.map(disbursementItem => {
                      const stageList = buildDisbursementStageList(disbursementItem);

                      return (
                        <article key={disbursementItem.requestId} className="rounded-2xl border border-[#cdeee8] bg-[#fbfefd] p-4 shadow-sm sm:p-5">
                          <div className="flex flex-col gap-3 border-b border-[#e2f3ef] pb-4 lg:flex-row lg:items-start lg:justify-between">
                            <div>
                              <div className="flex flex-wrap items-center gap-2">
                                <h2 className="text-lg font-black text-[#0f172a]">Yêu cầu #{disbursementItem.onChainRequestId || disbursementItem.requestId}</h2>
                                <span className={`rounded-full border px-3 py-1 text-xs font-bold ${getStatusBadgeClassName(disbursementItem.status)}`}>
                                  {getDisbursementStatusLabel(disbursementItem.status)}
                                </span>
                                <span className="rounded-full border border-sky-200 bg-sky-50 px-3 py-1 text-xs font-bold text-sky-700">
                                  {disbursementItem.requestMode === 'EMERGENCY' ? 'Khẩn cấp' : 'Thông thường'}
                                </span>
                              </div>
                              <p className="mt-2 text-sm leading-6 text-[#475569]">Tạo lúc {formatDateTime(disbursementItem.createdAt)} · Hạn ký {formatDateTime(disbursementItem.timeoutDeadline)}</p>
                              {disbursementItem.emergencyReason && <p className="mt-2 text-sm font-semibold text-rose-700">Lý do khẩn cấp: {disbursementItem.emergencyReason}</p>}
                            </div>
                            <div className="rounded-2xl border border-[#d1fae5] bg-white px-4 py-3 text-sm">
                              <p className="text-[11px] font-bold uppercase tracking-[0.08em] text-[#64748b]">Giá trị giải ngân</p>
                              <p className="mt-1 text-xl font-black text-[#0e7c6b]">{formatCurrencyVnd(disbursementItem.amount)}</p>
                              <p className="mt-1 text-xs font-semibold text-[#64748b]">Chữ ký: {disbursementItem.approvals.length}/{disbursementItem.requiredApprovals}</p>
                            </div>
                          </div>

                          <div className="mt-4 grid gap-4 lg:grid-cols-[1.15fr_0.85fr]">
                            <section className="rounded-2xl border border-[#e2f3ef] bg-white p-4">
                              <h3 className="text-sm font-black uppercase tracking-[0.08em] text-[#0e7c6b]">Các giai đoạn diễn ra</h3>
                              <div className="mt-4 space-y-3">
                                {stageList.map(stageItem => (
                                  <div key={stageItem.id} className={`rounded-2xl border p-4 ${getStageClassName(stageItem.status)}`}>
                                    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                                      <div>
                                        <p className="font-black">{stageItem.title}</p>
                                        <p className="mt-1 text-sm leading-5">{stageItem.subtitle}</p>
                                        <p className="mt-2 text-xs font-bold uppercase tracking-[0.06em]">Thực hiện bởi: {stageItem.actorLabel}</p>
                                      </div>
                                      <time className="shrink-0 text-xs font-bold">{formatDateTime(stageItem.timeValue)}</time>
                                    </div>
                                    {stageItem.transactionHash && (
                                      <a href={buildTransactionExplorerUrl(stageItem.transactionHash)} target="_blank" rel="noreferrer noopener" className="mt-2 inline-flex break-all rounded-lg border border-current bg-white/70 px-2.5 py-1.5 font-mono text-xs font-bold">
                                        {shortenBlockchainValue(stageItem.transactionHash)} ↗
                                      </a>
                                    )}
                                  </div>
                                ))}
                              </div>
                            </section>

                            <section className="space-y-4">
                              <div className="rounded-2xl border border-[#e2f3ef] bg-white p-4">
                                <div className="flex items-center justify-between gap-3">
                                  <h3 className="text-sm font-black uppercase tracking-[0.08em] text-[#0e7c6b]">Kiểm tra minh chứng IPFS</h3>
                                  <span className="rounded-full bg-[#e6f7f4] px-2.5 py-1 text-xs font-bold text-[#0e7c6b]">Minh chứng</span>
                                </div>
                                <div className="mt-3">
                                  {disbursementItem.evidenceCid ? (
                                    <IpfsEvidencePreviewCard cid={disbursementItem.evidenceCid} fileName={`Minh chứng giải ngân #${disbursementItem.onChainRequestId || disbursementItem.requestId}`} documentTypeLabel="Minh chứng giải ngân" compact />
                                  ) : (
                                    <p className="rounded-xl border border-dashed border-[#cbd5e1] bg-[#f8fafc] p-4 text-sm text-[#64748b]">Chưa có CID minh chứng.</p>
                                  )}
                                </div>
                              </div>

                              <div className="rounded-2xl border border-[#e2f3ef] bg-white p-4">
                                <h3 className="text-sm font-black uppercase tracking-[0.08em] text-[#0e7c6b]">Ai đã duyệt?</h3>
                                <div className="mt-3 space-y-2">
                                  {disbursementItem.approvals.length === 0 ? (
                                    <p className="rounded-xl bg-[#f8fafc] p-3 text-sm text-[#64748b]">Chưa có chữ ký duyệt.</p>
                                  ) : (
                                    disbursementItem.approvals.map((approvalItem, approvalIndex) => (
                                      <div key={`${disbursementItem.requestId}-reviewer-${approvalIndex}`} className="rounded-xl border border-[#edf5f3] bg-[#fbfefd] p-3 text-sm">
                                        <p className="font-black text-[#0f172a]">{getSignerRoleLabel(approvalItem.signerRole)}</p>
                                        <p className="mt-1 text-xs text-[#64748b]">Duyệt lúc {formatDateTime(approvalItem.signedAt)}</p>
                                        {approvalItem.transactionHash && (
                                          <div className="mt-2">
                                            <p className="text-[11px] font-bold uppercase tracking-[0.06em] text-[#64748b]">Mã giao dịch ký</p>
                                            <a href={buildTransactionExplorerUrl(approvalItem.transactionHash)} target="_blank" rel="noreferrer noopener" className="mt-1 inline-flex break-all rounded-lg border border-[#99f6e4] bg-[#f0fdfa] px-2.5 py-1.5 font-mono text-xs font-bold text-[#0f766e] transition hover:border-[#2dd4bf] hover:bg-[#ccfbf1]">
                                              {shortenBlockchainValue(approvalItem.transactionHash)} ↗
                                            </a>
                                          </div>
                                        )}
                                        {!approvalItem.transactionHash && (
                                          <p className="mt-2 rounded-lg border border-dashed border-[#cbd5e1] bg-white px-2.5 py-1.5 text-xs text-[#64748b]">Chưa có mã giao dịch ký.</p>
                                        )}
                                      </div>
                                    ))
                                  )}
                                </div>
                              </div>
                            </section>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

/** Hàm trang lịch sử giải ngân. Mục đích: bọc useSearchParams trong Suspense để Next.js prerender an toàn. */
export default function DisbursementsPage() {
  return (
    <Suspense fallback={<main className="min-h-screen bg-[#eefdf9] px-4 py-10 text-center text-sm font-semibold text-[#0f766e]">Đang tải lịch sử giải ngân...</main>}>
      <DisbursementsPageContent />
    </Suspense>
  );
}
