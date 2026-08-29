"use client";

// =============================================================================

// NonDashboardPanel cho System Admin Page

// Clone from: FE/app/components/regulatoryBodies/tailwind/NonDashboardPanel.tsx

// Mục đích: Container chứa tất cả các panel không thuộc dashboard — cho trang Admin

// =============================================================================

import { useState, useCallback, useEffect } from "react";

import SybilManagementPanel from "./SybilManagementPanel";
import SystemErrorLogPanel from "./SystemErrorLogPanel";
import CommitteeSeatsPanel from "./CommitteeSeatsPanel";

import { fetchApi, buildApiUrl } from "@/app/utils/apiClient";

import { readAuthSession } from "@/app/utils/authSession";
import IpfsEvidencePreviewCard from "../../common/IpfsEvidencePreviewCard";

import type { PageKey, ToastItem, UrgentRequestItem } from "./types";

/** Interface mô tả cấu trúc lỗi API trả về từ backend. Dùng trong catch block để trích xuất message lỗi thay vì hardcode fallback. */

interface ApiErrorResponse {
  success: false;

  message: string;

  errorCode: string;

  details?: { field: string; message: string }[];

  correlationId?: string | null;

  statusCode?: number;
}

// =============================================================================

// DISBURSEMENT PANEL — dùng real API từ backend

// =============================================================================

/** Chuẩn hóa deadline text từ timestamp để hiển thị trên bảng giải ngân. */

function normalizeDeadlineText(deadlineTimestamp: number): string {
  const now = Date.now();

  const diffMs = deadlineTimestamp - now;

  if (diffMs <= 0) return "Đã quá hạn";

  const diffSeconds = Math.floor(diffMs / 1000);

  if (diffSeconds < 60) return `${diffSeconds} giây`;

  const diffMinutes = Math.floor(diffSeconds / 60);

  if (diffMinutes < 60) return `${diffMinutes} phút`;

  const diffHours = Math.floor(diffMinutes / 60);

  if (diffHours < 24) return `${diffHours} giờ`;

  const diffDays = Math.floor(diffHours / 24);

  return `${diffDays} ngày`;
}

/** Xác định mức ưu tiên deadline từ timestamp để hiển thị màu sắc phù hợp. */

function normalizeDeadlineLevel(
  deadlineTimestamp: number,
): "urgent" | "normal" | "ok" {
  const now = Date.now();

  const diffMs = deadlineTimestamp - now;

  if (diffMs <= 0) return "ok";

  if (diffMs <= 60 * 60 * 1000) return "urgent"; // Dưới 1 giờ: khẩn cấp

  if (diffMs <= 24 * 60 * 60 * 1000) return "normal"; // Dưới 24 giờ: bình thường

  return "ok";
}

/** Hàm chuẩn hóa trạng thái chữ ký. Mục đích: hiển thị đúng tiến độ chữ ký theo ngưỡng động FR7 từ backend. */
function normalizeSignatureState(currentSignatures: number, requiredSignatures: number): string {
  const safeRequiredSignatures = Math.max(1, requiredSignatures);
  const safeCurrentSignatures = Math.min(Math.max(0, currentSignatures), safeRequiredSignatures);
  return `${safeCurrentSignatures}/${safeRequiredSignatures}`;
}

type DisbursementPanelProps = {
  onPushToast?: (t: Omit<ToastItem, "id">) => void;

  onOpenDrawer?: (urgentRequestItem: UrgentRequestItem) => void;
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
  requestMode?: "NORMAL" | "EMERGENCY";
};

/** Hàm tách số chữ ký đã có và tổng chữ ký cần có để hiển thị đúng ngưỡng động FR7. */
function getSignatureProgress(signatureState: string): { signedCount: number; totalCount: number } {
  const [signedCountText, totalCountText] = signatureState.split("/");
  const signedCount = Number(signedCountText);
  const totalCount = Number(totalCountText);

  // Chặn dữ liệu sai định dạng để UI không vỡ khi backend trả giá trị bất thường.
  if (!Number.isFinite(signedCount) || !Number.isFinite(totalCount) || totalCount <= 0) {
    return { signedCount: 0, totalCount: 3 };
  }

  return { signedCount, totalCount };
}

