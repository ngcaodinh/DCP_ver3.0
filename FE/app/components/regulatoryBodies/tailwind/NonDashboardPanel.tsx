import { useCallback, useEffect, useState } from "react";

import { buildApiUrl, fetchApi } from "@/app/utils/apiClient";

import type { ApiErrorResponse } from "@/app/utils/apiClient";

import { readAuthSession } from "../../../utils/authSession";

import { getPageTitle } from "./helpers";
import IpfsEvidencePreviewCard from "../../common/IpfsEvidencePreviewCard";
import { GeofenceMapLazy } from "@/app/components/oracle/GeofenceMapLazy";

import type { PageKey, UrgentRequestItem } from "./types";

import SybilManagementPanel from "./SybilManagementPanel";
import FoundationKycApprovalPanel from "./FoundationKycApprovalPanel";

type NonDashboardPanelProps = {
  accessToken?: string;

  selectedPageKey: PageKey;

  onOpenDisbursementRequest?: (urgentRequestItem: UrgentRequestItem) => void;

  onPushToast?: (
    titleText: string,
    bodyText: string,
    tone: "success" | "error" | "info",
  ) => void;
};

type VerifiedAccessTokenProps = {
  accessToken?: string;
};

type KycApprovalRateItem = {
  labelText: string;

  valueText: string;

  progressWidthText: string;

  barClassName: string;

  valueClassName: string;
};

type DisbursementTableItem = {
  requestCodeText: string;

  projectNameText: string;

  organizationNameText: string;

  amountText: string;

  createdTimeText: string;

  statusText: string;

  statusClassName: string;

  signatureStateText: string;

  deadlineText: string;

  deadlineLevel: "urgent" | "normal" | "ok";
};

const disbursementMetricItemList = [
  {
    labelText: "Tổng yêu cầu giải ngân",
    valueText: "42",
    toneClassName: "text-cyan-700 bg-cyan-50 border-cyan-100",
  },

  {
    labelText: "Đã phê duyệt (90.5%)",
    valueText: "38",
    toneClassName: "text-emerald-700 bg-emerald-50 border-emerald-100",
  },

  {
    labelText: "Đang chờ ký",
    valueText: "3",
    toneClassName: "text-amber-700 bg-amber-50 border-amber-100",
  },

  {
    labelText: "Bị từ chối",
    valueText: "1",
    toneClassName: "text-red-700 bg-red-50 border-red-100",
  },
];

const monthlyDisbursementItemList = [
  { monthText: "Tháng 1/2026", valueText: "3.6 tỷ", progressWidthText: "72%" },

  { monthText: "Tháng 2/2026", valueText: "2.8 tỷ", progressWidthText: "55%" },

  { monthText: "Tháng 3/2026", valueText: "4.2 tỷ", progressWidthText: "100%" },
];

const recentRequestItemList = [
  {
    requestCodeText: "REQ-2026-0312",
    projectNameText: "Xây trường học Tây Nguyên",
    amountText: "₫450,000,000",
    signatureStatusText: "Đang chờ 2/3 chữ ký",
    toneClassName: "border-amber-200 bg-amber-50 text-amber-800",
  },

  {
    requestCodeText: "REQ-2026-0304",
    projectNameText: "Nước sạch Hà Tĩnh",
    amountText: "₫150,000,000",
    signatureStatusText: "Hạn xử lý 17:30 hôm nay",
    toneClassName: "border-slate-200 bg-slate-50 text-slate-700",
  },
];

const disbursementTableItemList: DisbursementTableItem[] = [
  {
    requestCodeText: "REQ-2026-0312",

    projectNameText: "Xây trường học Tây Nguyên",

    organizationNameText: "Quỹ Thiện Nguyện Việt",

    amountText: "₫450,000,000",

    createdTimeText: "22/03 14:10",

    statusText: "Đang chờ ký",

    statusClassName: "bg-amber-100 text-amber-700",

    signatureStateText: "2/3",

    deadlineText: "Hôm nay",

    deadlineLevel: "urgent",
  },

  {
    requestCodeText: "REQ-2026-0304",

    projectNameText: "Nước sạch Hà Tĩnh",

    organizationNameText: "Hội Nước Sạch Hà Tĩnh",

    amountText: "₫150,000,000",

    createdTimeText: "21/03 16:30",

    statusText: "Đã phê duyệt",

    statusClassName: "bg-emerald-100 text-emerald-700",

    signatureStateText: "3/3",

    deadlineText: "Đúng hạn",

    deadlineLevel: "ok",
  },

  {
    requestCodeText: "REQ-2026-0297",

    projectNameText: "Quỹ học bổng miền núi",

    organizationNameText: "Quỹ Trẻ Em Việt Xanh",

    amountText: "₫85,000,000",

    createdTimeText: "21/03 11:15",

    statusText: "Bị từ chối",

    statusClassName: "bg-red-100 text-red-700",

    signatureStateText: "1/3",

    deadlineText: "Quá hạn",

    deadlineLevel: "normal",
  },
];

/** Hàm chuyển một dòng dữ liệu giải ngân thành kiểu dữ liệu mở drawer dùng chung với tab Tổng quan. */

function buildUrgentRequestItem(
  disbursementTableItem: DisbursementTableItem,
): UrgentRequestItem {
  return {
    id: disbursementTableItem.requestCodeText,

    projectName: disbursementTableItem.projectNameText,

    organizationName: disbursementTableItem.organizationNameText,

    amountText: disbursementTableItem.amountText,

    signatureState: disbursementTableItem.signatureStateText,

    deadlineText: disbursementTableItem.deadlineText,

    deadlineLevel: disbursementTableItem.deadlineLevel,
  };
}

/** Hàm hiển thị card thống kê giá trị giải ngân theo từng tháng bằng progress-bar. */

