'use client';

import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { buildApiUrl, fetchApi, type ApiErrorResponse } from '@/app/utils/apiClient';
import { readAuthSession } from '../../../utils/authSession';
import IpfsEvidencePreviewCard from '../../common/IpfsEvidencePreviewCard';

type FoundationKycFile = {
  cid: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  documentType: string;
};

type FoundationKycStatus = 'PENDING_REVIEW' | 'APPROVED' | 'REJECTED';

type FoundationKycSubmission = {
  submissionId: string;
  organizationId: string;
  organizationName: string;
  legalRegistrationNumber: string;
  taxIdentificationNumber: string;
  officialWebsite: string | null;
  organizationDescription: string;
  version: number;
  submittedAt: string;
  status: FoundationKycStatus;
  canReviewFromThisPanel: boolean;
  files: FoundationKycFile[];
  beneficiaryBankAccount: {
    bankName: string;
    bankAccountNumber: string;
    accountHolderName: string;
    branchName: string | null;
  } | null;
};

/** Xác định hồ sơ pháp nhân đại diện theo category mới hoặc định danh public tương thích dữ liệu cũ. */
function isFoundationSubmission(value: Record<string, unknown>): boolean {
  return value.organizationCategory === 'FOUNDATION'
    || (typeof value.organizationId === 'string' && value.organizationId.startsWith('FOUNDATION:'))
    || value.submittedBy === 'PUBLIC_FOUNDATION_FORM';
}

/** Kiểm tra object động trước khi đọc field từ response review pending. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Chuẩn hóa hồ sơ pháp nhân để luôn hiển thị được bản ghi lịch sử, kể cả dữ liệu cũ thiếu category hoặc tài khoản ngân hàng. */
function normalizeFoundationSubmission(value: unknown): FoundationKycSubmission | null {
  if (!isRecord(value) || typeof value.submissionId !== 'string') return null;
  const status = value.status;
  if (status !== 'PENDING_REVIEW' && status !== 'APPROVED' && status !== 'REJECTED') return null;
  const bankAccount = isRecord(value.beneficiaryBankAccount) ? value.beneficiaryBankAccount : null;
  const hasCompleteBankAccount = Boolean(
    bankAccount
    && typeof bankAccount.bankName === 'string'
    && typeof bankAccount.bankAccountNumber === 'string'
    && typeof bankAccount.accountHolderName === 'string'
  );

  const files = Array.isArray(value.files)
    ? value.files.filter(isRecord).flatMap((fileValue): FoundationKycFile[] => {
        if (
          typeof fileValue.cid !== 'string'
          || typeof fileValue.fileName !== 'string'
          || typeof fileValue.mimeType !== 'string'
          || typeof fileValue.fileSize !== 'number'
          || typeof fileValue.documentType !== 'string'
        ) return [];
        return [{
          cid: fileValue.cid,
          fileName: fileValue.fileName,
          mimeType: fileValue.mimeType,
          fileSize: fileValue.fileSize,
          documentType: fileValue.documentType
        }];
      })
    : [];

  return {
    submissionId: value.submissionId,
    organizationId: typeof value.organizationId === 'string' ? value.organizationId : '',
    organizationName: typeof value.organizationName === 'string' ? value.organizationName : 'Chưa cập nhật',
    legalRegistrationNumber: typeof value.legalRegistrationNumber === 'string' ? value.legalRegistrationNumber : 'Chưa cập nhật',
    taxIdentificationNumber: typeof value.taxIdentificationNumber === 'string' ? value.taxIdentificationNumber : 'Chưa cập nhật',
    officialWebsite: typeof value.officialWebsite === 'string' ? value.officialWebsite : null,
    organizationDescription: typeof value.organizationDescription === 'string' ? value.organizationDescription : 'Chưa cập nhật mô tả.',
    version: typeof value.version === 'number' ? value.version : 1,
    submittedAt: typeof value.submittedAt === 'string' ? value.submittedAt : '',
    status,
    canReviewFromThisPanel: isFoundationSubmission(value),
    files,
    beneficiaryBankAccount: hasCompleteBankAccount && bankAccount ? {
      bankName: bankAccount.bankName as string,
      bankAccountNumber: bankAccount.bankAccountNumber as string,
      accountHolderName: bankAccount.accountHolderName as string,
      branchName: typeof bankAccount.branchName === 'string' ? bankAccount.branchName : null
    } : null
  };
}