function DisbursementPanel({
  onPushToast,
  onOpenDrawer,
}: DisbursementPanelProps) {
  const [disbursementList, setDisbursementList] = useState<UrgentRequestItem[]>(
    [],
  );


  const [loading, setLoading] = useState(true);

  const [error, setError] = useState(false);

  /** Hàm gọi API lấy danh sách yêu cầu giải ngân đang chờ ký. */

  const loadDisbursementList = useCallback(async () => {
    setLoading(true);

    setError(false);

    try {
      const session = readAuthSession();

      const response = await fetchApi<{
        requests: DisbursementSummaryItem[];
      }>(buildApiUrl("/api/disbursement/requests"), {
        headers: { Authorization: `Bearer ${session.accessToken}` },
      });

      const rawRequests = response.data?.requests ?? [];


      setDisbursementList(
        rawRequests.map((r) => ({
          id: r.id,

          projectName: r.projectName,

          organizationName: r.organizationName,

          amountText: new Intl.NumberFormat("vi-VN").format(r.amount) + "₫",

          signatureState: normalizeSignatureState(r.currentSignatures, r.requiredSignatures),

          deadlineText: normalizeDeadlineText(r.deadlineTimestamp),

          deadlineLevel: normalizeDeadlineLevel(r.deadlineTimestamp),

          usagePurpose: r.usagePurpose,

          ipfsCid: r.ipfsCid,

          fileName: r.fileName,
        })),
      );
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);


  useEffect(() => {
    loadDisbursementList();
  }, [loadDisbursementList]);

  const handleApprove = (id: string) => {
    setDisbursementList((prev) => prev.filter((r) => r.id !== id));

    onPushToast?.({
      titleText: "Ký duyệt thành công",
      bodyText: `Đã ký duyệt yêu cầu ${id}`,
      tone: "success",
    });
  };

  const handleReject = (id: string) => {
    setDisbursementList((prev) => prev.filter((r) => r.id !== id));

    onPushToast?.({
      titleText: "Từ chối yêu cầu",
      bodyText: `Đã từ chối yêu cầu ${id}`,
      tone: "warning",
    });
  };

  const getDeadlineClass = (t: "urgent" | "normal" | "ok") =>
    t === "urgent"
      ? "border-red-200 bg-red-50 text-red-700"
      : t === "normal"
        ? "border-amber-200 bg-amber-50 text-amber-700"
        : "border-emerald-200 bg-emerald-50 text-emerald-700";

  return (
    <div className="space-y-4">
      {/* Header */}

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-emerald-900/15 bg-white px-5 py-4">
        <div>
          <h2 className="text-lg font-bold text-slate-900">Yêu cầu giải ngân</h2>
          <p className="mt-1 text-xs text-slate-500">Chỉ hiển thị các yêu cầu giải ngân đang chờ ký duyệt từ backend</p>
        </div>

        <button
          type="button"
          onClick={() => loadDisbursementList()}
          className="rounded-lg border border-emerald-900/15 px-3 py-2 text-xs font-semibold text-[#0E7C6B] transition hover:bg-[#0E7C6B] hover:text-white"
        >
          Làm mới
        </button>
      </div>

      <div className="overflow-hidden rounded-xl border border-emerald-900/15 bg-white">
        <table className="min-w-full text-left text-xs">
          <thead className="bg-slate-50 text-[10px] uppercase tracking-[0.08em] text-slate-500">
            <tr>
              <th className="px-5 py-2.5 font-semibold">Mã yêu cầu</th>

              <th className="px-5 py-2.5 font-semibold">Dự án / Tổ chức</th>

              <th className="px-5 py-2.5 font-semibold">Số tiền</th>

              <th className="px-5 py-2.5 font-semibold">Chữ ký</th>

              <th className="px-5 py-2.5 font-semibold">Hạn xử lý</th>

              <th className="px-5 py-2.5 font-semibold text-right">Hành động</th>
            </tr>
          </thead>

          <tbody>
            {loading ? (
              Array.from({ length: 3 }).map((_, idx) => (
                <tr key={idx} className="border-t border-slate-100">
                  <td className="px-5 py-3">
                    <div className="h-4 w-20 animate-pulse rounded bg-slate-200" />
                  </td>

                  <td className="px-5 py-3">
                    <div className="h-4 w-36 animate-pulse rounded bg-slate-200" />
                  </td>

                  <td className="px-5 py-3">
                    <div className="h-4 w-24 animate-pulse rounded bg-slate-200" />
                  </td>

                  <td className="px-5 py-3">
                    <div className="h-4 w-12 animate-pulse rounded bg-slate-200" />
                  </td>

                  <td className="px-5 py-3">
                    <div className="h-4 w-16 animate-pulse rounded bg-slate-200" />
                  </td>

                  <td className="px-5 py-3">
                    <div className="h-7 w-16 animate-pulse rounded bg-slate-200" />
                  </td>
                </tr>
              ))
            ) : error ? (
              <tr>
                <td colSpan={6} className="px-5 py-12 text-center">
                  <div className="flex flex-col items-center gap-3">
                    <svg
                      className="text-red-400"
                      width="32"
                      height="32"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"
                      />
                    </svg>

                    <p className="text-sm font-semibold text-red-700">
                      Không thể tải dữ liệu giải ngân
                    </p>

                    <button
                      type="button"
                      onClick={() => loadDisbursementList()}
                      className="rounded-lg bg-red-600 px-4 py-2 text-xs font-bold text-white hover:bg-red-700"
                    >
                      Thử lại
                    </button>
                  </div>
                </td>
              </tr>
            ) : disbursementList.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  className="px-5 py-12 text-center text-xs text-slate-500"
                >
                  Không có yêu cầu giải ngân nào đang chờ ký duyệt.
                </td>
              </tr>
            ) : (
              disbursementList.map((r, i) => (
                <tr
                  key={r.id}
                  className={`border-t border-slate-100 ${i % 2 === 0 ? "bg-white" : "bg-slate-50/50"}`}
                >
                  <td className="px-5 py-3 font-mono text-xs font-semibold text-cyan-700">
                    {r.id}
                  </td>

                  <td className="px-5 py-3 align-middle">
                    <p className="text-[13px] font-semibold leading-5 text-slate-900">{r.projectName}</p>
                    <p className="mt-0.5 text-[12px] leading-4 text-slate-500">{r.organizationName}</p>
                  </td>

                  <td className="px-5 py-3 font-mono text-xs font-semibold text-slate-900">
                    {r.amountText}
                  </td>

                  <td className="px-5 py-3">
                    <div className="flex items-center gap-1.5">
                      {Array.from({ length: getSignatureProgress(r.signatureState).totalCount }).map((_, dotIndex) => {
                        const signatureProgress = getSignatureProgress(r.signatureState);
                        const isSigned = dotIndex < signatureProgress.signedCount;

                        return (
                          <div
                            key={dotIndex}
                            className={`h-2.5 w-2.5 rounded-full ${isSigned ? "bg-[#0E7C6B]" : "bg-slate-200"}`}
                          />
                        );
                      })}

                      <span className="ml-1 font-mono text-[10px] text-slate-500">
                        {r.signatureState}
                      </span>
                    </div>
                  </td>

                  <td className="px-5 py-3">
                    <span
                      className={`inline-flex rounded-md border px-2.5 py-1 text-[11px] font-semibold ${getDeadlineClass(r.deadlineLevel)}`}
                    >
                      {r.deadlineText}
                    </span>
                  </td>

                  <td className="px-5 py-3 text-right">
                    <button
                      type="button"
                      onClick={() => {
                        onOpenDrawer?.(r);
                      }}
                      className="rounded-lg border border-emerald-900/15 px-3 py-1.5 text-[11px] font-semibold text-[#0E7C6B] transition hover:bg-[#0E7C6B] hover:text-white"
                    >
                      Xem &amp; Ký
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// =============================================================================

// KYC PANEL (REAL API — chuẩn regulatory-bodies)

// =============================================================================

type KycSubmissionFileItem = {
  cid: string;

  fileName: string;

  mimeType: string;

  fileSize: number;

  documentType: string;
};

type KycSubmissionItem = {
  submissionId: string;

  organizationId: string;

  version: number;

  status: string;

  submittedAt: string;

  rejectionReason: string | null;

  organizationName: string;

  legalRegistrationNumber: string;

  officialWebsite: string | null;

  organizationDescription: string;

  files: KycSubmissionFileItem[];
};

/** Hàm định dạng byte sang chuỗi dung lượng tài liệu để hiển thị danh sách dễ đọc. */

function formatFileSize(fileSizeInBytes: number): string {
  if (fileSizeInBytes < 1024) return `${fileSizeInBytes} B`;

  if (fileSizeInBytes < 1024 * 1024)
    return `${(fileSizeInBytes / 1024).toFixed(1)} KB`;

  return `${(fileSizeInBytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** Hàm định dạng thời gian nộp KYC theo locale tiếng Việt. */

function formatSubmissionTime(submittedAt: string): string {
  return new Date(submittedAt).toLocaleString("vi-VN");
}

/** Hàm chuẩn hóa nhãn loại tài liệu để người dùng dễ hiểu hơn. */

function resolveDocumentTypeLabel(documentType: string): string {
  if (documentType === "LEGAL_DOCUMENT") return "Giấy tờ pháp lý";

  return documentType;
}

function KycPanel() {
  const [isLoading, setIsLoading] = useState(false);

  const [errorMessage, setErrorMessage] = useState("");

  const [successMessage, setSuccessMessage] = useState("");

  const [submissionList, setSubmissionList] = useState<KycSubmissionItem[]>([]);

  const [selectedSubmissionId, setSelectedSubmissionId] = useState("");

  const [rejectReason, setRejectReason] = useState("");

  const [isRejectFormVisible, setIsRejectFormVisible] = useState(false);

  const [isSubmittingReview, setIsSubmittingReview] = useState(false);

  const [isApproveConfirmModalVisible, setIsApproveConfirmModalVisible] =
    useState(false);

  const selectedSubmission =
    submissionList.find((s) => s.submissionId === selectedSubmissionId) || null;

  /** Hàm gọi API lấy danh sách hồ sơ KYC chờ duyệt — chuẩn regulatory-bodies. */

  const loadPendingSubmissionList = useCallback(async () => {
    setIsLoading(true);

    setErrorMessage("");

    try {
      const session = readAuthSession();

      const response = await fetchApi<{ submissions: unknown[] }>(
        buildApiUrl("/auth/organization/kyc-submissions/pending"),

        { headers: { Authorization: `Bearer ${session.accessToken}` } },
      );

      // Backend hiện trả payload dạng { submissions }, trong khi fetchApi cũng hỗ trợ dạng chuẩn { data }.
      const responsePayload = (response.data ?? response) as {
        submissions?: unknown[];
      };

      const normalized = (responsePayload.submissions ?? []).map((s: any) => ({
        ...s,

        organizationName: s.organizationName || s.organizationId,

        legalRegistrationNumber: s.legalRegistrationNumber || "Chưa cập nhật",

        officialWebsite: s.officialWebsite || null,

        organizationDescription:
          s.organizationDescription || "Chưa cập nhật mô tả tổ chức.",

        files: s.files ?? [],
      })) as KycSubmissionItem[];

      setSubmissionList(normalized);

      setSelectedSubmissionId((prev) => {
        const hasPrev = normalized.some((s) => s.submissionId === prev);

        return hasPrev ? prev : normalized[0]?.submissionId || "";
      });
    } catch (err) {
      const apiError = err as ApiErrorResponse;

      setErrorMessage(apiError.message || "Không thể tải danh sách hồ sơ KYC.");
    } finally {
      setIsLoading(false);
    }
  }, []);

  /** Hàm gửi hành động duyệt KYC — PATCH với action + rejectionReason. */

  const submitKycReview = useCallback(
    async (action: "approve" | "reject") => {
      if (!selectedSubmission) return;

      if (action === "reject" && rejectReason.trim().length === 0) {
        setErrorMessage("Vui lòng nhập lý do từ chối.");

        return;
      }

      setIsSubmittingReview(true);

      setErrorMessage("");

      setSuccessMessage("");

      try {
        const session = readAuthSession();

        const responseData = await fetchApi(
          buildApiUrl(
            `/auth/organization/kyc-submissions/${selectedSubmission.submissionId}/review`,
          ),

          {
            method: "PATCH",

            headers: {
              "Content-Type": "application/json",

              Authorization: `Bearer ${session.accessToken}`,
            },

            body: JSON.stringify({
              action,

              rejectionReason:
                action === "reject" ? rejectReason.trim() : undefined,
            }),
          },
        );

        if (action === "approve") {
          const accountUpdate = (responseData as any)?.accountUpdate;

          if (accountUpdate?.updatedRole !== "organizations") {
            throw new Error(
              "Backend chưa xác nhận cập nhật role organizations.",
            );
          }
        }

        setRejectReason("");

        setIsRejectFormVisible(false);

        setSuccessMessage(
          action === "approve"
            ? "Phê duyệt thành công."
            : "Từ chối thành công.",
        );

        await loadPendingSubmissionList();
      } catch (err) {
        setErrorMessage(
          err instanceof Error ? err.message : "Cập nhật trạng thái thất bại.",
        );
      } finally {
        setIsSubmittingReview(false);
      }
    },
    [selectedSubmission, rejectReason, loadPendingSubmissionList],
  );

  useEffect(() => {
    loadPendingSubmissionList();
  }, [loadPendingSubmissionList]);

  return (
    <div className="space-y-4">
      <div className="overflow-hidden rounded-xl border border-emerald-900/15 bg-white px-6 py-4">
        <h2 className="text-sm font-bold text-slate-800">Duyệt Hồ sơ KYC</h2>

        <p className="mt-0.5 text-xs text-slate-500">
          Danh sách hồ sơ chờ duyệt
        </p>
      </div>

      {errorMessage ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-xs text-red-700">
          {errorMessage}
        </div>
      ) : null}

      {successMessage ? (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-xs text-emerald-700">
          {successMessage}
        </div>
      ) : null}

      <div className="grid gap-4 overflow-hidden rounded-xl border border-emerald-900/15 bg-white p-4 lg:grid-cols-[320px_1fr]">
        {/* Left: list */}

        <div className="max-h-[620px] overflow-y-auto border-r border-slate-100 pr-3">
          {isLoading ? (
            <p className="text-xs text-slate-500">Đang tải hồ sơ...</p>
          ) : null}

          {!isLoading && submissionList.length === 0 ? (
            <p className="text-xs text-slate-500">Không có hồ sơ chờ duyệt.</p>
          ) : null}

          {submissionList.map((s) => (
            <button
              key={s.submissionId}
              type="button"
              onClick={() => setSelectedSubmissionId(s.submissionId)}
              className={`mb-2 w-full rounded-lg border px-3 py-2 text-left ${selectedSubmissionId === s.submissionId ? "border-cyan-500 bg-cyan-50" : "border-slate-200 bg-white"}`}
            >
              <p className="text-xs font-semibold text-slate-900">
                {s.organizationName}
              </p>

              <p className="mt-1 font-mono text-[10px] text-slate-500">
                v{s.version} · {s.submissionId.slice(0, 8)}...
              </p>
            </button>
          ))}
        </div>

        {/* Right: detail */}

        <div>
          {selectedSubmission ? (
            <div className="space-y-4">
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                <h3 className="text-sm font-bold text-slate-900">
                  {selectedSubmission.organizationName} · Phiên bản v
                  {selectedSubmission.version}
                </h3>

                <div className="mt-3 grid gap-2 text-xs text-slate-700 sm:grid-cols-2">
                  <p>
                    <span className="font-semibold">Mã hồ sơ:</span>{" "}
                    {selectedSubmission.submissionId}
                  </p>

                  <p>
                    <span className="font-semibold">MST:</span>{" "}
                    {selectedSubmission.legalRegistrationNumber}
                  </p>

                  <p className="sm:col-span-2">
                    <span className="font-semibold">Website:</span>{" "}
                    {selectedSubmission.officialWebsite || "Chưa cập nhật"}
                  </p>

                  <p className="sm:col-span-2">
                    <span className="font-semibold">Mô tả:</span>{" "}
                    {selectedSubmission.organizationDescription}
                  </p>

                  <p>
                    <span className="font-semibold">Nộp lúc:</span>{" "}
                    {formatSubmissionTime(selectedSubmission.submittedAt)}
                  </p>
                </div>
              </div>

              <div className="rounded-lg border border-slate-200 p-3">
                <p className="mb-3 text-xs font-semibold text-slate-800">
                  Tài liệu KYC (CID/IPFS)
                </p>

                <div className="space-y-4">
                    {selectedSubmission.files.map((fileItem, fi) => (
                      <IpfsEvidencePreviewCard
                        key={`${selectedSubmission.submissionId}-${fi}`}
                        cid={fileItem.cid}
                        fileName={`Tài liệu #${fi}: ${fileItem.cid}`}
                        documentTypeLabel={resolveDocumentTypeLabel(fileItem.documentType)}
                        mimeType={fileItem.mimeType}
                        fileSizeLabel={formatFileSize(fileItem.fileSize)}
                        compact={true}
                      />
                    ))}
                  </div>
              </div>

              {isRejectFormVisible ? (
                <>
                  <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3">
                    <label className="block text-xs font-semibold text-amber-800">
                      Lý do từ chối (bắt buộc khi từ chối)
                    </label>

                    <textarea
                      value={rejectReason}
                      onChange={(e) => setRejectReason(e.target.value)}
                      rows={3}
                      className="w-full rounded border border-amber-200 px-2 py-1 text-xs outline-none"
                      placeholder="Nhập lý do từ chối..."
                    />
                  </div>

                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={isSubmittingReview}
                      onClick={() => submitKycReview("reject")}
                      className="rounded bg-red-600 px-3 py-2 text-xs font-bold text-white disabled:opacity-50"
                    >
                      Xác nhận từ chối
                    </button>

                    <button
                      type="button"
                      disabled={isSubmittingReview}
                      onClick={() => {
                        setIsRejectFormVisible(false);
                        setRejectReason("");
                      }}
                      className="rounded border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                    >
                      Hủy
                    </button>
                  </div>
                </>
              ) : (
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={isSubmittingReview}
                    onClick={() => setIsRejectFormVisible(true)}
                    className="rounded bg-red-600 px-3 py-2 text-xs font-bold text-white disabled:opacity-50"
                  >
                    Từ chối
                  </button>

                  <button
                    type="button"
                    disabled={isSubmittingReview}
                    onClick={() => {
                      setIsApproveConfirmModalVisible(true);
                    }}
                    className="rounded bg-emerald-600 px-3 py-2 text-xs font-bold text-white disabled:opacity-50"
                  >
                    Chấp nhận
                  </button>
                </div>
              )}
            </div>
          ) : (
            <p className="text-xs text-slate-500">
              Chọn hồ sơ để xem chi tiết.
            </p>
          )}
        </div>
      </div>

      {isApproveConfirmModalVisible && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4">
          <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl">
            <h3 className="text-base font-bold text-slate-900">
              Xác nhận phê duyệt KYC
            </h3>

            <p className="mt-2 text-sm text-slate-600">
              Bạn có chắc chắn muốn phê duyệt hồ sơ này?
            </p>

            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                disabled={isSubmittingReview}
                onClick={() => setIsApproveConfirmModalVisible(false)}
                className="rounded border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                Hủy
              </button>

              <button
                type="button"
                disabled={isSubmittingReview}
                onClick={async () => {
                  setIsApproveConfirmModalVisible(false);
                  await submitKycReview("approve");
                }}
                className="rounded bg-emerald-600 px-3 py-2 text-xs font-bold text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                Chắc chắn
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// =============================================================================

// PROJECT REVIEW PANEL (REAL API — chuẩn regulatory-bodies)

// =============================================================================

// =============================================================================

// BANK ACCOUNT APPROVAL PANEL (REAL API — chuẩn regulatory-bodies)

// =============================================================================

type BankAccountApprovalItem = {
  submissionId: string;

  organizationId: string;

  organizationName: string;

  status: string;

  submittedAt: string;

  beneficiaryBankAccount: {
    bankName: string;

    bankAccountNumber: string;

    accountHolderName: string;

    branchName: string | null;
  };
};

/** Hàm che bớt số tài khoản để hiển thị an toàn mà vẫn dễ nhận diện. */

function maskBankAccountNumber(bankAccountNumber: string): string {
  if (bankAccountNumber.length <= 4) return bankAccountNumber;

  return `••••••${bankAccountNumber.slice(-4)}`;
}

function BankAccountApprovalPanel() {
  const [isLoading, setIsLoading] = useState(false);

  const [isSubmittingReview, setIsSubmittingReview] = useState(false);

  const [errorMessage, setErrorMessage] = useState("");

  const [successMessage, setSuccessMessage] = useState("");

  const [bankAccountApprovalList, setBankAccountApprovalList] = useState<
    BankAccountApprovalItem[]
  >([]);

  const [selectedSubmissionId, setSelectedSubmissionId] = useState("");

  const [rejectReason, setRejectReason] = useState("");

  const [isApproveConfirmModalVisible, setIsApproveConfirmModalVisible] =
    useState(false);

  const selectedBankAccount =
    bankAccountApprovalList.find(
      (b) => b.submissionId === selectedSubmissionId,
    ) || null;

  /** Hàm tải danh sách tài khoản ngân hàng chờ duyệt — dùng KYC endpoint lọc beneficiaryBankAccount. */

  const loadPendingBankAccountList = useCallback(async () => {
    setIsLoading(true);

    setErrorMessage("");

    try {
      const session = readAuthSession();

      const response = (await fetchApi<{ submissions: unknown[] }>(
        buildApiUrl("/auth/organization/kyc-submissions/pending"),

        { headers: { Authorization: `Bearer ${session.accessToken}` } },
      )) as unknown as { data?: { submissions?: unknown[] }; submissions?: unknown[] };

      // Ghi chú logic phức tạp: endpoint pending hiện trả trực tiếp { submissions },
      // nhưng một số API mới dùng envelope { data }, nên cần hỗ trợ cả hai để Admin không mất danh sách chờ duyệt.
      const pendingSubmissionList =
        response.data?.submissions ?? response.submissions ?? [];

      const normalized = pendingSubmissionList

        .filter(
          (s: any) => "beneficiaryBankAccount" in s && s.beneficiaryBankAccount,
        )

        .map((s: any) => ({
          submissionId: s.submissionId ?? "",

          organizationId: s.organizationId ?? "",

          organizationName: s.organizationName ?? "Chưa cập nhật",

          status: s.status ?? "PENDING_REVIEW",

          submittedAt: s.submittedAt ?? "",

          beneficiaryBankAccount: {
            bankName: s.beneficiaryBankAccount?.bankName ?? "Chưa cập nhật",

            bankAccountNumber:
              s.beneficiaryBankAccount?.bankAccountNumber ?? "Chưa cập nhật",

            accountHolderName:
              s.beneficiaryBankAccount?.accountHolderName ?? "Chưa cập nhật",

            branchName: s.beneficiaryBankAccount?.branchName ?? null,
          },
        })) as BankAccountApprovalItem[];

      setBankAccountApprovalList(normalized);

      setSelectedSubmissionId((prev) => {
        const hasPrev = normalized.some((b) => b.submissionId === prev);

        return hasPrev ? prev : normalized[0]?.submissionId || "";
      });
    } catch (err) {
      const apiError = err as ApiErrorResponse;

      setErrorMessage(
        apiError.message ||
          "Không thể tải danh sách tài khoản ngân hàng chờ duyệt.",
      );
    } finally {
      setIsLoading(false);
    }
  }, []);

  /** Hàm gửi hành động duyệt tài khoản ngân hàng — PATCH /auth/organization/kyc-submissions/:id/review. */

  const submitBankAccountReview = useCallback(
    async (action: "approve" | "reject") => {
      if (!selectedBankAccount) return;

      if (action === "reject" && rejectReason.trim().length === 0) {
        setErrorMessage("Vui lòng nhập lý do từ chối.");

        return;
      }

      setIsSubmittingReview(true);

      setErrorMessage("");

      setSuccessMessage("");

      try {
        const session = readAuthSession();

        await fetchApi(
          buildApiUrl(
            `/auth/organization/kyc-submissions/${selectedBankAccount.submissionId}/review`,
          ),

          {
            method: "PATCH",

            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${session.accessToken}`,
            },

            body: JSON.stringify({
              action,

              rejectionReason:
                action === "reject" ? rejectReason.trim() : undefined,
            }),
          },
        );

        setRejectReason("");

        setSuccessMessage(
          action === "approve"
            ? "Phê duyệt tài khoản thành công."
            : "Từ chối tài khoản thành công.",
        );

        await loadPendingBankAccountList();
      } catch {
        setErrorMessage("Cập nhật trạng thái tài khoản thất bại.");
      } finally {
        setIsSubmittingReview(false);
      }
    },
    [selectedBankAccount, rejectReason, loadPendingBankAccountList],
  );

  useEffect(() => {
    loadPendingBankAccountList();
  }, [loadPendingBankAccountList]);

  return (
    <div className="space-y-4">
      <div className="overflow-hidden rounded-xl border border-emerald-900/15 bg-white px-6 py-4">
        <h2 className="text-sm font-bold text-slate-800">
          Duyệt tài khoản ngân hàng
        </h2>

        <p className="mt-0.5 text-xs text-slate-500">
          Danh sách tài khoản ngân hàng thụ hưởng đang chờ admin
        </p>
      </div>

      {errorMessage ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-xs text-red-700">
          {errorMessage}
        </div>
      ) : null}

      {successMessage ? (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-xs text-emerald-700">
          {successMessage}
        </div>
      ) : null}

      <div className="grid gap-4 overflow-hidden rounded-xl border border-emerald-900/15 bg-white p-4 lg:grid-cols-[300px_1fr]">
        {/* Left: list */}

        <div className="max-h-[520px] overflow-y-auto border-r border-slate-100 pr-3">
          {isLoading ? (
            <p className="text-xs text-slate-500">Đang tải...</p>
          ) : null}

          {!isLoading && bankAccountApprovalList.length === 0 ? (
            <p className="text-xs text-slate-500">
              Không có tài khoản chờ duyệt.
            </p>
          ) : null}

          {bankAccountApprovalList.map((b) => (
            <button
              key={b.submissionId}
              type="button"
              onClick={() => setSelectedSubmissionId(b.submissionId)}
              className={`mb-2 w-full rounded-lg border px-3 py-2 text-left ${selectedSubmissionId === b.submissionId ? "border-cyan-500 bg-cyan-50" : "border-slate-200 bg-white"}`}
            >
              <p className="text-xs font-semibold text-slate-900">
                {b.organizationName}
              </p>

              <p className="mt-1 text-[10px] text-slate-500">
                {b.beneficiaryBankAccount.bankName} ·{" "}
                {maskBankAccountNumber(
                  b.beneficiaryBankAccount.bankAccountNumber,
                )}
              </p>
            </button>
          ))}
        </div>

        {/* Right: detail */}

        <div>
          {selectedBankAccount ? (
            <div className="space-y-4">
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                <h3 className="text-sm font-bold text-slate-900">
                  {selectedBankAccount.organizationName}
                </h3>

                <div className="mt-3 grid gap-2 text-xs text-slate-700 sm:grid-cols-2">
                  <p>
                    <span className="font-semibold">Mã hồ sơ:</span>{" "}
                    {selectedBankAccount.submissionId}
                  </p>

                  <p>
                    <span className="font-semibold">Tên ngân hàng:</span>{" "}
                    {selectedBankAccount.beneficiaryBankAccount.bankName}
                  </p>

                  <p>
                    <span className="font-semibold">Số tài khoản:</span>{" "}
                    {
                      selectedBankAccount.beneficiaryBankAccount
                        .bankAccountNumber
                    }
                  </p>

                  <p>
                    <span className="font-semibold">Tên chủ tài khoản:</span>{" "}
                    {
                      selectedBankAccount.beneficiaryBankAccount
                        .accountHolderName
                    }
                  </p>

                  {selectedBankAccount.beneficiaryBankAccount.branchName && (
                    <p>
                      <span className="font-semibold">Chi nhánh:</span>{" "}
                      {selectedBankAccount.beneficiaryBankAccount.branchName}
                    </p>
                  )}

                  <p>
                    <span className="font-semibold">Nộp lúc:</span>{" "}
                    {new Date(selectedBankAccount.submittedAt).toLocaleString(
                      "vi-VN",
                    )}
                  </p>
                </div>
              </div>

              <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3">
                <label className="block text-xs font-semibold text-amber-800">
                  Lý do từ chối (bắt buộc khi từ chối)
                </label>

                <textarea
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                  rows={3}
                  className="w-full rounded border border-amber-200 px-2 py-1 text-xs outline-none"
                  placeholder="Nhập lý do từ chối..."
                />
              </div>

              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={isSubmittingReview}
                  onClick={() => submitBankAccountReview("reject")}
                  className="rounded bg-red-600 px-3 py-2 text-xs font-bold text-white disabled:opacity-50"
                >
                  Từ chối
                </button>

                <button
                  type="button"
                  disabled={isSubmittingReview}
                  onClick={() => setIsApproveConfirmModalVisible(true)}
                  className="rounded bg-emerald-600 px-3 py-2 text-xs font-bold text-white disabled:opacity-50"
                >
                  Chấp nhận
                </button>
              </div>
            </div>
          ) : (
            <p className="text-xs text-slate-500">
              Chọn tài khoản để xem chi tiết.
            </p>
          )}
        </div>
      </div>

      {isApproveConfirmModalVisible && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4">
          <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl">
            <h3 className="text-base font-bold text-slate-900">
              Xác nhận phê duyệt tài khoản
            </h3>

            <p className="mt-2 text-sm text-slate-600">
              Bạn có chắc chắn muốn phê duyệt tài khoản ngân hàng này?
            </p>

            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                disabled={isSubmittingReview}
                onClick={() => setIsApproveConfirmModalVisible(false)}
                className="rounded border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                Hủy
              </button>

              <button
                type="button"
                disabled={isSubmittingReview}
                onClick={async () => {
                  setIsApproveConfirmModalVisible(false);
                  await submitBankAccountReview("approve");
                }}
                className="rounded bg-emerald-600 px-3 py-2 text-xs font-bold text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                Chắc chắn
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// =============================================================================

// REPORT PANEL

// =============================================================================

function ReportPanel() {
  return (
    <div className="space-y-4">
      <div className="overflow-hidden rounded-xl border border-emerald-900/15 bg-white px-6 py-4">
        <h2 className="text-sm font-bold text-slate-800">Báo cáo Tuân thủ</h2>

        <p className="mt-0.5 text-xs text-slate-500">
          Xuất báo cáo tuân thủ theo quy định
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {[
          "Báo cáo tháng",
          "Báo cáo quý",
          "Báo cáo năm",
          "Báo cáo tổng hợp",
        ].map((r, i) => (
          <div
            key={r}
            className="overflow-hidden rounded-xl border border-emerald-900/15 bg-white px-5 py-4"
          >
            <p className="font-semibold text-slate-900">{r}</p>

            <p className="mt-0.5 text-xs text-slate-500">
              Báo cáo {["01/2026", "Q1/2026", "2025", "Tổng hợp"][i]}
            </p>

            <button
              type="button"
              className="mt-3 rounded-lg border border-emerald-900/15 px-4 py-2 text-xs font-semibold text-[#0E7C6B] transition hover:bg-[#0E7C6B] hover:text-white"
            >
              Tải xuống
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// =============================================================================

// TRANSPARENCY PANEL

// =============================================================================

function TransparencyPanel() {
  const [query, setQuery] = useState("");

  return (
    <div className="space-y-4">
      <div className="overflow-hidden rounded-xl border border-emerald-900/15 bg-white px-6 py-4">
        <h2 className="text-sm font-bold text-slate-800">Tra cứu Giao dịch</h2>

        <p className="mt-0.5 text-xs text-slate-500">
          Tìm kiếm và xem chi tiết giao dịch trên blockchain
        </p>
      </div>

      <div className="overflow-hidden rounded-xl border border-emerald-900/15 bg-white px-6 py-5">
        <div className="relative">
          <svg
            className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            viewBox="0 0 24 24"
          >
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.35-4.35" />
          </svg>

          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Nhập địa chỉ ví, tx hash..."
            className="h-10 w-full rounded-lg border border-slate-200 bg-white pl-10 pr-4 text-sm text-slate-700 placeholder-slate-400 focus:border-[#1AAE97] focus:outline-none focus:ring-1 focus:ring-[#1AAE97]/30"
          />
        </div>

        <p className="mt-4 text-center text-xs text-slate-400">
          Nhập địa chỉ ví hoặc transaction hash để tra cứu
        </p>
      </div>
    </div>
  );
}

// =============================================================================

// MAIN EXPORT — NON DASHBOARD PANEL

// =============================================================================

export default function NonDashboardPanel({
  activePage,

  onPushToast,

  onOpenDrawer,
}: {
  activePage: PageKey;

  onPushToast?: (t: Omit<ToastItem, "id">) => void;

  onOpenDrawer?: (urgentRequestItem: UrgentRequestItem) => void;
}) {
  switch (activePage) {
    case "kyc":
      return <KycPanel />;

    case "bankAccountApproval":
      return <BankAccountApprovalPanel />;

    case "systemErrorLog":
      return <SystemErrorLogPanel onPushToast={onPushToast} />;

    case "report":
      return <ReportPanel />;

    case "transparency":
      return <TransparencyPanel />;

    case "sybilManagement":
      return <SybilManagementPanel onPushToast={onPushToast} />;

    case "committeeSeats":
      return <CommitteeSeatsPanel />;

    default:
      return null;
  }
}














