import { getApiErrorMessage, type ApiErrorResponse } from "../utils/apiClient";

/** Nhãn hiển thị thống nhất cho vai trò kiểm toán trong toàn bộ wizard đăng ký. */
export const AUDITOR_ROLE_LABEL = "Kiểm toán viên";

/** Khóa localStorage dùng chung giữa hai lối vào onboarding của Kiểm toán viên. */
export const AUDITOR_INTENT_STORAGE_KEY = "dcpAuditorOnboardingIntentId";

/** Danh sách ngân hàng nhận tiền được backend PayOS hỗ trợ cho Kiểm toán viên. */
export const AUDITOR_PAYOUT_SUPPORTED_BANKS = [
  { value: "Vietcombank", label: "Vietcombank" },
  { value: "BIDV", label: "BIDV" },
  { value: "VietinBank", label: "VietinBank" },
  { value: "Agribank", label: "Agribank" },
  { value: "ACB", label: "ACB" },
  { value: "MB", label: "MB" },
  { value: "KienlongBank", label: "KienlongBank" },
  { value: "Shinhan Bank", label: "Shinhan Bank" },
  { value: "Techcombank", label: "Techcombank" },
  { value: "VPBank", label: "VPBank" },
  { value: "Sacombank", label: "Sacombank" },
  { value: "TPBank", label: "TPBank" },
  { value: "OCB", label: "OCB" },
  { value: "HDBank", label: "HDBank" },
  { value: "VIB", label: "VIB" },
  { value: "SHB", label: "SHB" },
  { value: "MSB", label: "MSB" },
  { value: "SeABank", label: "SeABank" },
  { value: "LPBank", label: "LPBank" },
] as const;

/** Chuẩn hóa tên chủ tài khoản theo định dạng HOA không dấu mà backend yêu cầu. */
export function normalizeAuditorAccountHolderName(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[Đđ]/g, "D")
    .toUpperCase();
}

/** Ánh xạ lỗi đặc thù của đăng ký Kiểm toán viên rồi ủy quyền lỗi chung cho API client. */
export function getAuditorApiErrorMessage(error: unknown, fallbackMessage: string): string {
  const errorCode = typeof error === "object" && error !== null && "errorCode" in error
    ? (error as Partial<ApiErrorResponse>).errorCode
    : undefined;

  if (errorCode === "RATE_LIMIT_EXCEEDED") {
    return "Bạn đã thử đăng ký quá nhiều lần. Vui lòng thử lại sau khoảng 1 giờ.";
  }

  if (errorCode === "UNAUTHENTICATED") {
    return "Phiên xác thực Google đã hết hạn. Vui lòng bấm lại nút Google.";
  }

  if (errorCode === "INSUFFICIENT_TOKEN_BALANCE") {
    return "Số dư VND không đủ để đặt cọc. Vui lòng nạp thêm VND.";
  }

  if (errorCode === "PAYMASTER_POLICY_MISMATCH") {
    return "Hệ thống chưa thể tài trợ phí gas cho giao dịch đặt cọc. Không có VND nào bị trừ thêm; vui lòng thử lại sau.";
  }

  return getApiErrorMessage(error, fallbackMessage);
}

/** Định dạng số DCT nguyên theo locale Việt Nam vì token có 0 decimals. */
export function formatDctAmount(rawAmount: string): string {
  try {
    return new Intl.NumberFormat("vi-VN").format(BigInt(rawAmount));
  } catch {
    return rawAmount;
  }
}

/** Tiêu đề thông báo khi Kiểm toán viên đã được kích hoạt thành công. */
export const AUDITOR_SUCCESS_TITLE = "🎉 Bạn đã là Kiểm toán viên!";

/** Mô tả thông báo khi quyền kiểm toán đã được kích hoạt on-chain. */
export const AUDITOR_SUCCESS_SUBTITLE = "Cọc đã được xác minh on-chain, quyền kiểm toán đã mở";

/** Mô tả cho bước nạp VND và đặt cọc của wizard Kiểm toán viên. */
export const AUDITOR_STEP_THREE_SUBTITLE = "Nạp VND rồi đặt cọc để hệ thống tự kích hoạt quyền kiểm toán";