/** Chuyển trạng thái hồ sơ sang nhãn ngắn, dễ hiểu trên giao diện Regulatory. */
function getFoundationStatusLabel(status: FoundationKycStatus): string {
  if (status === 'APPROVED') return 'Đã duyệt';
  if (status === 'REJECTED') return 'Đã từ chối';
  return 'Chờ duyệt';
}

/** Định dạng kích thước file CID để reviewer dễ kiểm tra metadata. */
function formatFileSize(fileSizeInBytes: number): string {
  if (fileSizeInBytes < 1024) return `${fileSizeInBytes} B`;
  if (fileSizeInBytes < 1024 * 1024) return `${(fileSizeInBytes / 1024).toFixed(1)} KB`;
  return `${(fileSizeInBytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** Đọc message an toàn từ error object của fetchApi hoặc Error native. */
function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message;
  if (isRecord(error) && typeof error.message === 'string') return error.message;
  return fallback;
}

/** Panel riêng cho FOUNDATION: approve chỉ ghi nhận trạng thái, tuyệt đối không cấp quyền. */
export default function FoundationKycApprovalPanel({ accessToken: verifiedAccessToken }: { accessToken?: string }): ReactElement {
  const [submissionList, setSubmissionList] = useState<FoundationKycSubmission[]>([]);
  const [selectedSubmissionId, setSelectedSubmissionId] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isSubmittingReview, setIsSubmittingReview] = useState(false);
  const [isApproveConfirmModalVisible, setIsApproveConfirmModalVisible] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [successMessage, setSuccessMessage] = useState('');

  const selectedSubmission = submissionList.find(item => item.submissionId === selectedSubmissionId) || null;

  /** Tải lịch sử hồ sơ pháp nhân đại diện để hiển thị đầy đủ trạng thái xử lý. */
  const loadFoundationKycList = useCallback(async (): Promise<void> => {
    const accessToken = verifiedAccessToken || readAuthSession().accessToken || '';
    if (!accessToken) {
      setErrorMessage('Bạn cần đăng nhập tài khoản cơ quan giám sát để duyệt pháp nhân đại diện.');
      return;
    }

    setIsLoading(true);
    setErrorMessage('');
    try {
      const response = await fetchApi<{ submissions: unknown[] }>(
        buildApiUrl('/auth/organization/kyc-submissions/foundation'),
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      const responsePayload = isRecord(response.data) ? response.data : response as unknown;
      const responseData = isRecord(responsePayload) && Array.isArray(responsePayload.submissions)
        ? responsePayload.submissions
        : [];
      const normalizedList = responseData.flatMap((item): FoundationKycSubmission[] => {
        const normalizedItem = normalizeFoundationSubmission(item);
        return normalizedItem ? [normalizedItem] : [];
      });
      setSubmissionList(normalizedList);
      setSelectedSubmissionId(previousId => normalizedList.some(item => item.submissionId === previousId)
        ? previousId
        : normalizedList[0]?.submissionId || '');
    } catch (error) {
      setErrorMessage(getErrorMessage(error, 'Không thể tải danh sách pháp nhân đại diện.'));
    } finally {
      setIsLoading(false);
    }
  }, [verifiedAccessToken]);

  /** Gửi review FOUNDATION qua endpoint cũ và không kiểm tra accountUpdate vì backend trả null có chủ đích. */
  const submitFoundationReview = useCallback(async (action: 'approve' | 'reject'): Promise<void> => {
    if (!selectedSubmission) return;
    const normalizedRejectReason = rejectReason.trim();
    if (action === 'reject' && !normalizedRejectReason) {
      setErrorMessage('Vui lòng nhập lý do từ chối trước khi xác nhận.');
      return;
    }

    const accessToken = verifiedAccessToken || readAuthSession().accessToken || '';
    if (!accessToken) {
      setErrorMessage('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.');
      return;
    }

    setIsSubmittingReview(true);
    setErrorMessage('');
    setSuccessMessage('');
    try {
      await fetchApi(
        buildApiUrl(`/auth/organization/kyc-submissions/${selectedSubmission.submissionId}/review`),
        {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${accessToken}` },
          body: JSON.stringify({
            action,
            rejectionReason: action === 'reject' ? normalizedRejectReason : undefined
          })
        }
      );
      setSubmissionList(previousList => previousList.map(item => item.submissionId === selectedSubmission.submissionId
        ? { ...item, status: action === 'approve' ? 'APPROVED' : 'REJECTED' }
        : item));
      setRejectReason('');
      setIsApproveConfirmModalVisible(false);
      setSuccessMessage(action === 'approve' ? 'Đã duyệt pháp nhân đại diện.' : 'Đã từ chối hồ sơ pháp nhân đại diện.');
    } catch (error) {
      const apiError = isRecord(error) ? error as Partial<ApiErrorResponse> : null;
      setErrorMessage(apiError?.errorCode === 'FORBIDDEN'
        ? 'Bạn không có quyền thực hiện thao tác này.'
        : getErrorMessage(error, 'Không thể cập nhật trạng thái pháp nhân đại diện.'));
    } finally {
      setIsSubmittingReview(false);
    }
  }, [rejectReason, selectedSubmission, verifiedAccessToken]);

  /** Tải danh sách khi tab FOUNDATION được render. */
  useEffect(() => {
    void loadFoundationKycList();
  }, [loadFoundationKycList]);

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-amber-200 bg-amber-50 px-5 py-4">
        <h2 className="text-lg font-bold text-amber-900">Duyệt pháp nhân đại diện</h2>
        <p className="mt-1 text-xs leading-5 text-amber-800">Kiểm tra thông tin pháp nhân và tài khoản ngân hàng trước khi xác nhận.</p>
      </div>
      {errorMessage ? <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-xs text-red-700">{errorMessage}</div> : null}
      {successMessage ? <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-xs text-emerald-700">{successMessage}</div> : null}

      <div className="grid gap-4 overflow-hidden rounded-xl border border-emerald-900/15 bg-white p-4 lg:grid-cols-[320px_1fr]">
        <div className="max-h-[680px] overflow-y-auto border-r border-slate-100 pr-3">
          {isLoading ? <p className="text-xs text-slate-500">Đang tải danh sách pháp nhân đại diện...</p> : null}
          {!isLoading && submissionList.length === 0 ? <p className="text-xs text-slate-500">Chưa có pháp nhân đại diện để hiển thị.</p> : null}
          {submissionList.map(item => (
            <button key={item.submissionId} type="button" onClick={() => setSelectedSubmissionId(item.submissionId)} className={`mb-2 w-full rounded-lg border px-3 py-2 text-left ${selectedSubmissionId === item.submissionId ? 'border-cyan-500 bg-cyan-50' : 'border-slate-200 bg-white'}`}>
              <div className="flex items-start justify-between gap-2">
                <p className="text-xs font-semibold text-slate-900">{item.organizationName}</p>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${item.status === 'APPROVED' ? 'bg-emerald-100 text-emerald-700' : item.status === 'REJECTED' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'}`}>
                  {getFoundationStatusLabel(item.status)}
                </span>
              </div>
              <p className="mt-1 font-mono text-[10px] text-slate-500">{item.submissionId}</p>
            </button>
          ))}
        </div>

        <div>
          {selectedSubmission ? (
            <div className="space-y-4">
              <section className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                <h3 className="text-sm font-bold text-slate-900">Thông tin pháp nhân · phiên bản v{selectedSubmission.version}</h3>
                <div className="mt-3 grid gap-2 text-xs text-slate-700 sm:grid-cols-2">
                  <p><span className="font-semibold">Tên pháp nhân:</span> {selectedSubmission.organizationName}</p>
                  <p><span className="font-semibold">Số đăng ký:</span> {selectedSubmission.legalRegistrationNumber}</p>
                  <p><span className="font-semibold">Mã số thuế:</span> {selectedSubmission.taxIdentificationNumber}</p>
                  <p><span className="font-semibold">Website:</span> {selectedSubmission.officialWebsite || 'Chưa cập nhật'}</p>
                  <p><span className="font-semibold">Nộp lúc:</span> {selectedSubmission.submittedAt ? new Date(selectedSubmission.submittedAt).toLocaleString('vi-VN') : 'Chưa cập nhật'}</p>
                  <p><span className="font-semibold">Trạng thái:</span> {getFoundationStatusLabel(selectedSubmission.status)}</p>
                  <p className="sm:col-span-2"><span className="font-semibold">Mô tả:</span> {selectedSubmission.organizationDescription}</p>
                </div>
              </section>

              <section className="rounded-lg border border-slate-200 p-3">
                <p className="mb-3 text-xs font-semibold text-slate-800">Tài liệu pháp lý (CID/IPFS)</p>
                <div className="space-y-4">
                  {selectedSubmission.files.map((fileItem, index) => (
                    <IpfsEvidencePreviewCard key={`${selectedSubmission.submissionId}-${index}`} cid={fileItem.cid} fileName={fileItem.fileName} documentTypeLabel="Giấy tờ pháp lý" mimeType={fileItem.mimeType} fileSizeLabel={formatFileSize(fileItem.fileSize)} compact />
                  ))}
                </div>
              </section>

              <section className="rounded-lg border border-cyan-200 bg-cyan-50 p-4">
                <h3 className="text-sm font-bold text-cyan-900">Tài khoản ngân hàng cần xác minh</h3>
                {selectedSubmission.beneficiaryBankAccount ? (
                  <div className="mt-3 grid gap-2 text-xs text-cyan-950 sm:grid-cols-2">
                    <p><span className="font-semibold">Ngân hàng:</span> {selectedSubmission.beneficiaryBankAccount.bankName}</p>
                    <p><span className="font-semibold">Số tài khoản:</span> {selectedSubmission.beneficiaryBankAccount.bankAccountNumber}</p>
                    <p><span className="font-semibold">Chủ tài khoản:</span> {selectedSubmission.beneficiaryBankAccount.accountHolderName}</p>
                    <p><span className="font-semibold">Chi nhánh:</span> {selectedSubmission.beneficiaryBankAccount.branchName || 'Chưa cập nhật'}</p>
                  </div>
                ) : <p className="mt-3 text-xs text-cyan-800">Hồ sơ này chưa có thông tin tài khoản ngân hàng.</p>}
              </section>

              {selectedSubmission.status === 'PENDING_REVIEW' && selectedSubmission.canReviewFromThisPanel ? (
                <div className="space-y-3">
                  <textarea value={rejectReason} onChange={event => setRejectReason(event.target.value)} rows={3} maxLength={500} placeholder="Lý do từ chối (bắt buộc)" className="w-full rounded-lg border border-amber-200 px-3 py-2 text-xs" />
                  <div className="flex flex-wrap gap-2">
                    <button type="button" disabled={isSubmittingReview} onClick={() => void submitFoundationReview('reject')} className="rounded bg-red-600 px-3 py-2 text-xs font-bold text-white disabled:opacity-50">Từ chối</button>
                    <button type="button" disabled={isSubmittingReview} onClick={() => setIsApproveConfirmModalVisible(true)} className="rounded bg-emerald-600 px-3 py-2 text-xs font-bold text-white disabled:opacity-50">Phê duyệt xác minh</button>
                  </div>
                </div>
              ) : <p className="rounded-lg bg-slate-100 px-3 py-2 text-xs text-slate-600">{selectedSubmission.status === 'PENDING_REVIEW' ? 'Hồ sơ này được xử lý tại luồng KYC tương ứng.' : 'Hồ sơ này đã được xử lý.'}</p>}
            </div>
          ) : <p className="text-xs text-slate-500">Chọn một pháp nhân đại diện để xem chi tiết.</p>}
        </div>
      </div>

      {isApproveConfirmModalVisible && selectedSubmission ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 px-4">
          <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl">
            <h3 className="text-base font-bold text-slate-900">Xác nhận duyệt pháp nhân đại diện</h3>
            <p className="mt-2 text-sm leading-6 text-slate-600">Bạn đang xác nhận hồ sơ pháp nhân đại diện và tài khoản ngân hàng nhận tiền của <span className="font-semibold">{selectedSubmission.organizationName}</span>. Vui lòng kiểm tra thông tin trước khi xác nhận.</p>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" disabled={isSubmittingReview} onClick={() => setIsApproveConfirmModalVisible(false)} className="rounded border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700">Hủy</button>
              <button type="button" disabled={isSubmittingReview} onClick={() => void submitFoundationReview('approve')} className="rounded bg-emerald-600 px-3 py-2 text-xs font-bold text-white disabled:opacity-50">Chắc chắn xác minh</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