function MonthlyDisbursementCard() {
  return (
    <div className="overflow-hidden rounded-xl border border-emerald-900/15 bg-white">
      <div className="border-b border-emerald-900/15 px-5 py-3 text-sm font-bold text-slate-900">
        Giá trị giải ngân theo tháng (VNĐ)
      </div>

      <div className="space-y-3 p-5">
        {monthlyDisbursementItemList.map((monthlyDisbursementItem) => (
          <div
            key={monthlyDisbursementItem.monthText}
            className="grid grid-cols-[110px_1fr_auto] items-center gap-2 text-xs"
          >
            <span className="text-slate-700">
              {monthlyDisbursementItem.monthText}
            </span>

            <div className="h-2 rounded-full bg-slate-100">
              <div
                className="h-2 rounded-full bg-gradient-to-r from-[#0E7C6B] to-[#1AAE97]"
                style={{ width: monthlyDisbursementItem.progressWidthText }}
              />
            </div>

            <span className="font-semibold text-slate-800">
              {monthlyDisbursementItem.valueText}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Hàm hiển thị danh sách yêu cầu gần nhất cần ký để ưu tiên xử lý nhanh. */

function RecentRequestCard() {
  return (
    <div className="overflow-hidden rounded-xl border border-emerald-900/15 bg-white">
      <div className="border-b border-emerald-900/15 px-5 py-3 text-sm font-bold text-slate-900">
        Yêu cầu cần ký gần nhất
      </div>

      <div className="space-y-2 p-4">
        {recentRequestItemList.map((recentRequestItem) => (
          <div
            key={recentRequestItem.requestCodeText}
            className={`rounded-lg border p-3 ${recentRequestItem.toneClassName}`}
          >
            <p className="text-xs font-semibold">
              {recentRequestItem.requestCodeText} ·{" "}
              {recentRequestItem.projectNameText}
            </p>

            <p className="mt-1 text-xs">
              {recentRequestItem.amountText} ·{" "}
              {recentRequestItem.signatureStatusText}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Hàm hiển thị panel Ký duyệt Giải ngân bám theo bố cục page-disbursement của file mẫu. */

function DisbursementPanel({
  onOpenDisbursementRequest,
}: {
  onOpenDisbursementRequest?: (urgentRequestItem: UrgentRequestItem) => void;
}) {
  const [disbursementRequestItemList, setDisbursementRequestItemList] = useState<UrgentRequestItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isError, setIsError] = useState(false);

  /** Hàm chuẩn hóa trạng thái chữ ký để hiển thị đúng ngưỡng ký động FR7 từ backend. */
  function buildSignatureStateText(currentSignatures: number, requiredSignatures: number): string {
    const safeRequiredSignatures = Math.max(1, requiredSignatures);
    const safeCurrentSignatures = Math.min(Math.max(0, currentSignatures), safeRequiredSignatures);
    return `${safeCurrentSignatures}/${safeRequiredSignatures}`;
  }

  /** Hàm chuẩn hóa thời hạn xử lý sang tiếng Việt để người dùng đọc nhanh mức ưu tiên. */
  function buildDeadlineText(deadlineTimestamp: number): string {
    const remainMilliseconds = deadlineTimestamp - Date.now();
    if (remainMilliseconds <= 0) return "Đã quá hạn";

    const remainMinutes = Math.floor(remainMilliseconds / (60 * 1000));
    if (remainMinutes < 60) return `${remainMinutes} phút`;

    const remainHours = Math.floor(remainMinutes / 60);
    if (remainHours < 24) return `${remainHours} giờ`;

    return `${Math.floor(remainHours / 24)} ngày`;
  }

  /** Hàm xác định mức cảnh báo thời hạn để bảng giải ngân dùng màu trạng thái phù hợp. */
  function buildDeadlineLevel(deadlineTimestamp: number): "urgent" | "normal" | "ok" {
    const remainMilliseconds = deadlineTimestamp - Date.now();
    if (remainMilliseconds <= 60 * 60 * 1000) return "urgent";
    if (remainMilliseconds <= 24 * 60 * 60 * 1000) return "normal";
    return "ok";
  }

  /** Hàm tải danh sách yêu cầu giải ngân thật, tách riêng khỏi dashboard Tổng quan. */
  const loadDisbursementRequestList = useCallback(async () => {
    setIsLoading(true);
    setIsError(false);

    try {
      const session = readAuthSession();
      const response = await fetchApi<{
        requests: {
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
        }[];
      }>(buildApiUrl("/api/disbursement/requests"), {
        headers: { Authorization: `Bearer ${session.accessToken}` },
      });

      const requestItemList = response.data?.requests ?? [];
      setDisbursementRequestItemList(requestItemList.map((requestItem) => ({
        id: requestItem.id,
        projectName: requestItem.projectName,
        organizationName: requestItem.organizationName,
        amountText: `${new Intl.NumberFormat("vi-VN").format(requestItem.amount)}₫`,
        signatureState: buildSignatureStateText(requestItem.currentSignatures, requestItem.requiredSignatures),
        deadlineText: buildDeadlineText(requestItem.deadlineTimestamp),
        deadlineLevel: buildDeadlineLevel(requestItem.deadlineTimestamp),
        usagePurpose: requestItem.usagePurpose,
        ipfsCid: requestItem.ipfsCid,
        fileName: requestItem.fileName,
      })));
    } catch {
      setDisbursementRequestItemList([]);
      setIsError(true);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadDisbursementRequestList();
  }, [loadDisbursementRequestList]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-emerald-900/15 bg-white px-5 py-4">
        <div>
          <h2 className="text-lg font-bold text-slate-900">Yêu cầu giải ngân</h2>
          <p className="mt-1 text-xs text-slate-500">Chỉ hiển thị các yêu cầu giải ngân đang chờ ký duyệt từ backend</p>
        </div>

        <button
          type="button"
          onClick={() => void loadDisbursementRequestList()}
          className="rounded-lg border border-emerald-900/15 px-3 py-2 text-xs font-semibold text-[#0E7C6B] transition hover:bg-[#0E7C6B] hover:text-white"
        >
          Làm mới
        </button>
      </div>

      <div className="overflow-hidden rounded-xl border border-emerald-900/15 bg-white">
        <div className="overflow-x-auto">
          <table className="min-w-full text-left">
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
              {isLoading ? (
                Array.from({ length: 4 }).map((_, rowIndex) => (
                  <tr key={rowIndex} className="border-t border-slate-100">
                    {Array.from({ length: 6 }).map((__, cellIndex) => (
                      <td key={cellIndex} className="px-5 py-3">
                        <div className="h-4 w-full max-w-[160px] animate-pulse rounded bg-slate-200" />
                      </td>
                    ))}
                  </tr>
                ))
              ) : isError ? (
                <tr>
                  <td colSpan={6} className="px-5 py-10 text-center text-sm font-semibold text-red-700">
                    Không thể tải danh sách yêu cầu giải ngân. Vui lòng thử lại.
                  </td>
                </tr>
              ) : disbursementRequestItemList.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-5 py-10 text-center text-sm text-slate-500">
                    Không có yêu cầu giải ngân nào đang chờ ký duyệt.
                  </td>
                </tr>
              ) : (
                disbursementRequestItemList.map((requestItem) => (
                  <tr key={requestItem.id} className="border-t border-slate-100 text-sm hover:bg-slate-50">
                    <td className="px-5 py-3 font-mono text-[12px] text-cyan-700">{requestItem.id}</td>
                    <td className="px-5 py-3 align-middle">
                      <p className="text-[13px] font-semibold leading-5 text-slate-900">{requestItem.projectName}</p>
                      <p className="mt-0.5 text-[12px] leading-4 text-slate-500">{requestItem.organizationName}</p>
                    </td>
                    <td className="px-5 py-3 font-mono text-[13px] font-semibold text-slate-800">{requestItem.amountText}</td>
                    <td className="px-5 py-3 font-mono text-[12px] text-slate-700">{requestItem.signatureState}</td>
                    <td className="px-5 py-3 text-[12px] text-slate-700">{requestItem.deadlineText}</td>
                    <td className="px-5 py-3 text-right">
                      <button
                        type="button"
                        onClick={() => onOpenDisbursementRequest?.(requestItem)}
                        className="rounded-md bg-[#1AAE97] px-3 py-1.5 text-[11px] font-bold leading-none text-[#0A5C50] transition hover:bg-[#129b86]"
                      >
                        Xem & Ký
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
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

/** Hàm chuyển byte sang chuỗi dung lượng để hiển thị danh sách tài liệu dễ đọc. */

function formatFileSize(fileSizeInBytes: number): string {
  if (fileSizeInBytes < 1024) return `${fileSizeInBytes} B`;

  if (fileSizeInBytes < 1024 * 1024)
    return `${(fileSizeInBytes / 1024).toFixed(1)} KB`;

  return `${(fileSizeInBytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** Hàm định dạng thời gian nộp hồ sơ KYC theo locale tiếng Việt. */

function formatSubmissionTime(submittedAt: string): string {
  return new Date(submittedAt).toLocaleString("vi-VN");
}

/** Hàm chuẩn hóa nhãn loại tài liệu để người dùng dễ hiểu hơn. */

function resolveDocumentTypeLabel(documentType: string): string {
  if (documentType === "LEGAL_DOCUMENT") {
    return "Giấy tờ pháp lý";
  }

  return documentType;
}

/** Hàm hiển thị panel Duyệt Hồ sơ KYC bằng dữ liệu backend thật. */

function KycPanel({ accessToken: verifiedAccessToken }: VerifiedAccessTokenProps) {
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
    submissionList.find(
      (submissionItem) => submissionItem.submissionId === selectedSubmissionId,
    ) || null;

  /** Hàm gọi API lấy danh sách hồ sơ KYC chờ duyệt. */

  const loadPendingSubmissionList = useCallback(async () => {
    setIsLoading(true);

    setErrorMessage("");

    try {
      const accessToken = verifiedAccessToken || readAuthSession().accessToken || "";

      if (!accessToken) {
        throw new Error(
          "Bạn cần đăng nhập tài khoản Regulatory để duyệt KYC.",
        );
      }

      const response = await fetchApi<{ submissions: unknown[] }>(
        buildApiUrl("/auth/organization/kyc-submissions/pending"),

        { headers: { Authorization: `Bearer ${accessToken}` } },
      );

      // Ghi chú logic phức tạp: chuẩn hóa dữ liệu fallback để UI luôn hiển thị đủ thông tin chính.
      const responsePayload = (response.data ?? response) as {
        submissions?: unknown[];
      };

      const normalizedSubmissionList = (responsePayload.submissions || [])
        .filter((submissionItem) => {
          if (!submissionItem || typeof submissionItem !== "object") return true;
          return (submissionItem as { organizationCategory?: unknown }).organizationCategory !== "FOUNDATION";
        })
        .map(
        (submissionItem: any) => ({
          ...submissionItem,

          organizationName:
            submissionItem.organizationName || submissionItem.organizationId,

          legalRegistrationNumber:
            submissionItem.legalRegistrationNumber || "Chưa cập nhật",

          officialWebsite: submissionItem.officialWebsite || null,

          organizationDescription:
            submissionItem.organizationDescription ||
            "Chưa cập nhật mô tả tổ chức.",
        }),
        ) as KycSubmissionItem[];

      setSubmissionList(normalizedSubmissionList);

      setSelectedSubmissionId((previousSubmissionId) => {
        // Ghi chú logic phức tạp: nếu hồ sơ cũ đã được duyệt và biến mất khỏi danh sách,

        // tự động chọn hồ sơ đầu tiên còn lại để tránh panel chi tiết rơi vào trạng thái rỗng.

        const hasPreviousSubmission = normalizedSubmissionList.some(
          (submissionItem) =>
            submissionItem.submissionId === previousSubmissionId,
        );

        if (hasPreviousSubmission) {
          return previousSubmissionId;
        }

        return normalizedSubmissionList[0]?.submissionId || "";
      });
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "Không thể tải danh sách hồ sơ KYC.",
      );
    } finally {
      setIsLoading(false);
    }
  }, [verifiedAccessToken]);

  /** Hàm gửi hành động duyệt hồ sơ KYC lên backend. */

  const submitKycReview = useCallback(
    async (action: "approve" | "reject") => {
      if (!selectedSubmission) return;

      if (action === "reject" && rejectReason.trim().length === 0) {
        setErrorMessage("Vui lòng nhập lý do từ chối trước khi Reject.");

        return;
      }

      setIsSubmittingReview(true);

      setErrorMessage("");

      setSuccessMessage("");

      try {
        const accessToken = verifiedAccessToken || readAuthSession().accessToken || "";

        if (!accessToken) {
          throw new Error(
            "Bạn cần đăng nhập tài khoản Regulatory để duyệt KYC.",
          );
        }

        const responseData = await fetchApi(
          buildApiUrl(
            `/auth/organization/kyc-submissions/${selectedSubmission.submissionId}/review`,
          ),
          {
            method: "PATCH",

            headers: {
              "Content-Type": "application/json",

              Authorization: `Bearer ${accessToken}`,
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

          const isRoleUpdatedCorrectly =
            accountUpdate?.updatedRole === "organizations";

          // Ghi chú logic phức tạp: FE chỉ báo thành công khi backend xác nhận đã đổi role đúng nghiệp vụ.

          if (!isRoleUpdatedCorrectly) {
            throw new Error(
              "Backend chưa xác nhận cập nhật role tài khoản thành organizations. Vui lòng kiểm tra lại.",
            );
          }
        }

        setRejectReason("");

        setIsRejectFormVisible(false);

        setSuccessMessage(
          action === "approve"
            ? "Phê duyệt hồ sơ KYC thành công."
            : "Từ chối hồ sơ KYC thành công.",
        );

        await loadPendingSubmissionList();
      } catch (error) {
        setErrorMessage(
          error instanceof Error
            ? error.message
            : "Cập nhật trạng thái hồ sơ thất bại.",
        );
      } finally {
        setIsSubmittingReview(false);
      }
    },
    [
      loadPendingSubmissionList,
      rejectReason,
      selectedSubmission,
      verifiedAccessToken,
    ],
  );

  /** Hàm mở modal xác nhận trước khi phê duyệt hồ sơ KYC. */

  const openApproveConfirmModal = () => {
    setErrorMessage("");

    setSuccessMessage("");

    setIsApproveConfirmModalVisible(true);
  };

  /** Hàm đóng modal xác nhận phê duyệt hồ sơ KYC. */

  const closeApproveConfirmModal = () => {
    if (isSubmittingReview) {
      return;
    }

    setIsApproveConfirmModalVisible(false);
  };

  /** Hàm xác nhận phê duyệt hồ sơ sau khi người dùng bấm nút chắc chắn. */

  const handleConfirmApproveReview = async () => {
    setIsApproveConfirmModalVisible(false);

    await submitKycReview("approve");
  };

  /** Hàm tải dữ liệu KYC khi panel được hiển thị. */

  useEffect(() => {
    loadPendingSubmissionList();
  }, [loadPendingSubmissionList]);

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-emerald-900/15 bg-white px-5 py-4">
        <h2 className="text-lg font-bold text-slate-900">Duyệt Hồ sơ KYC</h2>

        <p className="mt-1 text-xs text-slate-500">
          Danh sách hồ sơ chờ duyệt{" "}
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
        <div className="max-h-[620px] overflow-y-auto border-r border-slate-100 pr-3">
          {isLoading ? (
            <p className="text-xs text-slate-500">Đang tải hồ sơ...</p>
          ) : null}

          {!isLoading && submissionList.length === 0 ? (
            <p className="text-xs text-slate-500">Không có hồ sơ chờ duyệt.</p>
          ) : null}

          {submissionList.map((submissionItem) => (
            <button
              key={submissionItem.submissionId}
              type="button"
              onClick={() =>
                setSelectedSubmissionId(submissionItem.submissionId)
              }
              className={`mb-2 w-full rounded-lg border px-3 py-2 text-left ${selectedSubmissionId === submissionItem.submissionId ? "border-cyan-500 bg-cyan-50" : "border-slate-200 bg-white"}`}
            >
              <p className="text-xs font-semibold text-slate-900">
                {submissionItem.organizationName}
              </p>

              <p className="mt-1 font-mono text-[10px] text-slate-500">
                submissionId: {submissionItem.submissionId}
              </p>
            </button>
          ))}
        </div>

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
                    <span className="font-semibold">Mã tổ chức:</span>{" "}
                    {selectedSubmission.organizationId}
                  </p>

                  <p>
                    <span className="font-semibold">Tên tổ chức:</span>{" "}
                    {selectedSubmission.organizationName}
                  </p>

                  <p>
                    <span className="font-semibold">MST:</span>{" "}
                    {selectedSubmission.legalRegistrationNumber}
                  </p>

                  <p className="sm:col-span-2">
                    <span className="font-semibold">Website chính thức:</span>{" "}
                    {selectedSubmission.officialWebsite || "Chưa cập nhật"}
                  </p>

                  <p className="sm:col-span-2">
                    <span className="font-semibold">Mô tả tổ chức:</span>{" "}
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
                  {selectedSubmission.files.map((fileItem, fileIndex) => (
                    <IpfsEvidencePreviewCard
                      key={`${selectedSubmission.submissionId}-${fileIndex}`}
                      cid={fileItem.cid}
                      fileName={`Tài liệu #${fileIndex}: ${fileItem.cid}`}
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
                      onChange={(event) => setRejectReason(event.target.value)}
                      rows={3}
                      className="w-full rounded border border-amber-200 px-2 py-1 text-xs outline-none"
                      placeholder="Nhập lý do từ chối hồ sơ..."
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
                    onClick={openApproveConfirmModal}
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

      {isApproveConfirmModalVisible ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4">
          <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl">
            <h3 className="text-base font-bold text-slate-900">
              Xác nhận phê duyệt hồ sơ KYC
            </h3>

            <p className="mt-2 text-sm text-slate-600">
              Bạn có chắc chắn muốn phê duyệt hồ sơ này không? Sau khi phê
              duyệt, vai trò tài khoản sẽ được cập nhật.
            </p>

            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={closeApproveConfirmModal}
                disabled={isSubmittingReview}
                className="rounded border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                Hủy
              </button>

              <button
                type="button"
                onClick={handleConfirmApproveReview}
                disabled={isSubmittingReview}
                className="rounded bg-emerald-600 px-3 py-2 text-xs font-bold text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                Chắc chắn
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

type ProjectReviewItem = {
  projectId: string;

  organizationId: string;

  name: string;

  description: string;

  goalAmount: number;

  deadline: string;

  submittedAt: string | null;

  status: "PENDING_APPROVAL" | "PENDING_ACTIVATION" | "DISPUTED" | "ACTIVE" | "REJECTED";

  reviewedAt: string | null;

  reviewedBy: string | null;

  rejectionReason: string | null;

  milestonePlan: ProjectMilestonePlanItem[];

  evidenceCids: string[];

  evidenceFiles: Array<{
    cid: string;

    fileName: string;

    mimeType: string;
  }>;
};

type ProjectMilestonePlanItem = {
  milestoneIndex: number;

  milestoneKey: string;

  percentage: number;

  description: string;
};

const MILESTONE_LABEL_BY_KEY: Record<string, string> = {
  M1_ADVANCE: "M1 — Tạm ứng",
  M2_CONSTRUCTION: "M2 — Thi công",
  M3_HANDOVER: "M3 — Nghiệm thu và bàn giao",
};

const PROJECT_REVIEW_STATUS_PRIORITY: Record<ProjectReviewItem["status"], number> = {
  PENDING_APPROVAL: 0,
  PENDING_ACTIVATION: 1,
  DISPUTED: 2,
  REJECTED: 3,
  ACTIVE: 4,
};

/** Hàm kiểm tra trạng thái dự án có thuộc lịch sử review mà Regulatory được phép xem hay không. */
function isProjectReviewStatus(
  value: unknown,
): value is ProjectReviewItem["status"] {
  return value === "PENDING_APPROVAL" || value === "PENDING_ACTIVATION" || value === "DISPUTED" || value === "ACTIVE" || value === "REJECTED";
}

/** Hàm chuyển trạng thái review dự án sang nhãn tiếng Việt để hiển thị nhất quán. */
function getProjectReviewStatusLabel(status: ProjectReviewItem["status"]): string {
  if (status === "ACTIVE") return "Đã chấp nhận";
  if (status === "REJECTED") return "Đã từ chối";
  if (status === "PENDING_ACTIVATION") return "Đang niêm yết 48 giờ";
  if (status === "DISPUTED") return "Đang tranh chấp";
  return "Chờ phê duyệt";
}

/** Hàm chọn màu badge theo trạng thái review để phân biệt rõ queue và lịch sử đã xử lý. */
function getProjectReviewStatusClassName(status: ProjectReviewItem["status"]): string {
  if (status === "ACTIVE") return "border-emerald-200 bg-emerald-100 text-emerald-700";
  if (status === "REJECTED") return "border-red-200 bg-red-100 text-red-700";
  if (status === "PENDING_ACTIVATION") return "border-violet-200 bg-violet-100 text-violet-700";
  if (status === "DISPUTED") return "border-red-200 bg-red-100 text-red-700";
  return "border-amber-200 bg-amber-100 text-amber-700";
}

/** Sắp xếp danh sách review theo mức độ cần xử lý để dự án chờ luôn xuất hiện trước lịch sử đã xử lý. */
function sortProjectReviewItems(projectItems: ProjectReviewItem[]): ProjectReviewItem[] {
  return projectItems
    .map((projectItem, originalIndex) => ({ projectItem, originalIndex }))
    .sort((leftItem, rightItem) => {
      const priorityDifference =
        PROJECT_REVIEW_STATUS_PRIORITY[leftItem.projectItem.status] -
        PROJECT_REVIEW_STATUS_PRIORITY[rightItem.projectItem.status];

      return priorityDifference || leftItem.originalIndex - rightItem.originalIndex;
    })
    .map(({ projectItem }) => projectItem);
}

/** Chuẩn hóa toàn bộ cột mốc từ API để reviewer luôn thấy dữ liệu hợp lệ, đúng thứ tự và không lỗi khi thiếu field. */
function normalizeProjectMilestonePlan(rawValue: unknown): ProjectMilestonePlanItem[] {
  if (!Array.isArray(rawValue)) {
    return [];
  }

  return rawValue
    .map((rawMilestone): ProjectMilestonePlanItem | null => {
      if (!rawMilestone || typeof rawMilestone !== "object") {
        return null;
      }

      const milestoneRecord = rawMilestone as Record<string, unknown>;
      const milestoneIndex = Number(milestoneRecord.milestoneIndex);
      const percentage = Number(milestoneRecord.percentage);
      const milestoneKey = typeof milestoneRecord.milestoneKey === "string"
        ? milestoneRecord.milestoneKey.trim()
        : "";
      const description = typeof milestoneRecord.description === "string"
        ? milestoneRecord.description.trim()
        : "";

      if (
        !Number.isInteger(milestoneIndex) ||
        milestoneIndex < 1 ||
        milestoneIndex > 3 ||
        !Number.isFinite(percentage) ||
        percentage < 0 ||
        percentage > 100 ||
        milestoneKey.length === 0 ||
        description.length === 0
      ) {
        return null;
      }

      return { milestoneIndex, milestoneKey, percentage, description };
    })
    .filter((milestone): milestone is ProjectMilestonePlanItem => milestone !== null)
    .sort((leftMilestone, rightMilestone) => leftMilestone.milestoneIndex - rightMilestone.milestoneIndex);
}

/** Hàm chuẩn hóa dữ liệu lịch sử review dự án từ API để tránh lỗi khi backend trả thiếu trường. */

function normalizeProjectReviewItem(
  rawValue: unknown,
): ProjectReviewItem | null {
  if (!rawValue || typeof rawValue !== "object") {
    return null;
  }

  const rawProject = rawValue as Record<string, unknown>;

  if (
    typeof rawProject.projectId !== "string" ||
    typeof rawProject.name !== "string"
  ) {
    return null;
  }

  return {
    projectId: rawProject.projectId,

    organizationId:
      typeof rawProject.organizationId === "string"
        ? rawProject.organizationId
        : "",

    name: rawProject.name,

    description:
      typeof rawProject.description === "string"
        ? rawProject.description
        : "Chưa có mô tả.",

    goalAmount:
      typeof rawProject.goalAmount === "number" ? rawProject.goalAmount : 0,

    deadline:
      typeof rawProject.deadline === "string" ? rawProject.deadline : "",

    submittedAt:
      typeof rawProject.submittedAt === "string"
        ? rawProject.submittedAt
        : null,

    status: isProjectReviewStatus(rawProject.status)
      ? rawProject.status
      : "PENDING_APPROVAL",

    reviewedAt:
      typeof rawProject.reviewedAt === "string"
        ? rawProject.reviewedAt
        : null,

    reviewedBy:
      typeof rawProject.reviewedBy === "string"
        ? rawProject.reviewedBy
        : null,

    rejectionReason:
      typeof rawProject.rejectionReason === "string"
        ? rawProject.rejectionReason
        : null,

    milestonePlan: normalizeProjectMilestonePlan(rawProject.milestonePlan),

    evidenceCids: Array.isArray(rawProject.evidenceCids)
      ? rawProject.evidenceCids.filter(
          (cidItem): cidItem is string => typeof cidItem === "string",
        )
      : [],

    evidenceFiles: Array.isArray(rawProject.evidenceFiles)
      ? rawProject.evidenceFiles.filter(
          (
            evidenceFile,
          ): evidenceFile is { cid: string; fileName: string; mimeType: string } =>
            Boolean(evidenceFile) &&
            typeof evidenceFile === "object" &&
            typeof (evidenceFile as Record<string, unknown>).cid === "string" &&
            typeof (evidenceFile as Record<string, unknown>).fileName === "string" &&
            typeof (evidenceFile as Record<string, unknown>).mimeType === "string",
        )
      : [],
  };
}

/** Hàm hiển thị panel Duyệt dự án. Mục đích: tải queue và lịch sử để chỉ cho phép xử lý dự án đang chờ duyệt. */

function ProjectReviewPanel({ onPushToast }: Pick<NonDashboardPanelProps, "onPushToast">) {
  const [isLoading, setIsLoading] = useState(false);

  const [isSubmittingReview, setIsSubmittingReview] = useState(false);

  const [projectReviewList, setProjectReviewList] = useState<
    ProjectReviewItem[]
  >([]);

  const [selectedProjectId, setSelectedProjectId] = useState("");

  const [rejectReason, setRejectReason] = useState("");

  const [isRejectFormVisible, setIsRejectFormVisible] = useState(false);

  const [isApproveConfirmModalVisible, setIsApproveConfirmModalVisible] =
    useState(false);

  const selectedProject =
    projectReviewList.find(
      (projectItem) => projectItem.projectId === selectedProjectId,
    ) || null;

  const isSelectedProjectPendingApproval =
    selectedProject?.status === "PENDING_APPROVAL";

  /** Hàm gọi API lấy queue và toàn bộ lịch sử dự án đã được Regulatory review. */

  const loadProjectReviewHistory = useCallback(async () => {
    const authSession = readAuthSession();

    if (!authSession.accessToken) {
      onPushToast?.(
        "Không thể duyệt dự án",
        "Bạn cần đăng nhập trước khi duyệt dự án.",
        "error",
      );

      return;
    }

    setIsLoading(true);

    try {
      const response = await fetchApi<ProjectReviewItem[]>(
        buildApiUrl("/projects/review-history"),
        {
          method: "GET",

          headers: { Authorization: `Bearer ${authSession.accessToken}` },
        },
      );

      const normalizedProjectList = sortProjectReviewItems((response.data || [])

        .map(normalizeProjectReviewItem)

        .filter(
          (projectItem): projectItem is ProjectReviewItem =>
            projectItem !== null,
        ));

      setProjectReviewList(normalizedProjectList);

      setSelectedProjectId((previousProjectId) => {
        // Ghi chú logic phức tạp: nếu item đang chọn không còn trong danh sách sau khi reload,

        // tự động chọn item đầu tiên còn lại để panel chi tiết luôn có dữ liệu hợp lệ.

        const hasPreviousProject = normalizedProjectList.some(
          (projectItem) => projectItem.projectId === previousProjectId,
        );

        if (hasPreviousProject) {
          return previousProjectId;
        }

        return normalizedProjectList[0]?.projectId || "";
      });
    } catch (error) {
      const apiError = error as ApiErrorResponse;

      onPushToast?.(
        "Không thể tải lịch sử duyệt",
        apiError.message || "Không thể tải lịch sử review dự án.",
        "error",
      );
    } finally {
      setIsLoading(false);
    }
  }, [onPushToast]);

  /** Hàm gửi hành động review dự án lên backend. Mục đích: cập nhật trạng thái APPROVE/REJECT trực tiếp từ màn duyệt dự án mới. */

  const submitProjectReview = useCallback(
    async (action: "APPROVE" | "REJECT") => {
      if (!selectedProject || selectedProject.status !== "PENDING_APPROVAL") {
        return;
      }

      if (action === "REJECT" && rejectReason.trim().length === 0) {
        onPushToast?.(
          "Thiếu lý do từ chối",
          "Vui lòng nhập lý do từ chối trước khi reject dự án.",
          "info",
        );

        return;
      }

      const authSession = readAuthSession();

      if (!authSession.accessToken) {
        onPushToast?.(
          "Phiên đăng nhập đã hết hạn",
          "Vui lòng đăng nhập lại để duyệt dự án.",
          "error",
        );

        return;
      }

      setIsSubmittingReview(true);

      try {
        const reviewResponse = await fetchApi<ProjectReviewItem & { warning?: string | null }>(buildApiUrl("/projects/review"), {
          method: "POST",

          headers: { Authorization: `Bearer ${authSession.accessToken}` },

          body: JSON.stringify({
            projectId: selectedProject.projectId,

            action,

            rejectionReason:
              action === "REJECT" ? rejectReason.trim() : undefined,
          }),
        });

        setRejectReason("");

        setIsRejectFormVisible(false);

        onPushToast?.(
          action === "APPROVE" ? "Duyệt dự án thành công" : "Đã từ chối dự án",
          action === "APPROVE"
            ? `Đã niêm yết công khai — tự động mở quỹ sau 48 giờ nếu không có khiếu nại.${reviewResponse.data.warning === "NO_ACTIVE_AUDITOR" ? " Cảnh báo: chưa có Kiểm toán viên giám sát cửa sổ khiếu nại." : ""}`
            : "Từ chối dự án thành công.",
          action === "APPROVE" ? "success" : "info",
        );

        await loadProjectReviewHistory();
      } catch (error) {
        const apiError = error as ApiErrorResponse;

        onPushToast?.(
          "Không thể cập nhật kết quả duyệt",
          apiError.message || "Không thể cập nhật kết quả duyệt dự án.",
          "error",
        );
      } finally {
        setIsSubmittingReview(false);
      }
    },
    [loadProjectReviewHistory, onPushToast, rejectReason, selectedProject],
  );

  /** Hàm mở modal xác nhận trước khi phê duyệt dự án để tránh thao tác nhầm. */

  const openApproveConfirmModal = () => {
    if (!isSelectedProjectPendingApproval) {
      return;
    }

    setIsApproveConfirmModalVisible(true);
  };

  /** Hàm đóng modal xác nhận phê duyệt dự án. */

  const closeApproveConfirmModal = () => {
    if (isSubmittingReview) {
      return;
    }

    setIsApproveConfirmModalVisible(false);
  };

  /** Hàm xác nhận phê duyệt dự án sau khi người dùng bấm chắc chắn. */

  const handleConfirmApproveProjectReview = async () => {
    setIsApproveConfirmModalVisible(false);

    await submitProjectReview("APPROVE");
  };

  /** Hàm tải dữ liệu dự án khi mở đúng tab để tránh gọi API thừa. */

  useEffect(() => {
    void loadProjectReviewHistory();
  }, [loadProjectReviewHistory]);

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-emerald-900/15 bg-white px-5 py-4">
        <h2 className="text-lg font-bold text-slate-900">Duyệt và tra cứu dự án</h2>

        <p className="mt-1 text-xs text-slate-500">
          Hiển thị đầy đủ dự án chờ duyệt, đã chấp nhận và đã từ chối
        </p>
      </div>

      <div className="grid gap-4 overflow-hidden rounded-xl border border-emerald-900/15 bg-white p-4 lg:grid-cols-[320px_1fr]">
        <div className="max-h-[620px] overflow-y-auto border-r border-slate-100 pr-3">
          {isLoading ? (
            <p className="text-xs text-slate-500">
              Đang tải danh sách dự án...
            </p>
          ) : null}

          {!isLoading && projectReviewList.length === 0 ? (
            <p className="text-xs text-slate-500">
              Chưa có dự án nào trong lịch sử review.
            </p>
          ) : null}

          {projectReviewList.map((projectItem) => (
            <button
              key={projectItem.projectId}
              data-testid={`project-review-list-item-${projectItem.projectId}`}
              type="button"
              onClick={() => { setSelectedProjectId(projectItem.projectId); setIsRejectFormVisible(false); setRejectReason(""); }}
              className={`mb-2 w-full rounded-lg border px-3 py-2 text-left ${selectedProjectId === projectItem.projectId ? "border-cyan-500 bg-cyan-50" : "border-slate-200 bg-white"}`}
            >
              <p className="text-xs font-semibold text-slate-900">
                {projectItem.name}
              </p>

              <p className="mt-1 line-clamp-2 text-[11px] text-slate-600">
                {projectItem.description}
              </p>

              <span className={`mt-2 inline-flex rounded border px-1.5 py-0.5 text-[10px] font-semibold ${getProjectReviewStatusClassName(projectItem.status)}`}>
                {getProjectReviewStatusLabel(projectItem.status)}
              </span>
            </button>
          ))}
        </div>

        <div>
          {selectedProject ? (
            <div className="space-y-4">
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                <h3 className="text-sm font-bold text-slate-900">
                  {selectedProject.name}
                </h3>

                <p className="mt-2 text-xs text-slate-700">
                  {selectedProject.description}
                </p>

                <div className="mt-3 grid gap-2 text-[11px] text-slate-700 sm:grid-cols-2">
                  <p>
                    <span className="font-semibold">Mã dự án:</span>{" "}
                    {selectedProject.projectId}
                  </p>

                  <p>
                    <span className="font-semibold">Mã tổ chức:</span>{" "}
                    {selectedProject.organizationId}
                  </p>

                  <p>
                    <span className="font-semibold">Trạng thái:</span>{" "}
                    {getProjectReviewStatusLabel(selectedProject.status)}
                  </p>

                  <p>
                    <span className="font-semibold">Mục tiêu gây quỹ:</span>{" "}
                    {selectedProject.goalAmount.toLocaleString("vi-VN")} ₫
                  </p>

                  <p>
                    <span className="font-semibold">Hạn chót:</span>{" "}
                    {selectedProject.deadline
                      ? new Date(selectedProject.deadline).toLocaleString(
                          "vi-VN",
                        )
                      : "Chưa có hạn chót"}
                  </p>

                  <p>
                    <span className="font-semibold">Thời điểm gửi duyệt:</span>{" "}
                    {selectedProject.submittedAt
                      ? new Date(selectedProject.submittedAt).toLocaleString(
                          "vi-VN",
                        )
                      : "Chưa gửi duyệt"}
                  </p>

                  {selectedProject.reviewedAt ? (
                    <p>
                      <span className="font-semibold">Thời điểm review:</span>{" "}
                      {new Date(selectedProject.reviewedAt).toLocaleString("vi-VN")}
                    </p>
                  ) : null}

                  {selectedProject.reviewedBy ? (
                    <p>
                      <span className="font-semibold">Người review:</span>{" "}
                      {selectedProject.reviewedBy}
                    </p>
                  ) : null}
                </div>

                {selectedProject.rejectionReason ? (
                  <p className="mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                    <span className="font-semibold">Lý do từ chối:</span>{" "}
                    {selectedProject.rejectionReason}
                  </p>
                ) : null}
              </div>

              <div
                data-testid="project-review-milestone-plan"
                className="rounded-lg border border-slate-200 p-3"
              >
                <div className="mb-2 flex items-center justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold text-slate-800">
                      Kế hoạch cột mốc giải ngân
                    </p>
                    <p className="mt-1 text-[11px] text-slate-500">
                      Toàn bộ lộ trình sử dụng vốn theo từng giai đoạn của dự án.
                    </p>
                  </div>
                  {selectedProject.milestonePlan.length > 0 ? (
                    <span className="shrink-0 rounded-full bg-cyan-50 px-2 py-1 text-[10px] font-semibold text-cyan-700">
                      {selectedProject.milestonePlan.reduce(
                        (totalPercentage, milestone) => totalPercentage + milestone.percentage,
                        0,
                      )}%
                    </span>
                  ) : null}
                </div>

                {selectedProject.milestonePlan.length === 0 ? (
                  <p data-testid="project-review-milestone-plan-empty" className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
                    Dự án chưa có kế hoạch cột mốc giải ngân hợp lệ.
                  </p>
                ) : (
                  <ol className="space-y-2">
                    {selectedProject.milestonePlan.map((milestone) => (
                      <li
                        key={`${selectedProject.projectId}-${milestone.milestoneIndex}-${milestone.milestoneKey}`}
                        data-testid={`project-review-milestone-${milestone.milestoneIndex}`}
                        className="rounded-lg border border-slate-100 bg-slate-50 px-3 py-2"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <p className="text-xs font-semibold text-slate-800">
                            {MILESTONE_LABEL_BY_KEY[milestone.milestoneKey] || `M${milestone.milestoneIndex} — ${milestone.milestoneKey}`}
                          </p>
                          <span className="shrink-0 text-xs font-bold text-cyan-700">
                            {milestone.percentage}%
                          </span>
                        </div>
                        <p className="mt-1 text-xs leading-5 text-slate-600">
                          {milestone.description}
                        </p>
                      </li>
                    ))}
                  </ol>
                )}
              </div>

              <div
                data-testid="project-review-geofence"
                className="rounded-lg border border-slate-200 p-3"
              >
                <div className="mb-2">
                  <p className="text-xs font-semibold text-slate-800">
                    Vùng địa lý dự án
                  </p>
                  <p className="mt-1 text-[11px] text-slate-500">
                    Bản đồ chỉ xem để đối chiếu ranh giới trước khi duyệt.
                  </p>
                </div>
                <GeofenceMapLazy projectId={selectedProject.projectId} />
              </div>

              <div className="rounded-lg border border-slate-200 p-3">
                <p className="text-xs font-semibold text-slate-800">
                  Danh sách CID minh chứng (IPFS)
                </p>

                {selectedProject.evidenceCids.length === 0 ? (
                  <p className="mt-2 text-xs text-slate-500">
                    Dự án chưa có CID minh chứng.
                  </p>
                ) : (
                  <div className="mt-2 grid gap-4 grid-cols-1 xl:grid-cols-2">
                    {selectedProject.evidenceCids.map(
                      (cidItem, evidenceIndex) => {
                        const evidenceFile = selectedProject.evidenceFiles.find(
                          (fileItem) => fileItem.cid === cidItem,
                        );

                        return (
                          <IpfsEvidencePreviewCard
                            key={`${selectedProject.projectId}-${evidenceIndex}`}
                            cid={cidItem}
                            fileName={
                              evidenceFile?.fileName ||
                              `Minh chứng #${evidenceIndex + 1}`
                            }
                            mimeType={evidenceFile?.mimeType}
                            documentTypeLabel="Tài liệu dự án"
                            compact={true}
                          />
                        );
                      },
                    )}
                  </div>
                )}
              </div>

              {isSelectedProjectPendingApproval && isRejectFormVisible ? (
                <>
                  <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3">
                    <label className="block text-xs font-semibold text-amber-800">
                      Lý do từ chối (bắt buộc khi từ chối)
                    </label>

                    <textarea
                      value={rejectReason}
                      onChange={(event) => setRejectReason(event.target.value)}
                      rows={3}
                      className="w-full rounded border border-amber-200 px-2 py-1 text-xs outline-none"
                      placeholder="Nhập lý do từ chối dự án..."
                    />
                  </div>

                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={isSubmittingReview}
                      onClick={() => submitProjectReview("REJECT")}
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
              ) : isSelectedProjectPendingApproval ? (
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
                    onClick={openApproveConfirmModal}
                    className="rounded bg-emerald-600 px-3 py-2 text-xs font-bold text-white disabled:opacity-50"
                  >
                    Chấp nhận
                  </button>
                </div>
              ) : null}
            </div>
          ) : (
            <p className="text-xs text-slate-500">
              Chọn dự án để xem chi tiết và xử lý khi còn chờ duyệt.
            </p>
          )}
        </div>
      </div>

      {isApproveConfirmModalVisible ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4">
          <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl">
            <h3 className="text-base font-bold text-slate-900">
              Xác nhận phê duyệt dự án
            </h3>

            <p className="mt-2 text-sm text-slate-600">
              Bạn có chắc chắn muốn phê duyệt dự án này không?
            </p>

            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={closeApproveConfirmModal}
                disabled={isSubmittingReview}
                className="rounded border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                Hủy
              </button>

              <button
                type="button"
                onClick={handleConfirmApproveProjectReview}
                disabled={isSubmittingReview}
                className="rounded bg-emerald-600 px-3 py-2 text-xs font-bold text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                Chắc chắn
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

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

/** Hàm che bớt số tài khoản để hiển thị trong bảng danh sách mà vẫn dễ nhận diện. */

function maskBankAccountNumber(bankAccountNumber: string): string {
  if (bankAccountNumber.length <= 4) {
    return bankAccountNumber;
  }

  return `••••••${bankAccountNumber.slice(-4)}`;
}

/** Hàm ánh xạ mã trạng thái duyệt sang tiếng Việt để hiển thị nhất quán trên giao diện. */

function getBankAccountReviewStatusText(status: string): string {
  if (status === "PENDING_REVIEW") return "Chờ duyệt";

  if (status === "APPROVED") return "Đã phê duyệt";

  if (status === "REJECTED") return "Đã từ chối";

  return "Không xác định";
}

/** Hàm hiển thị panel duyệt tài khoản ngân hàng chờ duyệt cho cơ quan giám sát. */

function BankAccountApprovalPanel({ accessToken: verifiedAccessToken }: VerifiedAccessTokenProps) {
  const backendBaseUrl =
    process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:4000";

  const [isLoading, setIsLoading] = useState(false);

  const [isSubmittingReview, setIsSubmittingReview] = useState(false);

  const [isApproveConfirmModalVisible, setIsApproveConfirmModalVisible] =
    useState(false);

  const [errorMessage, setErrorMessage] = useState("");

  const [successMessage, setSuccessMessage] = useState("");

  const [bankAccountApprovalList, setBankAccountApprovalList] = useState<
    BankAccountApprovalItem[]
  >([]);

  const [selectedSubmissionId, setSelectedSubmissionId] = useState("");

  const [rejectReason, setRejectReason] = useState("");

  const selectedBankAccountApproval =
    bankAccountApprovalList.find(
      (item) => item.submissionId === selectedSubmissionId,
    ) || null;

  /** Hàm tải danh sách tài khoản ngân hàng đang chờ duyệt từ backend. */

  const loadPendingBankAccountApprovalList = useCallback(async () => {
    const accessToken = verifiedAccessToken || readAuthSession().accessToken || "";

    if (!accessToken) {
      setErrorMessage(
        "Bạn cần đăng nhập tài khoản cơ quan giám sát để duyệt tài khoản ngân hàng.",
      );

      return;
    }

    setIsLoading(true);

    setErrorMessage("");

    try {
      const response = await fetch(
        `${backendBaseUrl}/auth/organization/kyc-submissions/pending`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
        },
      );

      const responseData = await response.json();

      if (!response.ok) {
        throw new Error(
          responseData?.message ||
            "Không thể tải danh sách tài khoản ngân hàng chờ duyệt.",
        );
      }

      const normalizedBankAccountApprovalList = Array.isArray(
        responseData?.submissions,
      )
        ? (responseData.submissions as unknown[])

            .filter(
              (submissionItem): submissionItem is Record<string, unknown> => {
                if (!submissionItem || typeof submissionItem !== "object") {
                  return false;
                }

                // Ghi chú logic phức tạp: cần kiểm tra key tồn tại bằng toán tử in trước khi truy cập để tránh lỗi type ở chế độ strict.

                return "beneficiaryBankAccount" in submissionItem;
              },
            )
            .filter((submissionItem) => submissionItem.organizationCategory !== "FOUNDATION")

            .map((submissionItem) => {
              const rawBankAccount = submissionItem.beneficiaryBankAccount;

              const bankAccount =
                rawBankAccount && typeof rawBankAccount === "object"
                  ? (rawBankAccount as Record<string, unknown>)
                  : {};

              return {
                submissionId:
                  typeof submissionItem.submissionId === "string"
                    ? submissionItem.submissionId
                    : "",

                organizationId:
                  typeof submissionItem.organizationId === "string"
                    ? submissionItem.organizationId
                    : "",

                organizationName:
                  typeof submissionItem.organizationName === "string"
                    ? submissionItem.organizationName
                    : "Chưa cập nhật",

                status:
                  typeof submissionItem.status === "string"
                    ? submissionItem.status
                    : "PENDING_REVIEW",

                submittedAt:
                  typeof submissionItem.submittedAt === "string"
                    ? submissionItem.submittedAt
                    : "",

                beneficiaryBankAccount: {
                  bankName:
                    typeof bankAccount.bankName === "string"
                      ? bankAccount.bankName
                      : "Chưa cập nhật",

                  bankAccountNumber:
                    typeof bankAccount.bankAccountNumber === "string"
                      ? bankAccount.bankAccountNumber
                      : "Chưa cập nhật",

                  accountHolderName:
                    typeof bankAccount.accountHolderName === "string"
                      ? bankAccount.accountHolderName
                      : "Chưa cập nhật",

                  branchName:
                    typeof bankAccount.branchName === "string"
                      ? bankAccount.branchName
                      : null,
                },
              };
            })

            .filter((item) => item.submissionId.length > 0)
        : [];

      setBankAccountApprovalList(normalizedBankAccountApprovalList);

      setSelectedSubmissionId((previousSubmissionId) => {
        const hasPreviousItem = normalizedBankAccountApprovalList.some(
          (item) => item.submissionId === previousSubmissionId,
        );

        if (hasPreviousItem) {
          return previousSubmissionId;
        }

        return normalizedBankAccountApprovalList[0]?.submissionId || "";
      });
    } catch (_error) {
      setErrorMessage(
        "Không thể tải danh sách tài khoản ngân hàng chờ duyệt. Vui lòng thử lại.",
      );
    } finally {
      setIsLoading(false);
    }
  }, [backendBaseUrl, verifiedAccessToken]);

  /** Hàm ánh xạ lỗi theo mã HTTP sang thông báo tiếng Việt thân thiện với người dùng. */

  const getReviewErrorMessageByStatusCode = useCallback(
    (statusCode: number): string => {
      if (statusCode === 401)
        return "Lỗi xác thực hoặc phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.";

      if (statusCode === 403)
        return "Bạn không có quyền thực hiện thao tác này. Chỉ cơ quan regulatory được phép.";

      if (statusCode >= 500)
        return "Hệ thống đang bận hoặc gặp sự cố. Vui lòng thử lại sau.";

      return "Không thể cập nhật kết quả duyệt tài khoản ngân hàng.";
    },
    [],
  );

  /** Hàm gửi kết quả duyệt hoặc từ chối tài khoản ngân hàng lên backend. */

  const submitBankAccountReview = useCallback(
    async (action: "approve" | "reject") => {
      if (!selectedBankAccountApproval) {
        return;
      }

      const normalizedRejectReason = rejectReason.trim();

      if (action === "reject" && normalizedRejectReason.length === 0) {
        setErrorMessage("Vui lòng nhập lý do từ chối trước khi xác nhận.");

        return;
      }

      if (action === "reject" && normalizedRejectReason.length > 500) {
        setErrorMessage("Lý do từ chối không được vượt quá 500 ký tự.");

        return;
      }

      const accessToken = verifiedAccessToken || readAuthSession().accessToken || "";

      if (!accessToken) {
        setErrorMessage(
          "Lỗi xác thực hoặc phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.",
        );

        return;
      }

      setIsSubmittingReview(true);

      setErrorMessage("");

      setSuccessMessage("");

      try {
        const reviewResponse = await fetch(
          `${backendBaseUrl}/auth/organization/kyc-submissions/${selectedBankAccountApproval.submissionId}/review`,
          {
            method: "PATCH",

            headers: {
              "Content-Type": "application/json",

              Authorization: `Bearer ${accessToken}`,
            },

            body: JSON.stringify({
              action,

              rejectionReason:
                action === "reject" ? normalizedRejectReason : undefined,
            }),
          },
        );

        const reviewResponseData = await reviewResponse.json();

        if (!reviewResponse.ok) {
          const fallbackErrorMessage = getReviewErrorMessageByStatusCode(
            reviewResponse.status,
          );

          throw new Error(reviewResponseData?.message || fallbackErrorMessage);
        }

        setRejectReason("");

        setIsApproveConfirmModalVisible(false);

        setSuccessMessage(
          action === "approve"
            ? "Phê duyệt tài khoản ngân hàng thành công."
            : "Từ chối tài khoản ngân hàng thành công.",
        );

        await loadPendingBankAccountApprovalList();
      } catch (error) {
        setErrorMessage(
          error instanceof Error
            ? error.message
            : "Hệ thống đang bận hoặc gặp sự cố. Vui lòng thử lại sau.",
        );
      } finally {
        setIsSubmittingReview(false);
      }
    },
    [
      backendBaseUrl,
      getReviewErrorMessageByStatusCode,
      loadPendingBankAccountApprovalList,
      rejectReason,
      selectedBankAccountApproval,
      verifiedAccessToken,
    ],
  );

  /** Hàm mở hộp thoại xác nhận trước khi phê duyệt để tránh thao tác nhầm. */

  const openApproveConfirmModal = (): void => {
    if (isSubmittingReview) {
      return;
    }

    setErrorMessage("");

    setSuccessMessage("");

    setIsApproveConfirmModalVisible(true);
  };

  /** Hàm đóng hộp thoại xác nhận phê duyệt. */

  const closeApproveConfirmModal = (): void => {
    if (isSubmittingReview) {
      return;
    }

    setIsApproveConfirmModalVisible(false);
  };

  /** Hàm tải dữ liệu khi người dùng mở tab duyệt tài khoản ngân hàng. */

  useEffect(() => {
    loadPendingBankAccountApprovalList();
  }, [loadPendingBankAccountApprovalList]);

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-emerald-900/15 bg-white px-5 py-4">
        <h2 className="text-lg font-bold text-slate-900">
          Duyệt tài khoản ngân hàng
        </h2>

        <p className="mt-1 text-xs text-slate-500">
          Danh sách tài khoản ngân hàng thụ hưởng đang chờ cơ quan giám sát phê
          duyệt.
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

      <div className="overflow-hidden rounded-xl border border-emerald-900/15 bg-white">
        <div className="border-b border-emerald-900/15 px-5 py-3 text-sm font-bold text-slate-900">
          Danh sách chờ duyệt
        </div>

        <div className="overflow-x-auto">
          <table className="min-w-full text-left">
            <thead className="bg-slate-50 text-[10px] uppercase tracking-[0.08em] text-slate-500">
              <tr>
                <th className="px-5 py-2.5 font-semibold">Tên tổ chức</th>

                <th className="px-5 py-2.5 font-semibold">Chủ tài khoản</th>

                <th className="px-5 py-2.5 font-semibold">Số tài khoản</th>

                <th className="px-5 py-2.5 font-semibold">
                  Ngân hàng / Chi nhánh
                </th>

                <th className="px-5 py-2.5 font-semibold">
                  Trạng thái xác minh
                </th>

                <th className="px-5 py-2.5 font-semibold">Thời gian tạo</th>
              </tr>
            </thead>

            <tbody>
              {isLoading ? (
                <tr>
                  <td colSpan={6} className="px-5 py-3 text-xs text-slate-500">
                    Đang tải danh sách tài khoản ngân hàng chờ duyệt...
                  </td>
                </tr>
              ) : null}

              {!isLoading && bankAccountApprovalList.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-5 py-3 text-xs text-slate-500">
                    Hiện chưa có tài khoản ngân hàng nào đang chờ duyệt.
                  </td>
                </tr>
              ) : null}

              {bankAccountApprovalList.map((item) => (
                <tr
                  key={item.submissionId}
                  className={`border-t border-slate-100 text-sm hover:bg-slate-50 ${selectedSubmissionId === item.submissionId ? "bg-cyan-50" : ""}`}
                >
                  <td className="px-5 py-3 text-xs font-semibold text-slate-900">
                    <button
                      type="button"
                      onClick={() => setSelectedSubmissionId(item.submissionId)}
                      className="text-left hover:text-cyan-700"
                    >
                      {item.organizationName}
                    </button>
                  </td>

                  <td className="px-5 py-3 text-xs text-slate-700">
                    {item.beneficiaryBankAccount.accountHolderName}
                  </td>

                  <td className="px-5 py-3 font-mono text-xs text-slate-700">
                    {maskBankAccountNumber(
                      item.beneficiaryBankAccount.bankAccountNumber,
                    )}
                  </td>

                  <td className="px-5 py-3 text-xs text-slate-700">
                    {item.beneficiaryBankAccount.bankName}
                    {item.beneficiaryBankAccount.branchName
                      ? ` / ${item.beneficiaryBankAccount.branchName}`
                      : ""}
                  </td>

                  <td className="px-5 py-3 text-xs">
                    <span className="inline-flex rounded-md bg-amber-100 px-2 py-1 font-semibold text-amber-700">
                      {getBankAccountReviewStatusText(item.status)}
                    </span>
                  </td>

                  <td className="px-5 py-3 text-xs text-slate-600">
                    {item.submittedAt
                      ? new Date(item.submittedAt).toLocaleString("vi-VN")
                      : "Chưa cập nhật"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="rounded-xl border border-emerald-900/15 bg-white p-4">
        {selectedBankAccountApproval ? (
          <div className="space-y-3">
            <h3 className="text-sm font-bold text-slate-900">
              Chi tiết tài khoản ngân hàng cần duyệt
            </h3>

            <div className="grid gap-2 text-xs text-slate-700 sm:grid-cols-2">
              <p>
                <span className="font-semibold">Mã hồ sơ:</span>{" "}
                {selectedBankAccountApproval.submissionId}
              </p>

              <p>
                <span className="font-semibold">Mã tổ chức:</span>{" "}
                {selectedBankAccountApproval.organizationId}
              </p>

              <p>
                <span className="font-semibold">Tên tổ chức:</span>{" "}
                {selectedBankAccountApproval.organizationName}
              </p>

              <p>
                <span className="font-semibold">Tên chủ tài khoản:</span>{" "}
                {
                  selectedBankAccountApproval.beneficiaryBankAccount
                    .accountHolderName
                }
              </p>

              <p>
                <span className="font-semibold">Số tài khoản:</span>{" "}
                {
                  selectedBankAccountApproval.beneficiaryBankAccount
                    .bankAccountNumber
                }
              </p>

              <p>
                <span className="font-semibold">Ngân hàng:</span>{" "}
                {selectedBankAccountApproval.beneficiaryBankAccount.bankName}
              </p>

              <p>
                <span className="font-semibold">Chi nhánh:</span>{" "}
                {selectedBankAccountApproval.beneficiaryBankAccount
                  .branchName || "Chưa cập nhật"}
              </p>

              <p>
                <span className="font-semibold">Trạng thái xác minh:</span>{" "}
                {getBankAccountReviewStatusText(
                  selectedBankAccountApproval.status,
                )}
              </p>

              <p className="sm:col-span-2">
                <span className="font-semibold">Thời gian tạo:</span>{" "}
                {selectedBankAccountApproval.submittedAt
                  ? new Date(
                      selectedBankAccountApproval.submittedAt,
                    ).toLocaleString("vi-VN")
                  : "Chưa cập nhật"}
              </p>
            </div>

            <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3">
              <label className="block text-xs font-semibold text-amber-800">
                Lý do từ chối (bắt buộc khi từ chối)
              </label>

              <textarea
                value={rejectReason}
                onChange={(event) => setRejectReason(event.target.value)}
                rows={3}
                maxLength={500}
                className="w-full rounded border border-amber-200 px-2 py-1 text-xs outline-none"
                placeholder="Nhập lý do từ chối tài khoản ngân hàng..."
              />

              <p className="text-[11px] text-amber-700">{`${rejectReason.trim().length}/500 ký tự`}</p>
            </div>

            <div className="flex gap-2">
              <button
                type="button"
                disabled={isSubmittingReview}
                onClick={() => submitBankAccountReview("reject")}
                className="rounded bg-red-600 px-3 py-2 text-xs font-bold text-white disabled:opacity-50"
              >
                {isSubmittingReview ? "Đang xử lý..." : "Từ chối"}
              </button>

              <button
                type="button"
                disabled={isSubmittingReview}
                onClick={openApproveConfirmModal}
                className="rounded bg-emerald-600 px-3 py-2 text-xs font-bold text-white disabled:opacity-50"
              >
                {isSubmittingReview ? "Đang xử lý..." : "Phê duyệt"}
              </button>
            </div>
          </div>
        ) : (
          <p className="text-xs text-slate-500">
            Chọn một tài khoản ngân hàng trong danh sách để xem chi tiết và
            duyệt.
          </p>
        )}
      </div>

      {isApproveConfirmModalVisible && selectedBankAccountApproval ? (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/60 p-4">
          <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-5 shadow-lg">
            <h4 className="text-sm font-bold text-slate-900">
              Xác nhận phê duyệt tài khoản ngân hàng
            </h4>

            <p className="mt-2 text-xs text-slate-600">
              Bạn có chắc chắn muốn phê duyệt tài khoản của tổ chức{" "}
              <span className="font-semibold">
                {selectedBankAccountApproval.organizationName}
              </span>
              ?
            </p>

            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                disabled={isSubmittingReview}
                onClick={closeApproveConfirmModal}
                className="rounded border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 disabled:opacity-50"
              >
                Hủy
              </button>

              <button
                type="button"
                disabled={isSubmittingReview}
                onClick={() => submitBankAccountReview("approve")}
                className="rounded bg-emerald-600 px-3 py-2 text-xs font-bold text-white disabled:opacity-50"
              >
                {isSubmittingReview ? "Đang xử lý..." : "Xác nhận phê duyệt"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

const reportMetricItemList = [
  {
    labelText: "Tổng yêu cầu giải ngân",
    valueText: "42",
    toneClassName: "text-cyan-700 bg-cyan-50 border-cyan-100",
  },

  {
    labelText: "Đã phê duyệt (90.5%)",
    valueText: "38",
    toneClassName: "text-emerald-700 bg-emerald-50 border-emerald-100",
  },

  {
    labelText: "Từ chối / Trả lại",
    valueText: "4",
    toneClassName: "text-amber-700 bg-amber-50 border-amber-100",
  },

  {
    labelText: "Tổng giá trị phê duyệt (VNĐ)",
    valueText: "12.4T",
    toneClassName: "text-indigo-700 bg-indigo-50 border-indigo-100",
  },
];

const kycApprovalRateItemList: KycApprovalRateItem[] = [
  {
    labelText: "Đã phê duyệt",
    valueText: "19 (76%)",
    progressWidthText: "76%",
    barClassName: "bg-emerald-500",
    valueClassName: "text-emerald-700",
  },

  {
    labelText: "Đang xét duyệt",
    valueText: "5 (20%)",
    progressWidthText: "20%",
    barClassName: "bg-amber-500",
    valueClassName: "text-amber-700",
  },

  {
    labelText: "Từ chối",
    valueText: "1 (4%)",
    progressWidthText: "4%",
    barClassName: "bg-red-500",
    valueClassName: "text-red-700",
  },
];

const reportSummaryItemList = [
  {
    monthText: "Tháng 1/2026",
    totalRequestCountText: "14",
    approvedCountText: "13",
    rejectedCountText: "1",
    totalAmountText: "3,620,000,000",
    approvedRateText: "92.9%",
    resultText: "Đạt",
    resultClassName: "bg-emerald-100 text-emerald-700",
  },

  {
    monthText: "Tháng 2/2026",
    totalRequestCountText: "12",
    approvedCountText: "11",
    rejectedCountText: "1",
    totalAmountText: "2,810,000,000",
    approvedRateText: "91.7%",
    resultText: "Đạt",
    resultClassName: "bg-emerald-100 text-emerald-700",
  },

  {
    monthText: "Tháng 3/2026",
    totalRequestCountText: "16",
    approvedCountText: "14",
    rejectedCountText: "2",
    totalAmountText: "4,200,000,000",
    approvedRateText: "87.5%",
    resultText: "Đạt",
    resultClassName: "bg-emerald-100 text-emerald-700",
  },
];

/** Hàm hiển thị panel Báo cáo Tuân thủ theo bố cục tương ứng file mẫu. */

function ReportPanel() {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-emerald-900/15 bg-white px-5 py-4">
        <div>
          <h2 className="text-lg font-bold text-slate-900">Báo cáo Tuân thủ</h2>

          <p className="mt-1 text-xs text-slate-500">
            Tổng hợp dữ liệu giám sát theo kỳ báo cáo
          </p>
        </div>

        <div className="flex items-center gap-2">
          <select className="h-9 rounded-lg border border-slate-200 bg-white px-2.5 text-xs text-slate-700">
            <option>Quý 1/2026</option>
            <option>Tháng 3/2026</option>
            <option>Tháng 2/2026</option>
          </select>

          <button
            type="button"
            className="inline-flex h-9 items-center gap-2 rounded-lg bg-[#0E7C6B] px-3 text-xs font-semibold text-white transition hover:bg-[#0A5C50] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1AAE97]/40 active:translate-y-px"
          >
            Xuất PDF
          </button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {reportMetricItemList.map((reportMetricItem) => (
          <div
            key={reportMetricItem.labelText}
            className="rounded-xl border border-emerald-900/15 bg-white p-4"
          >
            <p className="text-2xl font-bold text-slate-900">
              {reportMetricItem.valueText}
            </p>

            <span
              className={`mt-1 inline-flex rounded-md border px-2 py-1 text-xs font-semibold ${reportMetricItem.toneClassName}`}
            >
              {reportMetricItem.labelText}
            </span>
          </div>
        ))}
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <MonthlyDisbursementCard />

        <div className="overflow-hidden rounded-xl border border-emerald-900/15 bg-white">
          <div className="border-b border-emerald-900/15 px-5 py-3 text-sm font-bold text-slate-900">
            Tỷ lệ phê duyệt KYC
          </div>

          <div className="space-y-3 p-5">
            {kycApprovalRateItemList.map((kycApprovalRateItem) => (
              <div
                key={kycApprovalRateItem.labelText}
                className="grid grid-cols-[100px_1fr_auto] items-center gap-2 text-xs"
              >
                <span className="text-slate-700">
                  {kycApprovalRateItem.labelText}
                </span>

                <div className="h-2 rounded-full bg-slate-100">
                  <div
                    className={`h-2 rounded-full ${kycApprovalRateItem.barClassName}`}
                    style={{ width: kycApprovalRateItem.progressWidthText }}
                  />
                </div>

                <span
                  className={`font-semibold ${kycApprovalRateItem.valueClassName}`}
                >
                  {kycApprovalRateItem.valueText}
                </span>
              </div>
            ))}

            <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-700">
              ✅ Tỷ lệ phê duyệt <strong>96%</strong> đạt chỉ tiêu quý
            </div>
          </div>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-emerald-900/15 bg-white">
        <div className="border-b border-emerald-900/15 px-5 py-3 text-sm font-bold text-slate-900">
          Bảng tổng hợp – Quý I/2026
        </div>

        <div className="overflow-x-auto">
          <table className="min-w-full text-left">
            <thead className="bg-slate-50 text-[10px] uppercase tracking-[0.08em] text-slate-500">
              <tr>
                <th className="px-5 py-2.5 font-semibold">Tháng</th>
                <th className="px-5 py-2.5 font-semibold">Tổng yêu cầu</th>
                <th className="px-5 py-2.5 font-semibold">Đã ký</th>
                <th className="px-5 py-2.5 font-semibold">Từ chối</th>
                <th className="px-5 py-2.5 font-semibold">
                  Tổng giá trị (VNĐ)
                </th>
                <th className="px-5 py-2.5 font-semibold">Tỷ lệ duyệt</th>
                <th className="px-5 py-2.5 font-semibold">Trạng thái</th>
              </tr>
            </thead>

            <tbody>
              {reportSummaryItemList.map((reportSummaryItem) => (
                <tr
                  key={reportSummaryItem.monthText}
                  className="border-t border-slate-100 text-sm hover:bg-slate-50"
                >
                  <td className="px-5 py-3 text-xs font-semibold text-slate-900">
                    {reportSummaryItem.monthText}
                  </td>

                  <td className="px-5 py-3 font-mono text-xs text-slate-700">
                    {reportSummaryItem.totalRequestCountText}
                  </td>

                  <td className="px-5 py-3 font-mono text-xs text-emerald-700">
                    {reportSummaryItem.approvedCountText}
                  </td>

                  <td className="px-5 py-3 font-mono text-xs text-red-700">
                    {reportSummaryItem.rejectedCountText}
                  </td>

                  <td className="px-5 py-3 font-mono text-xs text-slate-700">
                    {reportSummaryItem.totalAmountText}
                  </td>

                  <td className="px-5 py-3">
                    <span className="inline-flex rounded-md border border-emerald-200 bg-emerald-100 px-2.5 py-1 text-[11px] font-semibold text-emerald-700">
                      {reportSummaryItem.approvedRateText}
                    </span>
                  </td>

                  <td className="px-5 py-3">
                    <span
                      className={`inline-flex rounded-md border px-2.5 py-1 text-[11px] font-semibold ${reportSummaryItem.resultClassName}`}
                    >
                      {reportSummaryItem.resultText}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

const transparencyTransactionItemList = [
  {
    transactionHashText: "0x3a9f...e7d2",
    transactionTypeText: "Giải ngân",
    transactionTypeClassName: "bg-cyan-100 text-cyan-700 border-cyan-200",
    projectDescriptionText: "Mổ mắt miễn phí Hà Giang",
    senderWalletText: "0xAbC...12F3",
    amountText: "₫200,000,000",
    timeText: "22/03 14:10",
    statusText: "Hoàn tất",
    statusClassName: "bg-emerald-100 text-emerald-700 border-emerald-200",
  },

  {
    transactionHashText: "0xB1d2...9cAe",
    transactionTypeText: "Quyên góp",
    transactionTypeClassName:
      "bg-emerald-100 text-emerald-700 border-emerald-200",
    projectDescriptionText: "Xây trường học Tây Nguyên",
    senderWalletText: "0x7eF...4A21",
    amountText: "₫5,000,000",
    timeText: "22/03 10:33",
    statusText: "Đã ghi nhận",
    statusClassName: "bg-emerald-100 text-emerald-700 border-emerald-200",
  },

  {
    transactionHashText: "0x5F3a...e012",
    transactionTypeText: "Nạp tiền",
    transactionTypeClassName: "bg-amber-100 text-amber-700 border-amber-200",
    projectDescriptionText: "Nạp VNĐ → Token",
    senderWalletText: "0x9bC...77D0",
    amountText: "₫2,000,000",
    timeText: "21/03 16:45",
    statusText: "Đúc token thành công",
    statusClassName: "bg-emerald-100 text-emerald-700 border-emerald-200",
  },

  {
    transactionHashText: "0x2Ec4...d77F",
    transactionTypeText: "Giải ngân",
    transactionTypeClassName: "bg-cyan-100 text-cyan-700 border-cyan-200",
    projectDescriptionText: "Nước sạch Hà Tĩnh",
    senderWalletText: "0xAbC...12F3",
    amountText: "₫150,000,000",
    timeText: "21/03 16:30",
    statusText: "Hoàn tất",
    statusClassName: "bg-emerald-100 text-emerald-700 border-emerald-200",
  },

  {
    transactionHashText: "0x8Ac1...3bD9",
    transactionTypeText: "Quyên góp",
    transactionTypeClassName:
      "bg-emerald-100 text-emerald-700 border-emerald-200",
    projectDescriptionText: "Cứu trợ lũ lụt miền Trung",
    senderWalletText: "0x4Da...E8F2",
    amountText: "₫10,000,000",
    timeText: "21/03 09:15",
    statusText: "Chờ ghi nhận on-chain",
    statusClassName: "bg-amber-100 text-amber-700 border-amber-200",
  },
];

/** Hàm hiển thị panel Tra cứu Giao dịch theo giao diện bảng minh bạch của file mẫu. */

function TransparencyPanel() {
  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-emerald-900/15 bg-white px-5 py-4">
        <h2 className="text-lg font-bold text-slate-900">Tra cứu Giao dịch</h2>

        <p className="mt-1 text-xs text-slate-500">
          Tra cứu minh bạch toàn bộ dòng tiền trên hệ thống
        </p>
      </div>

      <div className="rounded-xl border border-emerald-900/15 bg-white p-3">
        <div className="grid gap-2 xl:grid-cols-[1fr_auto_auto_auto]">
          <div className="flex h-9 items-center gap-2 rounded-lg border border-slate-200 px-3 text-xs text-slate-500">
            <svg
              viewBox="0 0 16 16"
              className="h-3.5 w-3.5"
              fill="currentColor"
              aria-hidden="true"
            >
              <path d="M11.7 10.3l3 3-1.4 1.4-3-3a6 6 0 111.4-1.4zm-5.7 1a4 4 0 100-8 4 4 0 000 8z" />
            </svg>

            <input
              type="text"
              placeholder="Nhập mã dự án, địa chỉ ví hoặc mã giao dịch..."
              className="w-full bg-transparent text-xs text-slate-700 outline-none placeholder:text-slate-400"
            />
          </div>

          <select className="h-9 rounded-lg border border-slate-200 bg-white px-2.5 text-xs text-slate-700">
            <option>Tất cả loại</option>
            <option>Nạp tiền</option>
            <option>Quyên góp</option>
            <option>Giải ngân</option>
          </select>

          <select className="h-9 rounded-lg border border-slate-200 bg-white px-2.5 text-xs text-slate-700">
            <option>Tất cả trạng thái</option>
            <option>Hoàn tất</option>
            <option>Đang chờ xử lý</option>
            <option>Thất bại</option>
          </select>

          <button
            type="button"
            className="h-9 rounded-lg bg-[#1AAE97] px-4 text-xs font-semibold text-[#0A5C50] transition hover:bg-[#129b86] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1AAE97]/40 active:translate-y-px"
          >
            Tìm kiếm
          </button>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-emerald-900/15 bg-white">
        <div className="overflow-x-auto">
          <table className="min-w-full text-left">
            <thead className="bg-slate-50 text-[10px] uppercase tracking-[0.08em] text-slate-500">
              <tr>
                <th className="px-5 py-2.5 font-semibold">TX Hash</th>

                <th className="px-5 py-2.5 font-semibold">Loại GD</th>

                <th className="px-5 py-2.5 font-semibold">Dự án / Mô tả</th>

                <th className="px-5 py-2.5 font-semibold">Người gửi</th>

                <th className="px-5 py-2.5 font-semibold">Số tiền</th>

                <th className="px-5 py-2.5 font-semibold">Thời gian</th>

                <th className="px-5 py-2.5 font-semibold">Trạng thái</th>
              </tr>
            </thead>

            <tbody>
              {transparencyTransactionItemList.map(
                (transparencyTransactionItem) => (
                  <tr
                    key={transparencyTransactionItem.transactionHashText}
                    className="border-t border-slate-100 text-sm hover:bg-slate-50"
                  >
                    <td className="px-5 py-3 font-mono text-xs text-cyan-700 hover:underline">
                      {transparencyTransactionItem.transactionHashText}
                    </td>

                    <td className="px-5 py-3">
                      <span
                        className={`inline-flex rounded-md border px-2.5 py-1 text-[11px] font-semibold ${transparencyTransactionItem.transactionTypeClassName}`}
                      >
                        {transparencyTransactionItem.transactionTypeText}
                      </span>
                    </td>

                    <td className="px-5 py-3 text-xs font-medium text-slate-700">
                      {transparencyTransactionItem.projectDescriptionText}
                    </td>

                    <td className="px-5 py-3 font-mono text-xs text-slate-600">
                      {transparencyTransactionItem.senderWalletText}
                    </td>

                    <td className="px-5 py-3 font-mono text-xs font-semibold text-slate-800">
                      {transparencyTransactionItem.amountText}
                    </td>

                    <td className="px-5 py-3 font-mono text-xs text-slate-600">
                      {transparencyTransactionItem.timeText}
                    </td>

                    <td className="px-5 py-3">
                      <span
                        className={`inline-flex rounded-md border px-2.5 py-1 text-[11px] font-semibold ${transparencyTransactionItem.statusClassName}`}
                      >
                        {transparencyTransactionItem.statusText}
                      </span>
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-between border-t border-emerald-900/15 bg-slate-50 px-5 py-3">
          <span className="text-xs text-slate-500">
            Trang 1 / 156 · Tổng 3,108 giao dịch
          </span>

          <div className="flex items-center gap-1">
            <button
              type="button"
              className="h-7 w-7 rounded-md border border-slate-200 bg-white text-xs text-slate-600 transition hover:bg-[#0F2040] hover:text-white"
            >
              ‹
            </button>

            <button
              type="button"
              className="h-7 w-7 rounded-md border border-[#0F2040] bg-[#0F2040] text-xs text-white"
            >
              1
            </button>

            <button
              type="button"
              className="h-7 w-7 rounded-md border border-slate-200 bg-white text-xs text-slate-600 transition hover:bg-[#0F2040] hover:text-white"
            >
              2
            </button>

            <button
              type="button"
              className="h-7 w-7 rounded-md border border-slate-200 bg-white text-xs text-slate-600 transition hover:bg-[#0F2040] hover:text-white"
            >
              3
            </button>

            <button
              type="button"
              className="h-7 w-7 rounded-md border border-slate-200 bg-white text-xs text-slate-600 transition hover:bg-[#0F2040] hover:text-white"
            >
              ›
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Hàm component NonDashboardPanel để hiển thị nội dung theo tab ngoài tổng quan. */

export default function NonDashboardPanel({
  accessToken,
  selectedPageKey,
  onOpenDisbursementRequest,
  onPushToast,
}: NonDashboardPanelProps) {
  const sectionTitle = getPageTitle(selectedPageKey);

  if (selectedPageKey === "projectReview") {
    return <ProjectReviewPanel onPushToast={onPushToast} />;
  }

  if (selectedPageKey === "bankAccountApproval") {
    return <BankAccountApprovalPanel accessToken={accessToken} />;
  }

  if (selectedPageKey === "foundationKyc") {
    return <FoundationKycApprovalPanel accessToken={accessToken} />;
  }

  if (selectedPageKey === "disbursement") {
    return (
      <DisbursementPanel
        onOpenDisbursementRequest={onOpenDisbursementRequest}
      />
    );
  }

  if (selectedPageKey === "kyc") {
    return <KycPanel accessToken={accessToken} />;
  }

  if (selectedPageKey === "report") {
    return <ReportPanel />;
  }

  if (selectedPageKey === "transparency") {
    return <TransparencyPanel />;
  }

  if (selectedPageKey === "sybilManagement") {
    return <SybilManagementPanel />;
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-emerald-900/15 bg-white p-5">
        <h2 className="text-sm font-bold text-slate-900">{sectionTitle}</h2>

        <p className="mt-1 text-xs text-slate-500">
          Nội dung đang được đồng bộ theo phong cách giao diện tổng quan để nhất
          quán trải nghiệm người dùng.
        </p>
      </div>
    </div>
  );
}
