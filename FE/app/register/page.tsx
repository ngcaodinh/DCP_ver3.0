'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { clearAuthSession, persistAuthSession, readAuthSession } from "../utils/authSession";
import {
  executeAuditorStake,
  getAuditorOnboardingStatus,
  registerAuditorIntent,
  resumeAuditorIntent,
  type RegisterAuditorIntentResult,
} from "../utils/auditorOnboarding";
import {
  AUDITOR_INTENT_STORAGE_KEY,
  AUDITOR_PAYOUT_SUPPORTED_BANKS,
  AUDITOR_ROLE_LABEL,
  AUDITOR_STEP_THREE_SUBTITLE,
  AUDITOR_SUCCESS_SUBTITLE,
  AUDITOR_SUCCESS_TITLE,
  formatDctAmount,
  getAuditorApiErrorMessage,
  normalizeAuditorAccountHolderName,
} from "../constants/auditorRegistration";
import { REGISTER_ROLE_CONFIG } from "../constants/registerRoles";
import AuthLegalModal from "../components/AuthLegalModal";

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (options: {
            client_id: string;
            callback: (response: { credential?: string }) => void;
            use_fedcm_for_prompt?: boolean;
          }) => void;
          prompt: (notificationHandler?: (notification: {
            isNotDisplayed?: () => boolean;
            isSkippedMoment?: () => boolean;
            isDismissedMoment?: () => boolean;
            getNotDisplayedReason?: () => string;
            getSkippedReason?: () => string;
            getDismissedReason?: () => string;
          }) => void) => void;
          renderButton: (
            parent: HTMLElement,
            options: {
              type?: "standard" | "icon";
              theme?: "outline" | "filled_blue" | "filled_black";
              size?: "large" | "medium" | "small";
              text?: "signin_with" | "signup_with" | "continue_with" | "signin";
              shape?: "rectangular" | "pill" | "circle" | "square";
              width?: string;
            }
          ) => void;
        };
      };
    };
  }
}

const honeycombOverlayDataUri =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='60' height='52'%3E%3Cpolygon points='30,2 58,16 58,44 30,58 2,44 2,16' fill='none' stroke='rgba(255,255,255,0.07)' stroke-width='1.5'/%3E%3C/svg%3E";

// Ghi chú: Hiển thị lớp nền tổ ong để tạo chiều sâu cho panel xanh.
const HoneycombOverlay = () => (
  <div
    className="pointer-events-none absolute inset-0 z-[1]"
    style={{
      backgroundImage: `url("${honeycombOverlayDataUri}")`,
      backgroundSize: "60px 52px",
      backgroundPosition: "0 0",
      backgroundRepeat: "repeat",
      backgroundColor: "rgba(255, 255, 255, 0.02)",
      outline: "1px dashed rgba(255, 255, 255, 0.25)",
      mixBlendMode: "screen",
      opacity: 1,
    }}
  />
);

// Ghi chú: Lớp radial glow trang trí cho panel trái.
const RadialGlow = ({ className }: { className: string }) => (
  <div className={`pointer-events-none absolute rounded-full ${className}`} />
);

type StepStatus = "upcoming" | "active" | "done";
type RoleType = "donor" | "organization" | "auditor" | null;
// Mở rộng kiểu cho đủ ngữ nghĩa; backend /auth/google-login không trả vai trò auditor.
type AuthenticatedRoleType = "donor" | "organization" | "honor" | "auditor" | null;
type AuditorStakeStage = "NEED_TOKEN" | "AWAITING_PAYMENT" | "READY_TO_STAKE" | "VERIFYING" | "ACTIVATED" | "FAILED" | "RECOVERY_REQUIRED";

type AuditorDepositStatus = "PENDING_PAYMENT" | "PAYMENT_CONFIRMED" | "MINT_COMPLETED" | "FAILED";

type AuditorDepositCreateResult = {
  orderCode: string;
  paymentUrl: string;
  status: "PENDING_PAYMENT";
};

type AuditorDepositStatusResult = {
  status: AuditorDepositStatus;
  paymentUrl?: string;
  paymentExpiredAt?: string;
  failureReason?: string | null;
  isPaymentConfirmedButMintFailed?: boolean;
};

const MINIMUM_AUDITOR_DEPOSIT_AMOUNT = 10_000n;
const MAX_SAFE_AUDITOR_DEPOSIT_AMOUNT = BigInt(Number.MAX_SAFE_INTEGER);
const AUDITOR_DEPOSIT_STATUSES: readonly AuditorDepositStatus[] = ["PENDING_PAYMENT", "PAYMENT_CONFIRMED", "MINT_COMPLETED", "FAILED"];
const AUDITOR_STAKE_THRESHOLD_STORAGE_KEY = "dcpAuditorOnboardingStakeThreshold";
const AUDITOR_WALLET_ADDRESS_STORAGE_KEY = "dcpAuditorOnboardingWalletAddress";
const AUDITOR_PAYMENT_RETURN_FLOW = "auditor_onboarding";
const PAYOS_SUCCESS_CALLBACK_STATUSES = new Set(["PAID", "SUCCESS", "COMPLETED"]);
const AUDITOR_ONCHAIN_STATUS_POLL_INTERVAL_MS = 5_000;
const AUDITOR_AUTO_STAKE_RETRY_INTERVAL_MS = 5_000;
const AUDITOR_AUTO_STAKE_MAX_ATTEMPTS = 2;
const AUDITOR_LOGIN_REDIRECT_DELAY_MS = 3_000;

/** Đọc errorCode an toàn từ payload lỗi để xử lý các nhánh nghiệp vụ đặc thù. */
const getApiErrorCode = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null || !("errorCode" in error)) {
    return undefined;
  }

  const errorCode = (error as { errorCode?: unknown }).errorCode;
  return typeof errorCode === "string" ? errorCode : undefined;
};

/** Chỉ chấp nhận URL thanh toán HTTPS tuyệt đối trước khi mở tab hoặc render liên kết bên ngoài. */
const getSafeAuditorPaymentUrl = (value: unknown): string | null => {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  try {
    const parsedUrl = new URL(value);
    return parsedUrl.protocol === "https:" ? parsedUrl.toString() : null;
  } catch {
    return null;
  }
};

/** Rút gọn địa chỉ ví cho panel Auditor, giữ 6 ký tự đầu và 4 ký tự cuối để vẫn nhận diện được ví. */
const formatAuditorWalletAddress = (walletAddress: string): string => {
  if (walletAddress.length <= 10) {
    return walletAddress;
  }

  return `${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`;
};

/** Chuẩn hóa số dư DCT từ API thành số nguyên không âm để không lưu dữ liệu sai vào state. */
const normalizeAuditorTokenBalance = (value: unknown): string | null => {
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return value;
  }

  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }

  return null;
};

/** Kiểm tra object JSON tối thiểu trước khi đọc các trường từ response API không đáng tin cậy. */
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** Xác nhận trạng thái deposit nằm trong contract PayOS mà UI có thể xử lý. */
const isAuditorDepositStatus = (value: unknown): value is AuditorDepositStatus =>
  typeof value === "string" && AUDITOR_DEPOSIT_STATUSES.includes(value as AuditorDepositStatus);

/** Xác thực response tạo phiếu nạp trước khi chuyển UI sang trạng thái chờ thanh toán. */
const isAuditorDepositCreateResult = (value: unknown): value is AuditorDepositCreateResult =>
  isRecord(value)
  && typeof value.orderCode === "string"
  && value.orderCode.trim().length > 0
  && typeof value.paymentUrl === "string"
  && value.status === "PENDING_PAYMENT";

/** Xác thực response trạng thái deposit để tránh UI kẹt khi backend trả dữ liệu 2xx ngoài contract. */
const isAuditorDepositStatusResult = (value: unknown): value is AuditorDepositStatusResult => {
  if (!isRecord(value) || !isAuditorDepositStatus(value.status)) {
    return false;
  }

  const paymentUrlIsValid = value.paymentUrl === undefined || typeof value.paymentUrl === "string";
  const paymentExpiryIsValid = value.paymentExpiredAt === undefined
    || (typeof value.paymentExpiredAt === "string" && Number.isFinite(Date.parse(value.paymentExpiredAt)));
  const failureReasonIsValid = value.failureReason === undefined
    || value.failureReason === null
    || typeof value.failureReason === "string";
  const mintFailureStatusIsValid = value.isPaymentConfirmedButMintFailed === undefined
    || typeof value.isPaymentConfirmedButMintFailed === "boolean";
  return paymentUrlIsValid && paymentExpiryIsValid && failureReasonIsValid && mintFailureStatusIsValid;
};

/**
 * Lấy orderCode từ callback PayOS thành công của luồng kích hoạt Auditor.
 * Các tham số trên URL chỉ cho phép bắt đầu đối soát; backend vẫn xác minh trực tiếp với PayOS trước khi mint.
 */
const getSuccessfulAuditorPaymentReturnOrderCode = (searchParams: URLSearchParams): string | null => {
  const orderCode = searchParams.get("orderCode") || "";
  const isAuditorPaymentReturn = searchParams.get("role") === "auditor"
    && searchParams.get("paymentFlow") === AUDITOR_PAYMENT_RETURN_FLOW
    && /^\d{1,20}$/.test(orderCode);
  const isPaymentExplicitlyCancelled = searchParams.get("cancel")?.trim().toLowerCase() === "true";
  if (!isAuditorPaymentReturn || isPaymentExplicitlyCancelled) {
    return null;
  }

  const hasConfiguredSuccessStatus = searchParams.get("paymentStatus")?.trim().toLowerCase() === "success";
  const hasPayosSuccessStatus = searchParams.get("code")?.trim() === "00"
    && PAYOS_SUCCESS_CALLBACK_STATUSES.has(searchParams.get("status")?.trim().toUpperCase() || "")
    && searchParams.get("cancel")?.trim().toLowerCase() === "false";

  return hasConfiguredSuccessStatus || hasPayosSuccessStatus ? orderCode : null;
};

type StepStyle = {
  circleClass: string;
  labelClass: string;
  connectorClass?: string;
  isDone: boolean;
};

type StepIndicatorState = {
  first: StepStyle;
  second: StepStyle;
  third?: StepStyle;
  showSecondConnector: boolean;
  showThird: boolean;
};

// Ghi chú: Tạo class Tailwind cho vòng tròn step theo trạng thái.
const resolveStepCircleClass = (status: StepStatus): string => {
  const baseClassName =
    "relative flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-sm font-bold transition-all";

  if (status === "active") {
    return `${baseClassName} bg-teal-600 text-white shadow-[0_2px_10px_rgba(14,124,107,0.35)]`;
  }

  if (status === "done") {
    return `${baseClassName} bg-emerald-500 text-white`;
  }

  return `${baseClassName} border border-gray-200 bg-gray-100 text-gray-400`;
};

// Ghi chú: Tạo class Tailwind cho nhãn step theo trạng thái.
const resolveStepLabelClass = (status: StepStatus): string => {
  const baseClassName =
    "max-w-[80px] text-center text-[11px] font-medium leading-[1.3] text-gray-400 transition-colors";

  if (status === "active") {
    return `${baseClassName} text-teal-600 font-semibold`;
  }

  if (status === "done") {
    return `${baseClassName} text-emerald-500`;
  }

  return baseClassName;
};

// Ghi chú: Tạo class Tailwind cho đường nối step.
const resolveStepConnectorClass = (isDone: boolean): string => {
  const baseClassName =
    "mx-2 mb-[22px] h-0.5 max-w-[60px] flex-1 rounded transition-colors";

  return `${baseClassName} ${isDone ? "bg-emerald-500" : "bg-gray-200"}`;
};

type LoadingTexts = {
  title: string;
  subtitle: string;
};

type UploadInfo = {
  id: string;
  name: string;
  sizeLabel: string;
  icon: string;
};

const defaultLoadingText: LoadingTexts = {
  title: "Đang tạo Smart Account...",
  subtitle: "Kết nối với Amoy Testnet",
};

const donorSuccessTitle = "🎉 Chào mừng đến với DCP!";
const donorSuccessSubtitle = "Tài khoản Donor của bạn đã sẵn sàng";
const organizationSuccessTitle = "📬 Hồ sơ đã được gửi!";
const organizationSuccessSubtitle = "Chúng tôi sẽ xem xét trong 1–3 ngày làm việc";

const fallbackSmartAccountAddress = "0x3a4f...9b2c (Amoy Testnet)";

const knowYourCustomerCharacterLimit = 300;
const maxUploadBytes = 10 * 1024 * 1024;
const maximumKycFileCount = 3;
const acceptedKycMimeTypes = ["application/pdf", "image/png", "image/jpeg"];


// Ghi chú: Tạo cấu hình class cho vòng tròn và nhãn bước.
const createStepStyle = (status: StepStatus, labelStatus: StepStatus, isDone: boolean): StepStyle => ({
  circleClass: resolveStepCircleClass(status),
  labelClass: resolveStepLabelClass(labelStatus),
  isDone,
});

// Ghi chú: Xây dựng trạng thái step indicator dựa theo bước và vai trò.
const buildStepIndicatorState = (currentStep: number, roleType: RoleType): StepIndicatorState => {
  const shouldShowThirdStep = REGISTER_ROLE_CONFIG[roleType ?? "donor"].hasThirdStep;
  const secondStatus: StepStatus = currentStep >= 2 ? (currentStep === 2 ? "active" : "done") : "upcoming";

  return {
    first: createStepStyle(currentStep > 1 ? "done" : "active", currentStep >= 1 ? "active" : "upcoming", currentStep > 1),
    second: {
      ...createStepStyle(secondStatus, currentStep >= 2 ? "active" : "upcoming", currentStep > 2),
      connectorClass: resolveStepConnectorClass(currentStep >= 2),
    },
    third: shouldShowThirdStep
      ? {
        ...createStepStyle(currentStep === 3 ? "active" : "upcoming", currentStep === 3 ? "active" : "upcoming", false),
        connectorClass: resolveStepConnectorClass(currentStep >= 3),
      }
      : undefined,
    showSecondConnector: shouldShowThirdStep,
    showThird: shouldShowThirdStep,
  };
};

// Ghi chú: Định dạng dung lượng file để hiển thị thân thiện.
const formatFileSize = (fileSize: number): string => {
  if (fileSize >= 1024 * 1024) {
    return `${(fileSize / (1024 * 1024)).toFixed(2)} MB`;
  }

  return `${(fileSize / 1024).toFixed(2)} KB`;
};

// Ghi chú: Chọn biểu tượng phù hợp theo định dạng file.
const resolveUploadIcon = (fileName: string): string => {
  const lowercaseName = fileName.toLowerCase();

  if (lowercaseName.endsWith(".pdf")) {
    return "📄";
  }

  if (lowercaseName.endsWith(".png") || lowercaseName.endsWith(".jpg") || lowercaseName.endsWith(".jpeg")) {
    return "🖼️";
  }

  return "📎";
};

// Ghi chú: Tạo thông tin hiển thị file upload.
const createUploadInfo = (file: File): UploadInfo => ({
  id: `${file.name}-${file.lastModified}`,
  name: file.name,
  sizeLabel: formatFileSize(file.size),
  icon: resolveUploadIcon(file.name),
});

/**
 * Hàm chuyển file sang chuỗi base64.
 * Mục đích: chuẩn hóa dữ liệu file để gửi trong payload JSON đến backend.
 */
const convertFileToBase64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const fileReader = new FileReader();
    fileReader.onload = () => {
      const readerResult = fileReader.result;
      if (typeof readerResult !== "string") {
        reject(new Error("Không thể đọc nội dung file upload."));
        return;
      }

      const base64Content = readerResult.includes(",") ? readerResult.split(",")[1] : readerResult;
      resolve(base64Content);
    };
    fileReader.onerror = () => reject(new Error("Không thể đọc nội dung file upload."));
    fileReader.readAsDataURL(file);
  });

// Ghi chú: Trang đăng ký tài khoản DCP theo luồng nhiều bước.
export default function RegisterPage() {
  const [currentStep, setCurrentStep] = useState<number>(1);
  const [selectedRole, setSelectedRole] = useState<RoleType>(null);
  const [isTermsAccepted, setIsTermsAccepted] = useState<boolean>(false);
  const [termsError, setTermsError] = useState<string>('');
  const [isInfoCollapsed, setIsInfoCollapsed] = useState<boolean>(false);
  const [isLoadingVisible, setIsLoadingVisible] = useState<boolean>(false);
  const [loadingTexts, setLoadingTexts] = useState<LoadingTexts>(defaultLoadingText);
  const [isDonorSuccessVisible, setIsDonorSuccessVisible] = useState<boolean>(false);
  const [isOrganizationSuccessVisible, setIsOrganizationSuccessVisible] = useState<boolean>(false);
  const [isProgressLoading, setIsProgressLoading] = useState<boolean>(false);
  const [isGoogleSuccessVisible, setIsGoogleSuccessVisible] = useState<boolean>(false);
  const [organizationName, setOrganizationName] = useState<string>("");
  const [organizationTaxCode, setOrganizationTaxCode] = useState<string>("");
  const [organizationWebsite, setOrganizationWebsite] = useState<string>("");
  const [organizationDescription, setOrganizationDescription] = useState<string>("");
  const [organizationFiles, setOrganizationFiles] = useState<File[]>([]);
  const [uploadInfoList, setUploadInfoList] = useState<UploadInfo[]>([]);
  const [isUploadHover, setIsUploadHover] = useState<boolean>(false);
  const [isCopySuccess, setIsCopySuccess] = useState<boolean>(false);

  const [isRegisterProcessing, setIsRegisterProcessing] = useState<boolean>(false);
  const [registerErrorMessage, setRegisterErrorMessage] = useState<string>("");
  const [kycSubmitErrorMessage, setKycSubmitErrorMessage] = useState<string>("");
  const [createdWalletAddress, setCreatedWalletAddress] = useState<string>("");
  const [registeredUserEmail, setRegisteredUserEmail] = useState<string>("");
  const [authenticatedRole, setAuthenticatedRole] = useState<AuthenticatedRoleType>(null);
  const [auditorGoogleCredential, setAuditorGoogleCredential] = useState<string>("");
  const [auditorBankName, setAuditorBankName] = useState<string>("");
  const [auditorBankAccountNumber, setAuditorBankAccountNumber] = useState<string>("");
  const [auditorAccountHolderName, setAuditorAccountHolderName] = useState<string>("");
  const [auditorBranchName, setAuditorBranchName] = useState<string>("");
  const [auditorIntentId, setAuditorIntentId] = useState<string>("");
  const [auditorMinimumStakeThreshold, setAuditorMinimumStakeThreshold] = useState<string>("");
  const [auditorTokenBalance, setAuditorTokenBalance] = useState<string>("");
  const [auditorStakeStage, setAuditorStakeStage] = useState<AuditorStakeStage>("NEED_TOKEN");
  const [auditorStakeTxHash, setAuditorStakeTxHash] = useState<string>("");
  const [auditorStatusMessage, setAuditorStatusMessage] = useState<string>("");
  const [auditorErrorMessage, setAuditorErrorMessage] = useState<string>("");
  const [isAuditorSuccessVisible, setIsAuditorSuccessVisible] = useState<boolean>(false);
  const [isAuditorMintFailureVisible, setIsAuditorMintFailureVisible] = useState<boolean>(false);
  const [auditorDepositOrderCode, setAuditorDepositOrderCode] = useState<string>("");
  const [auditorDepositPaymentUrl, setAuditorDepositPaymentUrl] = useState<string>("");
  const [auditorDepositExpiresAt, setAuditorDepositExpiresAt] = useState<string>("");
  const [isAuditorAutoCompletionPending, setIsAuditorAutoCompletionPending] = useState<boolean>(false);
  const reconciledAuditorPaymentOrderCodeRef = useRef<string>("");
  const auditorAutoStakeAttemptRef = useRef<number>(0);
  const hasAuditorAutoStakeSubmissionRef = useRef<boolean>(false);

  // State cho modal pháp lý (điều khoản sử dụng / chính sách bảo mật).
  const [isLegalModalOpen, setIsLegalModalOpen] = useState<boolean>(false);
  const [legalModalVariant, setLegalModalVariant] = useState<'terms' | 'privacy'>('terms');
  // Ref cho link đã kích hoạt mở modal (dùng để trả focus khi đóng).
  const termsLinkRef = useRef<HTMLAnchorElement>(null);
  const privacyLinkRef = useRef<HTMLAnchorElement>(null);

  const backendBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:4000";
  const router = useRouter();

  /**
   * Hàm chuẩn hóa Google Client ID từ biến môi trường.
   * Mục đích: loại bỏ khoảng trắng thừa gây lỗi thiếu client_id khi khởi tạo GSI.
   */
  const normalizeGoogleClientId = (rawGoogleClientId: string): string => rawGoogleClientId.trim();

  /**
   * Hàm kiểm tra định dạng Google Client ID.
   * Mục đích: đảm bảo chỉ khởi tạo GSI khi client ID hợp lệ.
   */
  const isGoogleClientIdValid = (googleClientIdValue: string): boolean =>
    googleClientIdValue.length > 0 && googleClientIdValue.includes(".apps.googleusercontent.com");

  const googleClientId = normalizeGoogleClientId(
    process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || ""
  );
  const googleRedirectButtonContainerId = "googleRedirectButtonContainer";

  const stepIndicatorState = useMemo(
    () => buildStepIndicatorState(currentStep, selectedRole),
    [currentStep, selectedRole]
  );

  const roleConfig = REGISTER_ROLE_CONFIG[selectedRole ?? "donor"];
  const [secondStepPrimaryLabel, secondStepSecondaryLabel] = roleConfig.stepLabels.second.split("|");
  const [thirdStepPrimaryLabel, thirdStepSecondaryLabel] = roleConfig.stepLabels.third.split("|");
  const greetingText = roleConfig.greeting;
  const subtitleText = roleConfig.subtitle;
  const roleBadgeText = roleConfig.badge;

  const isKycReady =
    organizationName.trim().length > 0 &&
    organizationTaxCode.trim().length > 0 &&
    organizationDescription.trim().length > 0 &&
    organizationFiles.length > 0 &&
    organizationFiles.length <= maximumKycFileCount;

  const isAuditorBankNameValid = AUDITOR_PAYOUT_SUPPORTED_BANKS.some((bank) => bank.value === auditorBankName);
  const isAuditorBankAccountNumberValid = /^\d{8,20}$/.test(auditorBankAccountNumber);
  const isAuditorAccountHolderNameValid =
    auditorAccountHolderName.length >= 2
    && auditorAccountHolderName.length <= 200
    && /^[A-Z\s]+$/.test(auditorAccountHolderName);
  const isAuditorBranchNameValid = auditorBranchName.length <= 200;
  const isAuditorRegisterReady = isAuditorBankNameValid
    && isAuditorBankAccountNumberValid
    && isAuditorAccountHolderNameValid
    && isAuditorBranchNameValid
    && auditorGoogleCredential !== ""
    && isTermsAccepted
    && !isRegisterProcessing;

  const auditorTokenShortfall = useMemo((): bigint => {
    try {
      const minimumStakeThreshold = BigInt(auditorMinimumStakeThreshold || "0");
      const tokenBalance = BigInt(auditorTokenBalance || "0");
      return minimumStakeThreshold > tokenBalance ? minimumStakeThreshold - tokenBalance : 0n;
    } catch {
      return 0n;
    }
  }, [auditorMinimumStakeThreshold, auditorTokenBalance]);

  const auditorDepositAmount = useMemo((): number | null => {
    if (auditorTokenShortfall > MAX_SAFE_AUDITOR_DEPOSIT_AMOUNT) {
      return null;
    }

    return Number(auditorTokenShortfall < MINIMUM_AUDITOR_DEPOSIT_AMOUNT
      ? MINIMUM_AUDITOR_DEPOSIT_AMOUNT
      : auditorTokenShortfall);
  }, [auditorTokenShortfall]);

  const descriptionCount = organizationDescription.length;

  const isOrganizationNameValid = organizationName.trim().length > 0;
  const isOrganizationTaxValid = organizationTaxCode.trim().length > 0;
  const isOrganizationDescriptionValid = organizationDescription.trim().length > 0;

  // Ghi chú: Tạo class hợp lệ/không hợp lệ cho input KYC.
  const resolveValidationClass = (isValid: boolean, hasValue: boolean): string => {
    if (!hasValue) {
      return "";
    }

    return isValid ? "ok" : "err";
  };

  // Ghi chú: Ánh xạ trạng thái hợp lệ sang class Tailwind cho input KYC.
  const resolveInputValidationClass = (validationClass: string): string => {
    if (validationClass === "ok") {
      return "border-emerald-500";
    }

    if (validationClass === "err") {
      return "border-red-500 shadow-[0_0_0_3px_rgba(239,68,68,0.08)]";
    }

    return "";
  };

  const organizationNameClass = resolveValidationClass(isOrganizationNameValid, organizationName.trim().length > 0);
  const organizationTaxClass = resolveValidationClass(isOrganizationTaxValid, organizationTaxCode.trim().length > 0);
  const organizationDescriptionClass = resolveValidationClass(
    isOrganizationDescriptionValid,
    organizationDescription.trim().length > 0
  );

  const auditorBankNameClass = resolveValidationClass(isAuditorBankNameValid, auditorBankName.length > 0);
  const auditorBankAccountNumberClass = resolveValidationClass(isAuditorBankAccountNumberValid, auditorBankAccountNumber.length > 0);
  const auditorAccountHolderNameClass = resolveValidationClass(isAuditorAccountHolderNameValid, auditorAccountHolderName.length > 0);
  const auditorBranchNameClass = resolveValidationClass(isAuditorBranchNameValid, auditorBranchName.length > 0);

  /** Đặt lại toàn bộ state tạm của nhánh Kiểm toán viên trước khi người dùng chọn vai trò khác. */
  const resetAuditorBranchState = useCallback((): void => {
    setAuditorGoogleCredential("");
    setAuditorBankName("");
    setAuditorBankAccountNumber("");
    setAuditorAccountHolderName("");
    setAuditorBranchName("");
    setAuditorIntentId("");
    setAuditorMinimumStakeThreshold("");
    setAuditorTokenBalance("");
    setAuditorStakeStage("NEED_TOKEN");
    setAuditorStakeTxHash("");
    setAuditorStatusMessage("");
    setAuditorErrorMessage("");
    setIsAuditorSuccessVisible(false);
    setIsAuditorMintFailureVisible(false);
    setAuditorDepositOrderCode("");
    setAuditorDepositPaymentUrl("");
    setAuditorDepositExpiresAt("");
    setIsAuditorAutoCompletionPending(false);
    auditorAutoStakeAttemptRef.current = 0;
    hasAuditorAutoStakeSubmissionRef.current = false;
    window.localStorage.removeItem(AUDITOR_INTENT_STORAGE_KEY);
    window.localStorage.removeItem(AUDITOR_STAKE_THRESHOLD_STORAGE_KEY);
    window.localStorage.removeItem(AUDITOR_WALLET_ADDRESS_STORAGE_KEY);
  }, []);

  // Ghi chú: Chọn vai trò và giữ lại bước đầu tiên của luồng đăng ký.
  const handleRoleSelect = useCallback((role: RoleType): void => {
    resetAuditorBranchState();
    setSelectedRole(role);
    setAuthenticatedRole(null);
    setCurrentStep(1);
  }, [resetAuditorBranchState]);

  /** Khôi phục role từ URL nhưng không reset intent khi PayOS vừa trả về để đối soát giao dịch cọc. */
  useEffect(() => {
    const searchParams = new URLSearchParams(window.location.search);
    const roleFromUrl = searchParams.get("role");
    const payosReturnOrderCode = getSuccessfulAuditorPaymentReturnOrderCode(searchParams);
    const savedIntentId = window.localStorage.getItem(AUDITOR_INTENT_STORAGE_KEY);
    const savedMinimumStakeThreshold = normalizeAuditorTokenBalance(
      window.localStorage.getItem(AUDITOR_STAKE_THRESHOLD_STORAGE_KEY)
    );
    const savedWalletAddress = window.localStorage.getItem(AUDITOR_WALLET_ADDRESS_STORAGE_KEY);
    if (roleFromUrl === "donor" || roleFromUrl === "organization" || roleFromUrl === "auditor") {
      if (roleFromUrl === "auditor" && payosReturnOrderCode) {
        // Callback hợp lệ phải giữ session/intent để effect đối soát phía dưới có thể tiếp tục ngay tại bước 3.
        setSelectedRole("auditor");
        setAuthenticatedRole(null);
        setCurrentStep(3);
      } else {
        handleRoleSelect(roleFromUrl);
      }
      if (roleFromUrl === "auditor" && savedIntentId) {
        setAuditorIntentId(savedIntentId);
        window.localStorage.setItem(AUDITOR_INTENT_STORAGE_KEY, savedIntentId);
      }
      if (roleFromUrl === "auditor" && savedMinimumStakeThreshold) {
        setAuditorMinimumStakeThreshold(savedMinimumStakeThreshold);
        window.localStorage.setItem(AUDITOR_STAKE_THRESHOLD_STORAGE_KEY, savedMinimumStakeThreshold);
      }
      if (roleFromUrl === "auditor" && savedWalletAddress) {
        setCreatedWalletAddress(savedWalletAddress);
        window.localStorage.setItem(AUDITOR_WALLET_ADDRESS_STORAGE_KEY, savedWalletAddress);
      }
    }
  }, [handleRoleSelect]);

  // Ghi chú: Điều hướng đến bước mong muốn và reset checkbox khi quay lại.
  const handleGoToStep = (step: number) => {
    setCurrentStep(step);
    if (step === 1) {
      setIsTermsAccepted(false);
    }
  };

  // Ghi chú: Trở về bước chọn vai trò từ các vị trí hành động nhanh.
  const handleGoToRoleStep = () => {
    handleGoToStep(1);
  };

  // Ghi chú: Bật/tắt trạng thái đồng ý điều khoản.
  const handleToggleTerms = () => {
    setIsTermsAccepted((previousState) => !previousState);
    setTermsError('');
  };

  // Ghi chú: Thu gọn hoặc mở rộng hộp giải thích.
  const handleToggleInfoBox = () => {
    setIsInfoCollapsed((previousState) => !previousState);
  };

  // Ghi chú: Lưu thông tin phiên sau khi xác thực Google thành công.
  const handleRegisterSuccess = useCallback(
    (responseData: {
      accessToken?: string;
      refreshToken?: string;
      csrfToken?: string;
      refreshSessionId?: string;
      expiresAt?: string;
      user?: {
        fullName?: string;
        walletAddress?: string;
        email?: string;
        role?: "donor" | "organization" | "honor";
      };
    }) => {
      const userWalletAddress = responseData?.user?.walletAddress || "";
      const responseUserRole = (responseData?.user?.role || null) as AuthenticatedRoleType;
      setCreatedWalletAddress(userWalletAddress);
      setRegisteredUserEmail(responseData?.user?.email || "");
      setAuthenticatedRole(responseUserRole);
      persistAuthSession({
        accessToken: responseData?.accessToken,
        refreshToken: responseData?.refreshToken,
        csrfToken: responseData?.csrfToken,
        refreshSessionId: responseData?.refreshSessionId,
        refreshTokenExpiresAt: responseData?.expiresAt,
        userFullName: responseData?.user?.fullName || "Người dùng",
      });

      // Ghi chú logic phức tạp: trong luồng đăng ký tổ chức, luôn xét role từ response đăng nhập mới nhất.
      // - role organization: đã có tài khoản tổ chức => chặn tạo lại.
      // - role donor/honor/chưa có role rõ ràng (null): cho phép đi tiếp Step 3 để nộp KYC.
      const isOrganizationRegistrationFlow = selectedRole === "organization";
      if (isOrganizationRegistrationFlow) {
        if (responseUserRole === "organization") {
          setRegisterErrorMessage("Bạn đã có tài khoản tổ chức từ thiện rồi, không cần tạo lại. Hệ thống sẽ chuyển hướng về trang chủ.");
          setCurrentStep(2);
          window.setTimeout(() => {
            router.push("/");
          }, 1800);
          return;
        }

        setCurrentStep(3);
        return;
      }

      setIsGoogleSuccessVisible(true);
      router.push("/");
    },
    [router, selectedRole]
  );

  /**
   * Hàm bật trạng thái loading của thanh tiến trình.
   * Mục đích: đồng bộ hiệu ứng loading Google với trang đăng nhập.
   */
  const triggerProgressBar = () => {
    setIsProgressLoading(true);
    window.setTimeout(() => setIsProgressLoading(false), 1800);
  };

  // Ghi chú: Gửi Google ID token về backend để tạo Smart Account và phiên đăng nhập.
  const requestGoogleRegister = useCallback(
    async (idToken: string) => {
      setIsRegisterProcessing(true);
      setRegisterErrorMessage("");

      // Ghi chú logic phức tạp: luôn reset role đã xác thực trước khi login mới,
      // để quyền nộp KYC chỉ dựa trên kết quả đăng nhập hiện tại từ backend.
      setAuthenticatedRole(null);
      triggerProgressBar();

      try {
        const response = await fetch(`${backendBaseUrl}/auth/google-login`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ idToken, role: selectedRole }),
        });
        const responseData = await response.json();

        // Ghi chú logic phức tạp: luôn kiểm tra trạng thái HTTP trước khi dùng dữ liệu trả về
        if (!response.ok) {
          throw new Error(responseData?.message || "Đăng nhập thất bại, vui lòng thử lại.");
        }

        handleRegisterSuccess(responseData);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Không thể đăng nhập, vui lòng thử lại.";
        setRegisterErrorMessage(errorMessage);
      } finally {
        setIsRegisterProcessing(false);
      }
    },
    [backendBaseUrl, handleRegisterSuccess, selectedRole]
  );

  /** Lưu session và snapshot cọc từ backend cho cả hồ sơ mới lẫn hồ sơ Auditor được khôi phục. */
  const applyAuditorIntentResult = useCallback((result: RegisterAuditorIntentResult): void => {
    const hasEnoughTokenForStake = BigInt(result.currentTokenBalance) >= BigInt(result.minimumStakeThreshold);
    persistAuthSession({
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      csrfToken: result.csrfToken,
      refreshSessionId: result.refreshSessionId,
      refreshTokenExpiresAt: result.expiresAt,
    });
    setCreatedWalletAddress(result.walletAddress);
    setRegisteredUserEmail("");
    window.localStorage.setItem(AUDITOR_INTENT_STORAGE_KEY, result.intentId);
    window.localStorage.setItem(AUDITOR_STAKE_THRESHOLD_STORAGE_KEY, result.minimumStakeThreshold);
    window.localStorage.setItem(AUDITOR_WALLET_ADDRESS_STORAGE_KEY, result.walletAddress);
    setAuditorIntentId(result.intentId);
    setAuditorMinimumStakeThreshold(result.minimumStakeThreshold);
    setAuditorTokenBalance(result.currentTokenBalance);
    auditorAutoStakeAttemptRef.current = 0;
    hasAuditorAutoStakeSubmissionRef.current = false;
    setIsAuditorAutoCompletionPending(hasEnoughTokenForStake);
    setAuditorStakeStage(hasEnoughTokenForStake ? "READY_TO_STAKE" : "NEED_TOKEN");
    setAuditorGoogleCredential("");
    setAuditorDepositOrderCode("");
    setAuditorDepositPaymentUrl("");
    setAuditorDepositExpiresAt("");
    setAuditorStakeTxHash("");
    setAuditorErrorMessage("");
    setAuditorStatusMessage("");
    setCurrentStep(3);
  }, []);

  /** Chỉ bỏ qua form tài khoản nhận tiền khi backend xác nhận đúng hồ sơ Auditor đang chờ đặt cọc. */
  const resumeExistingAuditor = useCallback(async (identityToken: string): Promise<void> => {
    setIsRegisterProcessing(true);
    setRegisterErrorMessage("");
    try {
      const result = await resumeAuditorIntent({ identityToken });
      applyAuditorIntentResult(result);
    } catch (error) {
      if (getApiErrorCode(error) === "AUDITOR_ONBOARDING_NOT_FOUND") {
        setAuditorGoogleCredential(identityToken);
        setAuditorStatusMessage("Đã xác thực Google. Hoàn tất thông tin tài khoản nhận tiền để tạo hồ sơ.");
        return;
      }
      setAuditorGoogleCredential("");
      setAuditorStatusMessage("");
      setRegisterErrorMessage(getAuditorApiErrorMessage(error, "Không thể khôi phục hồ sơ Kiểm toán viên."));
    } finally {
      setIsRegisterProcessing(false);
    }
  }, [applyAuditorIntentResult]);

  // Ghi chú: Nhận credential từ Google Identity Services để bắt đầu đăng ký hoặc khôi phục onboarding.
  const handleGoogleCredential = useCallback(
    (response: { credential?: string }) => {
      if (!response.credential) {
        setRegisterErrorMessage("Không nhận được thông tin đăng ký từ Google.");
        return;
      }

      if (selectedRole === "auditor") {
        void resumeExistingAuditor(response.credential);
        return;
      }

      requestGoogleRegister(response.credential);
    },
    [requestGoogleRegister, resumeExistingAuditor, selectedRole]
  );

  /** Tạo header xác thực cho các endpoint nạp DCT dùng JSON trần. */
  const buildAuditorAuthHeaders = useCallback((): HeadersInit => ({
    Authorization: `Bearer ${readAuthSession().accessToken || ""}`,
  }), []);

  /** Đọc lại số dư VND on-chain và tự tiếp tục cọc khi số dư đã đạt ngưỡng. */
  const handleRefreshAuditorTokenBalance = useCallback(async ({
    minimumStakeThresholdToCompare = auditorMinimumStakeThreshold,
    shouldAutoComplete = true,
  }: {
    minimumStakeThresholdToCompare?: string;
    shouldAutoComplete?: boolean;
  } = {}): Promise<void> => {
    setIsRegisterProcessing(true);
    setAuditorErrorMessage("");

    const normalizedMinimumStakeThreshold = normalizeAuditorTokenBalance(minimumStakeThresholdToCompare);
    if (!normalizedMinimumStakeThreshold) {
      setAuditorErrorMessage("Không thể khôi phục mức cọc Auditor. Vui lòng quay lại trang đăng ký ban đầu.");
      setIsRegisterProcessing(false);
      return;
    }

    try {
      const response = await fetch(`${backendBaseUrl}/api/deposit/balance`, {
        method: "GET",
        headers: buildAuditorAuthHeaders(),
      });
      const responseData = await response.json().catch(() => null);
      const nextTokenBalance = isRecord(responseData)
        ? normalizeAuditorTokenBalance(responseData.tokenBalance)
        : null;
      if (!response.ok || !nextTokenBalance) {
        setAuditorErrorMessage("Không thể đọc số dư VND. Vui lòng thử lại.");
        return;
      }

      // Chỉ cập nhật state sau khi cả số dư và ngưỡng có thể so sánh bằng BigInt để dữ liệu lỗi không làm sai số tiền cần nạp.
      const isStakeThresholdMet = BigInt(nextTokenBalance) >= BigInt(normalizedMinimumStakeThreshold);
      setAuditorTokenBalance(nextTokenBalance);
      if (isStakeThresholdMet) {
        if (shouldAutoComplete) {
          auditorAutoStakeAttemptRef.current = 0;
          hasAuditorAutoStakeSubmissionRef.current = false;
          setIsAuditorAutoCompletionPending(true);
        }
        setAuditorStakeStage("READY_TO_STAKE");
        setAuditorDepositOrderCode("");
        setAuditorDepositPaymentUrl("");
        setAuditorDepositExpiresAt("");
      } else {
        setAuditorStakeStage("NEED_TOKEN");
      }
    } catch {
      setAuditorErrorMessage("Không thể đọc số dư VND. Vui lòng thử lại.");
    } finally {
      setIsRegisterProcessing(false);
    }
  }, [auditorMinimumStakeThreshold, backendBaseUrl, buildAuditorAuthHeaders]);

  /** Tạo phiếu nạp DCT với số tiền thiếu đã được điền sẵn cho ngưỡng đặt cọc. */
  const handleCreateAuditorDeposit = async (): Promise<void> => {
    if (auditorDepositAmount === null) {
      setAuditorErrorMessage("Số VND cần nạp vượt giới hạn thanh toán. Vui lòng liên hệ hỗ trợ.");
      return;
    }

    setIsRegisterProcessing(true);
    setAuditorErrorMessage("");
    setAuditorStatusMessage("");

    try {
      const response = await fetch(`${backendBaseUrl}/api/deposit/create`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...buildAuditorAuthHeaders(),
        },
        body: JSON.stringify({ amountVnd: auditorDepositAmount, paymentFlow: "AUDITOR_ONBOARDING" }),
      });
      const responseData = await response.json().catch(() => null);
      if (!response.ok || !isAuditorDepositCreateResult(responseData)) {
        const message = isRecord(responseData) && typeof responseData.message === "string"
          ? responseData.message
          : "Không thể tạo phiếu nạp VND. Vui lòng thử lại.";
        setAuditorErrorMessage(message);
        return;
      }

      const safePaymentUrl = getSafeAuditorPaymentUrl(responseData.paymentUrl);
      if (!safePaymentUrl) {
        setAuditorErrorMessage("Đường dẫn thanh toán không hợp lệ. Vui lòng tạo phiếu nạp mới.");
        return;
      }

      setAuditorDepositOrderCode(responseData.orderCode);
      setAuditorDepositPaymentUrl(safePaymentUrl);
      setAuditorStakeStage("AWAITING_PAYMENT");
      window.open(safePaymentUrl, "_blank", "noopener,noreferrer");
    } catch {
      setAuditorErrorMessage("Không thể tạo phiếu nạp VND. Vui lòng thử lại.");
    } finally {
      setIsRegisterProcessing(false);
    }
  };

  /** Kiểm tra phiếu nạp PayOS theo thao tác chủ động và phản ánh trạng thái phát DCT. */
  const handleCheckAuditorDeposit = useCallback(async (
    orderCodeToCheck = auditorDepositOrderCode,
    minimumStakeThresholdToCompare = auditorMinimumStakeThreshold
  ): Promise<void> => {
    if (!orderCodeToCheck) {
      return;
    }

    setIsRegisterProcessing(true);
    setAuditorErrorMessage("");

    try {
      const response = await fetch(`${backendBaseUrl}/api/deposit/${encodeURIComponent(orderCodeToCheck)}?reconcile=true`, {
        method: "GET",
        headers: buildAuditorAuthHeaders(),
      });
      const responseData = await response.json().catch(() => null);
      if (!response.ok || !isAuditorDepositStatusResult(responseData)) {
        const message = isRecord(responseData) && typeof responseData.message === "string"
          ? responseData.message
          : "Không thể kiểm tra phiếu nạp VND. Vui lòng thử lại.";
        setAuditorErrorMessage(message);
        return;
      }

      if (typeof responseData.paymentUrl === "string") {
        const safePaymentUrl = getSafeAuditorPaymentUrl(responseData.paymentUrl);
        if (!safePaymentUrl) {
          setAuditorErrorMessage("Đường dẫn thanh toán không hợp lệ. Vui lòng tạo phiếu nạp mới.");
          return;
        }

        setAuditorDepositPaymentUrl(safePaymentUrl);
      }
      if (typeof responseData.paymentExpiredAt === "string") {
        setAuditorDepositExpiresAt(responseData.paymentExpiredAt);
      }

      const paymentExpiredAt = responseData.paymentExpiredAt || auditorDepositExpiresAt;
      if (responseData.status === "PENDING_PAYMENT" && paymentExpiredAt && Date.now() > new Date(paymentExpiredAt).getTime()) {
        setAuditorStakeStage("NEED_TOKEN");
        setAuditorDepositOrderCode("");
        setAuditorDepositPaymentUrl("");
        setAuditorDepositExpiresAt("");
        setAuditorStatusMessage("");
        setAuditorErrorMessage("Phiếu nạp đã hết hạn. Vui lòng tạo phiếu mới.");
        return;
      }

      if (responseData.status === "PENDING_PAYMENT") {
        setAuditorStatusMessage("Chưa nhận được thanh toán. Nếu bạn vừa chuyển khoản, đợi khoảng 1 phút rồi bấm lại.");
        return;
      }

      if (responseData.status === "PAYMENT_CONFIRMED") {
        setAuditorStatusMessage("Đã nhận thanh toán, đang cập nhật số dư VND tương ứng trong ví của bạn. Vui lòng bấm lại sau khoảng 1 phút.");
        return;
      }

      if (responseData.status === "MINT_COMPLETED") {
        if (!normalizeAuditorTokenBalance(minimumStakeThresholdToCompare)) {
          setAuditorStakeStage("RECOVERY_REQUIRED");
          setAuditorErrorMessage("Đã xác nhận thanh toán và phát VND vào ví, nhưng không thể khôi phục mức cọc Auditor. Vui lòng quay lại trang đăng ký ban đầu.");
          return;
        }
        await handleRefreshAuditorTokenBalance({ minimumStakeThresholdToCompare });
        return;
      }

      if (responseData.status === "FAILED") {
        if (responseData.isPaymentConfirmedButMintFailed) {
          // PayOS đã thu tiền nhưng token chưa thể mint; không tạo phiếu mới để tránh thu tiền lần hai.
          setIsAuditorAutoCompletionPending(false);
          setAuditorStakeStage("RECOVERY_REQUIRED");
          setAuditorDepositOrderCode("");
          setAuditorDepositPaymentUrl("");
          setAuditorDepositExpiresAt("");
          setAuditorStatusMessage("");
          setAuditorErrorMessage("");
          setIsAuditorMintFailureVisible(true);
          return;
        }
        setAuditorStakeStage("NEED_TOKEN");
        setAuditorDepositOrderCode("");
        setAuditorDepositPaymentUrl("");
        setAuditorDepositExpiresAt("");
        setAuditorStatusMessage("");
        setAuditorErrorMessage(`${responseData.failureReason || "Phiếu nạp VND không thành công."} Vui lòng tạo phiếu nạp mới.`);
      }
    } catch {
      setAuditorErrorMessage("Không thể kiểm tra phiếu nạp VND. Vui lòng thử lại.");
    } finally {
      setIsRegisterProcessing(false);
    }
  }, [
    auditorDepositExpiresAt,
    auditorDepositOrderCode,
    auditorMinimumStakeThreshold,
    backendBaseUrl,
    buildAuditorAuthHeaders,
    handleRefreshAuditorTokenBalance,
  ]);

  /** Tự đối soát và phát VND khi PayOS trả người dùng về từ luồng kích hoạt Auditor. */
  useEffect(() => {
    const searchParams = new URLSearchParams(window.location.search);
    const orderCode = getSuccessfulAuditorPaymentReturnOrderCode(searchParams);

    if (!orderCode || reconciledAuditorPaymentOrderCodeRef.current === orderCode) {
      return;
    }

    const savedMinimumStakeThreshold = normalizeAuditorTokenBalance(
      window.localStorage.getItem(AUDITOR_STAKE_THRESHOLD_STORAGE_KEY)
    );
    reconciledAuditorPaymentOrderCodeRef.current = orderCode;
    auditorAutoStakeAttemptRef.current = 0;
    hasAuditorAutoStakeSubmissionRef.current = false;
    setIsAuditorAutoCompletionPending(true);
    setCurrentStep(3);
    if (savedMinimumStakeThreshold) {
      setAuditorMinimumStakeThreshold(savedMinimumStakeThreshold);
    }
    setAuditorDepositOrderCode(orderCode);
    setAuditorStakeStage("AWAITING_PAYMENT");
    setAuditorStatusMessage("Đang xác nhận thanh toán và cập nhật số dư VND vào ví Smart Account.");
    void handleCheckAuditorDeposit(orderCode, savedMinimumStakeThreshold || "");
  }, [handleCheckAuditorDeposit]);

  /** Gửi giao dịch đặt cọc DCT sau khi số dư ví Smart Account đã đủ ngưỡng. */
  const handleExecuteAuditorStake = async (): Promise<void> => {
    setIsRegisterProcessing(true);
    setAuditorErrorMessage("");
    setAuditorStatusMessage("");
    setLoadingTexts({
      title: "Đang gửi giao dịch đặt cọc...",
      subtitle: "Ký UserOperation bằng Smart Account",
    });
    setIsLoadingVisible(true);
    setIsProgressLoading(true);

    try {
      const result = await executeAuditorStake(readAuthSession().accessToken || "");
      hasAuditorAutoStakeSubmissionRef.current = true;
      setAuditorStakeTxHash(result.txHash);
      setAuditorStakeStage("VERIFYING");
      setAuditorStatusMessage("Đã gửi giao dịch đặt cọc. Xác minh on-chain thường mất 30–60 giây.");
      if (isAuditorAutoCompletionPending) {
        void handleCheckAuditorStatus();
      }
    } catch (error) {
      const errorCode = getApiErrorCode(error);
      if (errorCode === "INSUFFICIENT_TOKEN_BALANCE") {
        // Backend vừa xác nhận số dư Smart Account không đủ; bỏ số dư cache cũ để số tiền nạp lại không bị tính thiếu.
        setIsAuditorAutoCompletionPending(false);
        setAuditorTokenBalance("0");
        setAuditorStakeStage("NEED_TOKEN");
        setAuditorErrorMessage(getAuditorApiErrorMessage(error, "Không thể gửi giao dịch đặt cọc."));
      } else if (isAuditorAutoCompletionPending && auditorAutoStakeAttemptRef.current < AUDITOR_AUTO_STAKE_MAX_ATTEMPTS) {
        setAuditorStakeStage("FAILED");
        setAuditorStatusMessage("Giao dịch đặt cọc tạm thời chưa gửi được. Hệ thống sẽ tự thử lại một lần.");
      } else {
        setIsAuditorAutoCompletionPending(false);
        setAuditorStakeStage("FAILED");
        setAuditorErrorMessage(getAuditorApiErrorMessage(error, "Không thể gửi giao dịch đặt cọc."));
      }
    } finally {
      setIsRegisterProcessing(false);
      setIsLoadingVisible(false);
      setIsProgressLoading(false);
    }
  };

  /** Hoàn tất kích hoạt Auditor, hủy phiên cũ và yêu cầu đăng nhập lại bằng role vừa được cấp. */
  const finalizeAuditorActivation = (): void => {
    setIsAuditorAutoCompletionPending(false);
    setAuditorStakeStage("ACTIVATED");
    setAuthenticatedRole(null);
    clearAuthSession();
    window.localStorage.removeItem(AUDITOR_INTENT_STORAGE_KEY);
    window.localStorage.removeItem(AUDITOR_STAKE_THRESHOLD_STORAGE_KEY);
    window.localStorage.removeItem(AUDITOR_WALLET_ADDRESS_STORAGE_KEY);
    setAuditorStatusMessage("Đăng ký thành công. Bạn sẽ được chuyển sang trang đăng nhập để nhận quyền Kiểm toán viên.");
    setIsAuditorSuccessVisible(true);
  };

  /** Đọc trạng thái xác minh đặt cọc để hoàn tất cấp quyền sau UserOperation hoặc khi người dùng kiểm tra thủ công. */
  const handleCheckAuditorStatus = async (shouldRetryPendingStake = false): Promise<void> => {
    if (!auditorIntentId) {
      return;
    }

    setIsRegisterProcessing(true);
    setAuditorErrorMessage("");

    try {
      const result = await getAuditorOnboardingStatus(readAuthSession().accessToken || "", auditorIntentId);
      if (result.status === "PENDING_TX") {
        // Chỉ retry khi người dùng chủ động kiểm tra lại sau lỗi gửi UserOperation.
        // Với poll tự động, PENDING_TX có thể là độ trễ indexer nên không được gửi trùng giao dịch cọc.
        await handleRefreshAuditorTokenBalance({ shouldAutoComplete: shouldRetryPendingStake });
        return;
      }

      if (result.status === "VERIFYING") {
        setAuditorStakeStage("VERIFYING");
        setAuditorStatusMessage("Đang xác minh cọc on-chain. Vui lòng kiểm tra lại sau khoảng 1 phút.");
        return;
      }

      if (result.status === "ACTIVATED") {
        finalizeAuditorActivation();
        return;
      }

      setAuditorStakeStage("FAILED");
      if (isAuditorAutoCompletionPending && auditorAutoStakeAttemptRef.current < AUDITOR_AUTO_STAKE_MAX_ATTEMPTS) {
        setAuditorStatusMessage("Xác minh giao dịch chưa hoàn tất. Hệ thống sẽ tự thử lại một lần.");
      } else if (result.failureReason === "TX_REVERTED_OR_TIMEOUT") {
        setIsAuditorAutoCompletionPending(false);
        setAuditorErrorMessage("Giao dịch đặt cọc không thành công trên blockchain. Hệ thống đã thử lại tự động nhưng chưa thành công.");
      } else if (result.failureReason === "VERIFICATION_TIMEOUT_24H") {
        setIsAuditorAutoCompletionPending(false);
        setAuditorErrorMessage("Yêu cầu đặt cọc đã quá hạn 24 giờ. Vui lòng tạo lại yêu cầu hỗ trợ.");
      } else {
        setIsAuditorAutoCompletionPending(false);
        setAuditorErrorMessage("Xác minh cọc chưa thành công sau các lần thử tự động. Vui lòng liên hệ hỗ trợ.");
      }
    } catch (error) {
      setAuditorErrorMessage(getAuditorApiErrorMessage(error, "Không thể kiểm tra trạng thái đặt cọc."));
    } finally {
      setIsRegisterProcessing(false);
    }
  };

  /** Tự gửi cọc sau khi số dư VND on-chain đủ ngưỡng; giới hạn hai lần để không phát sinh UserOperation lặp vô hạn. */
  useEffect(() => {
    if (
      !isAuditorAutoCompletionPending
      || hasAuditorAutoStakeSubmissionRef.current
      || auditorAutoStakeAttemptRef.current >= AUDITOR_AUTO_STAKE_MAX_ATTEMPTS
      || auditorStakeStage !== "READY_TO_STAKE"
      || isRegisterProcessing
    ) {
      return;
    }

    auditorAutoStakeAttemptRef.current += 1;
    void handleExecuteAuditorStake();
  }, [auditorStakeStage, handleExecuteAuditorStake, isAuditorAutoCompletionPending, isRegisterProcessing]);

  /** Thử lại một lần khi bundler hoặc RPC từ chối trước khi UserOperation được chấp nhận. */
  useEffect(() => {
    if (
      !isAuditorAutoCompletionPending
      || auditorStakeStage !== "FAILED"
      || auditorAutoStakeAttemptRef.current >= AUDITOR_AUTO_STAKE_MAX_ATTEMPTS
    ) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setAuditorStakeStage("READY_TO_STAKE");
    }, AUDITOR_AUTO_STAKE_RETRY_INTERVAL_MS);
    return () => window.clearTimeout(timeoutId);
  }, [auditorStakeStage, isAuditorAutoCompletionPending]);

  /** Poll có kiểm soát trạng thái on-chain cho riêng luồng callback PayOS để chỉ cấp role sau khi backend xác minh. */
  useEffect(() => {
    if (!isAuditorAutoCompletionPending || auditorStakeStage !== "VERIFYING" || isRegisterProcessing || !auditorIntentId) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      void handleCheckAuditorStatus();
    }, AUDITOR_ONCHAIN_STATUS_POLL_INTERVAL_MS);
    return () => window.clearTimeout(timeoutId);
  }, [auditorIntentId, auditorStakeStage, handleCheckAuditorStatus, isAuditorAutoCompletionPending, isRegisterProcessing]);

  /** Tự chuyển sang đăng nhập sau khi người dùng đã thấy thông báo kích hoạt quyền Auditor thành công. */
  useEffect(() => {
    if (!isAuditorSuccessVisible) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      router.push("/login");
    }, AUDITOR_LOGIN_REDIRECT_DELAY_MS);
    return () => window.clearTimeout(timeoutId);
  }, [isAuditorSuccessVisible, router]);

  /** Tạo hồ sơ Kiểm toán viên sau khi Google và tài khoản nhận tiền đều đã hợp lệ. */
  const handleSubmitAuditorRegister = async (): Promise<void> => {
    if (!isAuditorRegisterReady) {
      if (!isTermsAccepted) {
        setTermsError("Vui lòng tích vào ô để tiếp tục.");
      }
      return;
    }

    setIsRegisterProcessing(true);
    setRegisterErrorMessage("");
    setAuditorErrorMessage("");
    setLoadingTexts({
      title: "Đang tạo hồ sơ Kiểm toán viên...",
      subtitle: "Tạo ví Smart Account và lưu tài khoản nhận tiền",
    });
    setIsLoadingVisible(true);
    setIsProgressLoading(true);

    try {
      const result = await registerAuditorIntent({
        identityToken: auditorGoogleCredential,
        payoutAccount: {
          bankName: auditorBankName,
          bankAccountNumber: auditorBankAccountNumber,
          accountHolderName: auditorAccountHolderName,
          branchName: auditorBranchName.trim() || undefined,
        },
      });
      applyAuditorIntentResult(result);
    } catch (error) {
      setRegisterErrorMessage(getAuditorApiErrorMessage(error, "Không thể tạo hồ sơ Kiểm toán viên."));
      if (getApiErrorCode(error) === "UNAUTHENTICATED") {
        setAuditorGoogleCredential("");
      }
    } finally {
      setIsRegisterProcessing(false);
      setIsLoadingVisible(false);
      setIsProgressLoading(false);
    }
  };

  /**
   * Hàm lấy đối tượng Google Accounts ID từ GSI script.
   * Mục đích: gom logic truy cập window.google để tái sử dụng và dễ debug.
   */
  const getGoogleAccountsId = useCallback(() => window.google?.accounts?.id, []);

  /**
   * Hàm hiển thị nút Google do GSI cung cấp trên trang đăng ký.
   * Mục đích: đồng bộ luồng nhấn nút Google với trang đăng nhập.
   */
  const renderGoogleRedirectButton = useCallback(() => {
    const googleAccounts = getGoogleAccountsId();
    if (!googleAccounts) {
      return;
    }

    const containerElement = document.getElementById(googleRedirectButtonContainerId);
    if (!containerElement) {
      return;
    }

    // Ghi chú logic phức tạp: luôn xóa nội dung cũ trước khi render lại để tránh nhân bản nút Google.
    containerElement.innerHTML = "";
    googleAccounts.renderButton(containerElement, {
      type: "standard",
      theme: "outline",
      size: "large",
      text: "continue_with",
      shape: "rectangular",
      width: "320",
    });
  }, [getGoogleAccountsId, googleRedirectButtonContainerId]);

  // Ghi chú: Khởi tạo Google Identity Services và render nút Google.
  const initializeGoogleRegister = useCallback(() => {
    if (!isGoogleClientIdValid(googleClientId)) {
      setRegisterErrorMessage("Thiếu hoặc sai cấu hình Google Client ID.");
      return false;
    }

    const googleAccounts = getGoogleAccountsId();
    if (!googleAccounts) {
      return false;
    }

    googleAccounts.initialize({
      client_id: googleClientId,
      callback: handleGoogleCredential,
      use_fedcm_for_prompt: true,
    });

    renderGoogleRedirectButton();
    return true;
  }, [getGoogleAccountsId, googleClientId, handleGoogleCredential, renderGoogleRedirectButton]);

  // Ghi chú: Đảm bảo Google Identity Services sẵn sàng trước khi người dùng thao tác.
  useEffect(() => {
    // Ghi chú logic phức tạp: script GSI có thể tải sau khi component mount,
    // nên cần polling ngắn hạn để tránh bỏ lỡ bước initialize.
    const initializeWhenScriptReady = () => initializeGoogleRegister();

    if (initializeWhenScriptReady()) {
      return;
    }

    const initializationTimer = window.setInterval(() => {
      const isInitialized = initializeWhenScriptReady();
      if (isInitialized) {
        window.clearInterval(initializationTimer);
      }
    }, 300);

    return () => {
      window.clearInterval(initializationTimer);
    };
  }, [initializeGoogleRegister]);

  /**
   * Hàm đồng bộ render nút Google khi bước đăng ký được hiển thị.
   * Mục đích: đảm bảo container xuất hiện sau khi người dùng chuyển sang bước 2 vẫn có nút Google.
   */
  useEffect(() => {
    if (currentStep !== 2) {
      return;
    }

    renderGoogleRedirectButton();
  }, [currentStep, renderGoogleRedirectButton]);

  // Ghi chú: Chuyển từ bước chọn vai trò sang bước đăng ký Google.
  const handleContinueFromRole = () => {
    if (!selectedRole) {
      return;
    }

    setCurrentStep(2);
  };

  // Ghi chú: Kiểm tra điều khoản trước khi cho phép thao tác với nút Google.
  const handleGoogleRegister = () => {
    if (!isTermsAccepted) {
      setTermsError('Vui lòng tích vào ô để tiếp tục.');
      return;
    }
    setTermsError('');
  };

  // Ghi chú: Đóng màn hình chúc mừng cho Donor.
  const handleCloseDonorSuccess = () => {
    setIsDonorSuccessVisible(false);
  };

  // Ghi chú: Đóng màn hình thông báo gửi hồ sơ KYC.
  const handleCloseOrganizationSuccess = () => {
    setIsOrganizationSuccessVisible(false);
  };

  // Ghi chú: Đóng màn hình chúc mừng sau khi quyền Kiểm toán viên đã được kích hoạt.
  const handleCloseAuditorSuccess = () => {
    setIsAuditorSuccessVisible(false);
  };

  // Ghi chú: Cập nhật giá trị tên tổ chức.
  const handleOrganizationNameChange = (value: string) => {
    setOrganizationName(value);
  };

  // Ghi chú: Cập nhật mã số thuế của tổ chức.
  const handleOrganizationTaxCodeChange = (value: string) => {
    setOrganizationTaxCode(value);
  };

  // Ghi chú: Cập nhật website của tổ chức.
  const handleOrganizationWebsiteChange = (value: string) => {
    setOrganizationWebsite(value);
  };

  // Ghi chú: Cập nhật mô tả tổ chức.
  const handleOrganizationDescriptionChange = (value: string) => {
    setOrganizationDescription(value);
  };

  // Ghi chú: Xóa toàn bộ thông tin file upload để người dùng chọn lại từ đầu.
  const resetUploadState = () => {
    setOrganizationFiles([]);
    setUploadInfoList([]);
  };

  /**
   * Hàm kiểm tra file hồ sơ KYC theo đúng rule nghiệp vụ.
   * Mục đích: chặn sớm file sai định dạng hoặc vượt giới hạn dung lượng ngay ở client.
   */
  const validateKycFile = (file: File): string | null => {
    if (!acceptedKycMimeTypes.includes(file.type)) {
      return `File ${file.name} không đúng định dạng cho phép.`;
    }

    if (file.size > maxUploadBytes) {
      return `File ${file.name} vượt quá 10MB.`;
    }

    return null;
  };

  // Ghi chú: Kiểm tra danh sách file và cập nhật trạng thái upload cho KYC.
  const handleFileSelection = (fileList: FileList | File[] | null) => {
    if (!fileList) {
      return;
    }

    const incomingFiles = Array.from(fileList);
    if (incomingFiles.length === 0) {
      return;
    }

    // Ghi chú logic phức tạp: gộp file hiện có + file mới, bỏ trùng theo tên và thời gian sửa đổi,
    // sau đó giới hạn tối đa 3 file để bám sát UC1.3.
    const mergedFileMap = new Map<string, File>();
    [...organizationFiles, ...incomingFiles].forEach((file) => {
      const uniqueFileKey = `${file.name}-${file.lastModified}`;
      mergedFileMap.set(uniqueFileKey, file);
    });

    const mergedFiles = Array.from(mergedFileMap.values()).slice(0, maximumKycFileCount);
    const invalidMessage = mergedFiles.map(validateKycFile).find((message) => Boolean(message));

    if (invalidMessage) {
      setKycSubmitErrorMessage(invalidMessage || "File KYC không hợp lệ.");
      return;
    }

    setKycSubmitErrorMessage("");
    setOrganizationFiles(mergedFiles);
    setUploadInfoList(mergedFiles.map(createUploadInfo));
  };

  // Ghi chú: Gỡ 1 file đã chọn theo id mà không kích hoạt click vùng upload.
  const handleRemoveFile = (event: React.MouseEvent<HTMLButtonElement>, uploadInfoId: string) => {
    event.stopPropagation();
    const filteredFiles = organizationFiles.filter((file) => `${file.name}-${file.lastModified}` !== uploadInfoId);
    setOrganizationFiles(filteredFiles);
    setUploadInfoList(filteredFiles.map(createUploadInfo));
  };

  // Ghi chú: Mở dialog chọn nhiều file upload.
  const handleUploadClick = () => {
    const uploadInput = document.getElementById("organizationFileInput") as HTMLInputElement | null;
    uploadInput?.click();
  };

  // Ghi chú: Nhận danh sách file từ input file.
  const handleUploadChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    handleFileSelection(event.target.files);
  };

  // Ghi chú: Bật hiệu ứng hover khi kéo file vào vùng upload.
  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsUploadHover(true);
  };

  // Ghi chú: Tắt hiệu ứng hover khi rời vùng upload.
  const handleDragLeave = () => {
    setIsUploadHover(false);
  };

  // Ghi chú: Nhận danh sách file được thả vào vùng upload.
  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsUploadHover(false);
    handleFileSelection(event.dataTransfer.files);
  };

  /**
   * Hàm gửi hồ sơ KYC của tổ chức lên backend.
   * Mục đích: nộp metadata KYC và file base64 tới API xác minh tổ chức.
   */
  const handleSubmitKyc = async () => {
    const isAllowedRoleForOrganizationKyc =
      authenticatedRole === "honor" || authenticatedRole === "donor" || authenticatedRole === null;
    if (selectedRole !== "organization" || !isAllowedRoleForOrganizationKyc) {
      setKycSubmitErrorMessage("Bạn không có quyền nộp hồ sơ KYC ở luồng này.");
      return;
    }

    if (organizationFiles.length === 0) {
      setKycSubmitErrorMessage("Vui lòng chọn ít nhất 1 file hồ sơ.");
      return;
    }

    if (organizationFiles.length > maximumKycFileCount) {
      setKycSubmitErrorMessage("Bạn chỉ được upload tối đa 3 file hồ sơ.");
      return;
    }

    const persistedSession = readAuthSession();
    if (!persistedSession.accessToken) {
      setKycSubmitErrorMessage("Phiên đăng nhập không hợp lệ. Vui lòng đăng nhập lại.");
      return;
    }

    try {
      setKycSubmitErrorMessage("");
      setLoadingTexts({
        title: "Đang nộp hồ sơ KYC...",
        subtitle: "Đang tải giấy tờ lên IPFS",
      });
      setIsProgressLoading(true);
      setIsLoadingVisible(true);

      const kycFilesPayload = await Promise.all(
        organizationFiles.map(async (file) => ({
          fileName: file.name,
          mimeType: file.type,
          fileSize: file.size,
          base64Content: await convertFileToBase64(file),
          documentType: "LEGAL_DOCUMENT",
        }))
      );

      const response = await fetch(`${backendBaseUrl}/auth/organization/kyc-submissions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${persistedSession.accessToken}`,
        },
        body: JSON.stringify({
          organizationName: organizationName.trim(),
          legalRegistrationNumber: organizationTaxCode.trim(),
          officialWebsite: organizationWebsite.trim(),
          organizationDescription: organizationDescription.trim(),
          files: kycFilesPayload,
        }),
      });
      const responseData = await response.json();

      if (!response.ok) {
        throw new Error(responseData?.message || "Nộp hồ sơ KYC thất bại.");
      }

      setIsOrganizationSuccessVisible(true);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Nộp hồ sơ KYC thất bại.";
      setKycSubmitErrorMessage(errorMessage);
    } finally {
      setIsProgressLoading(false);
      setIsLoadingVisible(false);
    }
  };

  const resolvedWalletAddress = createdWalletAddress || fallbackSmartAccountAddress;
  const compactAuditorWalletAddress = formatAuditorWalletAddress(resolvedWalletAddress);

  // Ghi chú: Sao chép địa chỉ smart account vào clipboard.
  const handleCopyAddress = async () => {
    try {
      await navigator.clipboard.writeText(resolvedWalletAddress);
      setIsCopySuccess(true);
      window.setTimeout(() => {
        setIsCopySuccess(false);
      }, 1400);
    } catch (error) {
      setIsCopySuccess(false);
    }
  };

  // Ghi chú: Hỗ trợ submit nhanh bằng phím Enter theo từng bước.
  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter") {
      return;
    }

    if (currentStep === 1) {
      handleContinueFromRole();
      return;
    }

    if (currentStep === 2 && selectedRole === "auditor" && isAuditorRegisterReady) {
      void handleSubmitAuditorRegister();
      return;
    }

    if (currentStep === 2) {
      handleGoogleRegister();
      return;
    }

    if (currentStep === 3 && selectedRole === "organization" && isKycReady) {
      void handleSubmitKyc();
    }
  };

  const uploadZoneClassName = isUploadHover
    ? "rounded-xl border-2 border-dashed border-teal-600 bg-teal-50 px-6 py-6 text-center transition-all"
    : "rounded-xl border-2 border-dashed border-gray-200 bg-gray-50 px-6 py-6 text-center transition-all hover:border-teal-600 hover:bg-teal-50";

  const checkboxClassName = isTermsAccepted
    ? "flex h-6 w-6 min-w-6 items-center justify-center rounded-md border-2 border-teal-600 bg-teal-600 cursor-pointer transition-all hover:bg-teal-700"
    : "flex h-6 w-6 min-w-6 items-center justify-center rounded-md border-2 border-gray-300 bg-white cursor-pointer transition-all hover:border-teal-400 hover:bg-teal-50";

  const infoBoxClassName = "rounded-xl border-l-[3px] border-teal-600 bg-teal-50 px-4 py-3";
  const infoBoxBodyClassName = isInfoCollapsed ? "hidden" : "mt-2 text-xs leading-6 text-gray-600";
  const infoBoxChevronClassName = isInfoCollapsed ? "-rotate-90" : "rotate-0";

  const termsRowClassName = "mb-5 flex items-start gap-2.5";

  return (
    <div className="relative min-h-screen bg-slate-50" onKeyDown={handleKeyDown} role="presentation">
      <div
        className={`h-1 w-full bg-teal-500/40 transition-opacity ${isProgressLoading ? "opacity-100" : "opacity-0"}`}
      ></div>

      {isLoadingVisible && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 px-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 text-center shadow-xl">
            <div className="mx-auto mb-4 h-12 w-12 animate-spin rounded-full border-4 border-teal-500/20 border-t-teal-600" />
            <div className="text-lg font-semibold text-slate-800">{loadingTexts.title}</div>
            <div className="mt-1 text-sm text-slate-500">{loadingTexts.subtitle}</div>
            <div className="mt-5 space-y-3 text-left text-sm">
              <div className="flex items-center gap-3">
                <div className="flex h-7 w-7 items-center justify-center rounded-full bg-emerald-500 text-white">
                  <svg viewBox="0 0 24 24" className="h-4 w-4">
                    <polyline points="20 6 9 17 4 12" fill="none" stroke="currentColor" strokeWidth="2" />
                  </svg>
                </div>
                <span className="font-medium text-emerald-600">Xác thực Google</span>
              </div>
              <div className="flex items-center gap-3">
                <div className="flex h-7 w-7 items-center justify-center rounded-full bg-teal-100 text-teal-600">
                  <div className="h-3 w-3 animate-spin rounded-full border-2 border-teal-300 border-t-teal-600" />
                </div>
                <span className="font-medium text-teal-600">Tạo Smart Contract...</span>
              </div>
              <div className="flex items-center gap-3">
                <div className="h-7 w-7 rounded-full border border-slate-200"></div>
                <span className="text-slate-400">Ghi nhận Blockchain</span>
              </div>
              <div className="flex items-center gap-3">
                <div className="h-7 w-7 rounded-full border border-slate-200"></div>
                <span className="text-slate-400">Hoàn tất</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {isDonorSuccessVisible && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 px-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 text-center shadow-xl">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500 text-white">
              <svg viewBox="0 0 24 24" className="h-6 w-6">
                <polyline points="20 6 9 17 4 12" fill="none" stroke="currentColor" strokeWidth="2" />
              </svg>
            </div>
            <div className="text-lg font-semibold text-slate-800">{donorSuccessTitle}</div>
            <div className="mt-1 text-sm text-slate-500">{donorSuccessSubtitle}</div>
            <div className="mt-4 flex items-center justify-between gap-3 rounded-xl bg-slate-50 px-3 py-2 text-sm">
              <span className="font-medium text-slate-700">{resolvedWalletAddress}</span>
              <button className="text-xs font-semibold text-teal-600 hover:text-teal-700" onClick={handleCopyAddress}>
                {isCopySuccess ? "✓ Đã sao chép" : "⎘ Sao chép"}
              </button>
            </div>
            <Link
              className="mt-5 inline-flex w-full items-center justify-center rounded-xl bg-teal-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-teal-700"
              href="/"
              onClick={handleCloseDonorSuccess}
            >
              → Khám phá dự án từ thiện
            </Link>
          </div>
        </div>
      )}

      {isOrganizationSuccessVisible && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 px-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 text-center shadow-xl">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-sky-500 text-white">
              <svg viewBox="0 0 24 24" className="h-6 w-6">
                <path
                  d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                />
                <polyline points="22,6 12,13 2,6" fill="none" stroke="currentColor" strokeWidth="2" />
              </svg>
            </div>
            <div className="text-lg font-semibold text-slate-800">{organizationSuccessTitle}</div>
            <div className="mt-1 text-sm text-slate-500">{organizationSuccessSubtitle}</div>
            <div className="mt-3 text-sm text-slate-500">
              Email thông báo gửi đến: <strong className="font-semibold text-slate-700">{registeredUserEmail || "your@gmail.com"}</strong>
            </div>
            <Link
              className="mt-5 inline-flex w-full items-center justify-center rounded-xl bg-teal-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-teal-700"
              href="/"
              onClick={handleCloseOrganizationSuccess}
            >
              → Về trang chủ
            </Link>
          </div>
        </div>
      )}

      {isAuditorSuccessVisible && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 px-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 text-center shadow-xl">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-violet-500 text-white">
              <svg viewBox="0 0 24 24" className="h-6 w-6">
                <polyline points="20 6 9 17 4 12" fill="none" stroke="currentColor" strokeWidth="2" />
              </svg>
            </div>
            <div className="text-lg font-semibold text-slate-800">{AUDITOR_SUCCESS_TITLE}</div>
            <div className="mt-1 text-sm text-slate-500">{AUDITOR_SUCCESS_SUBTITLE} Vui lòng đăng nhập lại để nhận phiên mới.</div>
            <div className="mt-4 flex items-center justify-between gap-3 rounded-xl bg-slate-50 px-3 py-2 text-sm">
              <span className="font-mono text-xs font-medium text-slate-700">{resolvedWalletAddress}</span>
              <button className="text-xs font-semibold text-violet-600 hover:text-violet-700" onClick={handleCopyAddress}>
                {isCopySuccess ? "✓ Đã sao chép" : "⎘ Sao chép"}
              </button>
            </div>
            <Link
              className="mt-5 inline-flex w-full items-center justify-center rounded-xl bg-violet-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-violet-700"
              href="/login"
              onClick={handleCloseAuditorSuccess}
            >
              → Đăng nhập ngay
            </Link>
          </div>
        </div>
      )}

      {isAuditorMintFailureVisible && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 px-4" role="dialog" aria-modal="true" aria-labelledby="auditor-mint-failure-title">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 text-center shadow-xl">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-red-500 text-white">!</div>
            <div id="auditor-mint-failure-title" className="text-lg font-semibold text-slate-800">Thanh toán đã được xác nhận</div>
            <p className="mt-2 text-sm leading-6 text-slate-600">Đã chuyển khoản thành công nhưng gặp vấn đề khi chuyển sang token trên mạng lưới Blockchain. Vui lòng liên hệ Admin qua SĐT 036740032 để được hỗ trợ nhanh nhất.</p>
            <button
              type="button"
              className="mt-5 inline-flex w-full items-center justify-center rounded-xl bg-red-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-red-700"
              onClick={() => setIsAuditorMintFailureVisible(false)}
            >
              Đã hiểu
            </button>
          </div>
        </div>
      )}

      {/* Ghi chú: Dùng layout lưới hai cột để đồng bộ bố cục với trang login. */}
      <div className="grid min-h-screen lg:grid-cols-[1.05fr_1.25fr]">
        <aside className="relative hidden flex-col overflow-hidden bg-gradient-to-br from-[#0e7c6b] via-[#0a5c50] to-[#073d36] px-12 py-10 text-white lg:flex">
          <HoneycombOverlay />
          <RadialGlow className="-right-28 -top-28 z-0 h-[360px] w-[360px] bg-[radial-gradient(circle,rgba(26,174,151,0.25)_0%,transparent_70%)]" />
          <RadialGlow className="-bottom-24 -left-24 z-0 h-[320px] w-[320px] bg-[radial-gradient(circle,rgba(255,255,255,0.06)_0%,transparent_70%)]" />

          <Link className="relative z-10 flex items-center gap-3" href="/">
            <div className="flex h-10 w-10 items-center justify-center rounded-[10px] border border-white/30 bg-white/15 backdrop-blur">
              <svg viewBox="0 0 24 24" className="h-[22px] w-[22px] fill-white">
                <path d="M12 21.7C5.8 17.5 2 13.2 2 9a6 6 0 0112 0 6 6 0 0112 0c0 4.2-3.8 8.5-10 12.7z" />
              </svg>
            </div>
            <div>
              <div className="text-lg font-semibold">DCP</div>
              <span className="text-xs text-white/70">Decentralized Charity Platform</span>
            </div>
          </Link>

          <div className="relative z-10 mt-10 rounded-2xl border border-white/15 bg-white/10 p-6 shadow-[0_20px_60px_rgba(7,34,30,0.25)]">
            <div className="text-3xl">🌱</div>
            <div className="mt-4 text-xl font-semibold leading-relaxed">
              Minh bạch là nền tảng của <span className="text-emerald-200">niềm tin</span>
            </div>
            <div className="mt-2 text-sm text-white/70">&ldquo;Charity with Trust.&rdquo;</div>
          </div>

          <div className="relative z-10 mt-8 space-y-3">
            <div className="flex items-center gap-3 rounded-2xl border border-white/15 bg-white/10 p-4">
              <div className="text-2xl">💎</div>
              <div>
                <div className="text-lg font-semibold">100%</div>
                <div className="text-xs text-white/70">Minh bạch on-chain</div>
              </div>
            </div>
            <div className="flex items-center gap-3 rounded-2xl border border-white/15 bg-white/10 p-4">
              <div className="text-2xl">🤝</div>
              <div>
                <div className="text-lg font-semibold">2/3</div>
                <div className="text-xs text-white/70">Multisig giải ngân</div>
              </div>
            </div>
            <div className="flex items-center gap-3 rounded-2xl border border-white/15 bg-white/10 p-4">
              <div className="text-2xl">⚡</div>
              <div>
                <div className="text-lg font-semibold">QF</div>
                <div className="text-xs text-white/70">Quadratic Funding</div>
              </div>
            </div>
          </div>

          <div className="relative z-10 mt-auto flex items-center gap-2 text-xs text-white/70">
            <svg viewBox="0 0 24 24" className="h-4 w-4 fill-white/70">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            </svg>
            Được bảo mật bởi ERC-4337 Account Abstraction
          </div>
        </aside>

        <div className="relative flex flex-col bg-white px-6 py-8 sm:px-10">
          <div className="flex items-center justify-between">
            <Link className="flex items-center gap-2 text-slate-800 lg:hidden" href="/">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 bg-slate-50">
                <svg viewBox="0 0 24 24" className="h-4 w-4 fill-slate-700">
                  <path d="M12 21.7C5.8 17.5 2 13.2 2 9a6 6 0 0112 0 6 6 0 0112 0c0 4.2-3.8 8.5-10 12.7z" />
                </svg>
              </div>
              <span className="text-sm font-semibold">DCP</span>
            </Link>
            <div className="text-xs text-slate-500">
              Đã có tài khoản?{" "}
              <Link className="font-semibold text-teal-600 hover:text-teal-700" href="/login">
                Đăng nhập →
              </Link>
            </div>
          </div>

          <div className="mt-5 flex items-center justify-between">
            <Link className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-700" href="/">
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="15 18 9 12 15 6" />
              </svg>
              Về trang chủ
            </Link>
          </div>

          <div className="mt-6 flex items-center justify-between gap-2 rounded-2xl bg-slate-50 px-4 py-3">
            <div className="flex flex-col items-center gap-2">
              <div className={stepIndicatorState.first.circleClass}>1</div>
              <div className={stepIndicatorState.first.labelClass}>Chọn<br />vai trò</div>
            </div>
            <div className={stepIndicatorState.second.connectorClass}></div>
            <div className="flex flex-col items-center gap-2">
              <div className={stepIndicatorState.second.circleClass}>2</div>
              <div className={stepIndicatorState.second.labelClass}>{secondStepPrimaryLabel}<br />{secondStepSecondaryLabel}</div>
            </div>
            {stepIndicatorState.showSecondConnector && (
              <div className={stepIndicatorState.third?.connectorClass ?? ""}></div>
            )}
            {stepIndicatorState.showThird && (
              <div className="flex flex-col items-center gap-2">
                <div className={stepIndicatorState.third?.circleClass ?? ""}>3</div>
                <div className={stepIndicatorState.third?.labelClass ?? ""}>{thirdStepPrimaryLabel}<br />{thirdStepSecondaryLabel}</div>
              </div>
            )}
          </div>

          <div className="mt-8 flex-1">
            {currentStep === 1 && (
              <div>
                <div className="text-sm font-semibold text-emerald-600">Bắt đầu ngay hôm nay 🌱</div>
                <h1 className="mt-2 text-2xl font-semibold text-slate-900">Bạn tham gia với tư cách nào?</h1>
                <p className="mt-2 text-sm text-slate-500">
                  Chọn loại tài khoản phù hợp để chúng tôi cá nhân hóa trải nghiệm
                </p>

                <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                  <button
                    className={`group relative rounded-2xl border p-5 text-left transition-all ${selectedRole === "donor"
                      ? "border-emerald-500 bg-emerald-50 shadow-[0_12px_30px_rgba(16,185,129,0.2)]"
                      : "border-slate-200 bg-white hover:border-emerald-200 hover:bg-emerald-50/40"
                      }`}
                    onClick={() => handleRoleSelect("donor")}
                  >
                    <div className="absolute right-4 top-4 flex h-7 w-7 items-center justify-center rounded-full border border-emerald-500 bg-emerald-500 text-white opacity-0 transition-opacity group-hover:opacity-100">
                      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    </div>
                    {selectedRole === "donor" && (
                      <div className="absolute right-4 top-4 flex h-7 w-7 items-center justify-center rounded-full border border-emerald-500 bg-emerald-500 text-white">
                        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      </div>
                    )}
                    <div className="flex items-center gap-3">
                      <div className="text-3xl">💛</div>
                      <div>
                        <div className="text-base font-semibold text-slate-900">Nhà hảo tâm</div>
                        <div className="text-xs uppercase text-slate-400">Donor</div>
                      </div>
                    </div>
                    <p className="mt-3 text-sm text-slate-500">
                      Tôi muốn quyên góp và theo dõi tác động của từng đồng tiền đến dự án từ thiện.
                    </p>
                    <div className="mt-4 space-y-2 text-sm text-slate-600">
                      <div className="flex items-center gap-2">
                        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-100 text-emerald-600">
                          ✓
                        </span>
                        Đăng ký nhanh — chỉ 1 bước Google
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-100 text-emerald-600">
                          ✓
                        </span>
                        Nạp tiền VNĐ và quyên góp dự án
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-100 text-emerald-600">
                          ✓
                        </span>
                        Theo dõi minh bạch 100% on-chain
                      </div>
                    </div>
                  </button>

                  <button
                    className={`group relative rounded-2xl border p-5 text-left transition-all ${selectedRole === "organization"
                      ? "border-sky-500 bg-sky-50 shadow-[0_12px_30px_rgba(14,116,144,0.18)]"
                      : "border-slate-200 bg-white hover:border-sky-200 hover:bg-sky-50/40"
                      }`}
                    onClick={() => handleRoleSelect("organization")}
                  >
                    <div className="absolute right-4 top-4 flex h-7 w-7 items-center justify-center rounded-full border border-sky-500 bg-sky-500 text-white opacity-0 transition-opacity group-hover:opacity-100">
                      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    </div>
                    {selectedRole === "organization" && (
                      <div className="absolute right-4 top-4 flex h-7 w-7 items-center justify-center rounded-full border border-sky-500 bg-sky-500 text-white">
                        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      </div>
                    )}
                    <div className="flex items-center gap-3">
                      <div className="text-3xl">🏢</div>
                      <div>
                        <div className="text-base font-semibold text-slate-900">Tổ chức từ thiện</div>
                        <div className="text-xs uppercase text-slate-400">Organization</div>
                      </div>
                    </div>
                    <p className="mt-3 text-sm text-slate-500">
                      Chúng tôi là tổ chức muốn tạo dự án gây quỹ và quản lý giải ngân minh bạch.
                    </p>
                    <div className="mt-4 space-y-2 text-sm text-slate-600">
                      <div className="flex items-center gap-2">
                        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-100 text-emerald-600">
                          ✓
                        </span>
                        Tạo và quản lý dự án từ thiện
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-100 text-emerald-600">
                          ✓
                        </span>
                        Gây quỹ qua Quadratic Funding
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-amber-100 text-amber-600">
                          !
                        </span>
                        Yêu cầu xác minh KYC
                      </div>
                    </div>
                  </button>

                  <button
                    className={`group relative rounded-2xl border p-5 text-left transition-all ${selectedRole === "auditor"
                      ? "border-violet-500 bg-violet-50 shadow-[0_12px_30px_rgba(109,40,217,0.18)]"
                      : "border-slate-200 bg-white hover:border-violet-200 hover:bg-violet-50/40"
                      }`}
                    onClick={() => handleRoleSelect("auditor")}
                  >
                    <div className="absolute right-4 top-4 flex h-7 w-7 items-center justify-center rounded-full border border-violet-500 bg-violet-500 text-white opacity-0 transition-opacity group-hover:opacity-100">
                      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    </div>
                    {selectedRole === "auditor" && (
                      <div className="absolute right-4 top-4 flex h-7 w-7 items-center justify-center rounded-full border border-violet-500 bg-violet-500 text-white">
                        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      </div>
                    )}
                    <div className="flex items-center gap-3">
                      <div className="text-3xl">🔍</div>
                      <div>
                        <div className="text-base font-semibold text-slate-900">{AUDITOR_ROLE_LABEL}</div>
                        <div className="text-xs uppercase text-slate-400">Auditor</div>
                      </div>
                    </div>
                    <p className="mt-3 text-sm text-slate-500">
                      Tôi muốn đi thực địa, xác minh dự án và nhận thưởng khi báo cáo đúng sự thật.
                    </p>
                    <div className="mt-4 space-y-2 text-sm text-slate-600">
                      <div className="flex items-center gap-2">
                        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-100 text-emerald-600">✓</span>
                        Xác minh dự án ngoài thực địa
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-100 text-emerald-600">✓</span>
                        Nhận thưởng khi kết luận đúng
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-amber-100 text-amber-600">!</span>
                        Yêu cầu đặt cọc VND
                      </div>
                    </div>
                  </button>
                </div>

                {selectedRole === "organization" && (
                  <div className="mt-5 flex items-start gap-2 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-500">
                    <svg viewBox="0 0 24 24" className="mt-0.5 h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                      <circle cx="12" cy="12" r="10" />
                      <line x1="12" y1="16" x2="12" y2="12" />
                      <line x1="12" y1="8" x2="12.01" y2="8" />
                    </svg>
                    Tổ chức cần xác minh KYC sau khi đăng ký Google. Thường mất 1–3 ngày làm việc.
                  </div>
                )}

                {selectedRole === "auditor" && (
                  <div className="mt-5 flex items-start gap-2 rounded-xl border border-violet-200 bg-violet-50 p-4 text-sm text-slate-600">
                    <svg viewBox="0 0 24 24" className="mt-0.5 h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                      <circle cx="12" cy="12" r="10" />
                      <line x1="12" y1="16" x2="12" y2="12" />
                      <line x1="12" y1="8" x2="12.01" y2="8" />
                    </svg>
                    Kiểm toán viên phải đặt cọc VND trước khi được cấp quyền. Cọc có thể rút lại sau thời gian chờ; nếu kết luận sai sự thật, một phần cọc sẽ bị phạt.
                  </div>
                )}

                <button
                  className="mt-6 inline-flex w-full items-center justify-center rounded-xl bg-teal-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-teal-700 disabled:cursor-not-allowed disabled:bg-slate-200"
                  disabled={!selectedRole}
                  onClick={() => handleGoToStep(2)}
                >
                  Tiếp tục →
                </button>
              </div>
            )}

            {currentStep === 2 && (
              <div>
                <div className="text-sm font-semibold text-emerald-600">{greetingText}</div>
                <h1 className="mt-2 text-2xl font-semibold text-slate-900">Đăng ký bằng Google</h1>
                <p className="mt-2 text-sm text-slate-500">{subtitleText}</p>

                <button
                  className="mt-4 inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-500 hover:border-slate-300"
                  onClick={handleGoToRoleStep}
                >
                  <span>{roleBadgeText}</span>
                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                    <polyline points="15 18 9 12 15 6" />
                  </svg>
                  Đổi vai trò
                </button>

                <div className="mt-4">
                  <div className={termsRowClassName}>
                    <button type="button" className={checkboxClassName} onClick={handleToggleTerms}>
                      {isTermsAccepted && (
                        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="white" strokeWidth="3">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      )}
                    </button>
                    <label className="text-xs text-slate-500" onClick={handleToggleTerms}>
                      Tôi đồng ý với{' '}
                      <a
                        className="font-semibold text-teal-600"
                        href="#"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setLegalModalVariant('terms');
                          setIsLegalModalOpen(true);
                        }}
                        ref={termsLinkRef}
                      >
                        Điều khoản sử dụng
                      </a>{' '}
                      và{' '}
                      <a
                        className="font-semibold text-teal-600"
                        href="#"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setLegalModalVariant('privacy');
                          setIsLegalModalOpen(true);
                        }}
                        ref={privacyLinkRef}
                      >
                        Chính sách bảo mật
                      </a>{' '}
                      của DCP
                    </label>
                  </div>
                  {termsError && (
                    <p className="mt-1.5 text-xs font-medium text-red-500">{termsError}</p>
                  )}
                </div>

                <div className="mt-6" onClick={handleGoogleRegister}>
                  <div className="group flex h-[50px] w-full items-center justify-center rounded-[10px] border-[1.5px] border-[#e5e7eb] bg-white font-['Be_Vietnam_Pro',sans-serif] text-[14.5px] font-semibold text-[#0d1117] transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-[1px] hover:border-[#0e7c6b] hover:shadow-[0_2px_14px_rgba(14,124,107,0.12)]">
                    <div
                      id={googleRedirectButtonContainerId}
                      className={`flex min-h-[40px] w-full items-center justify-center ${!isTermsAccepted || isRegisterProcessing ? "pointer-events-none opacity-60" : ""}`}
                    />
                  </div>
                </div>

                {selectedRole === "auditor" && (
                  <div className="mt-6 space-y-4 rounded-2xl border border-violet-100 bg-violet-50/40 p-4">
                    <div>
                      <h2 className="text-sm font-semibold text-slate-800">Tài khoản nhận tiền</h2>
                      <p className="mt-1 text-xs text-slate-500">Thông tin này dùng để nhận thưởng và hoàn cọc khi đủ điều kiện.</p>
                    </div>

                    {auditorGoogleCredential ? (
                      <p className="rounded-lg bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-700">✓ Đã xác thực Google</p>
                    ) : (
                      <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs font-medium text-amber-700">Vui lòng xác thực Google trước khi tạo hồ sơ.</p>
                    )}

                    <div>
                      <label htmlFor="auditorBankName" className="text-sm font-semibold text-slate-700">Ngân hàng nhận tiền <span className="text-rose-500">*</span></label>
                      <select
                        id="auditorBankName"
                        className={`mt-2 w-full rounded-xl border bg-white px-4 py-2.5 text-sm text-slate-700 shadow-sm focus:outline-none ${resolveInputValidationClass(auditorBankNameClass)}`}
                        value={auditorBankName}
                        onChange={(event) => setAuditorBankName(event.target.value)}
                      >
                        <option value="">Chọn ngân hàng nhận tiền</option>
                        {AUDITOR_PAYOUT_SUPPORTED_BANKS.map((bank) => (
                          <option key={bank.value} value={bank.value}>{bank.label}</option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label htmlFor="auditorBankAccountNumber" className="text-sm font-semibold text-slate-700">Số tài khoản <span className="text-rose-500">*</span></label>
                      <input
                        id="auditorBankAccountNumber"
                        inputMode="numeric"
                        className={`mt-2 w-full rounded-xl border bg-white px-4 py-2.5 text-sm text-slate-700 shadow-sm placeholder:text-slate-400 focus:outline-none ${resolveInputValidationClass(auditorBankAccountNumberClass)}`}
                        placeholder="Từ 8 đến 20 chữ số"
                        value={auditorBankAccountNumber}
                        onChange={(event) => setAuditorBankAccountNumber(event.target.value.replace(/\D/g, ""))}
                      />
                    </div>

                    <div>
                      <label htmlFor="auditorAccountHolderName" className="text-sm font-semibold text-slate-700">Chủ tài khoản <span className="text-rose-500">*</span></label>
                      <input
                        id="auditorAccountHolderName"
                        className={`mt-2 w-full rounded-xl border bg-white px-4 py-2.5 text-sm uppercase text-slate-700 shadow-sm placeholder:normal-case placeholder:text-slate-400 focus:outline-none ${resolveInputValidationClass(auditorAccountHolderNameClass)}`}
                        placeholder="NGUYEN VAN A"
                        value={auditorAccountHolderName}
                        onChange={(event) => setAuditorAccountHolderName(normalizeAuditorAccountHolderName(event.target.value))}
                      />
                    </div>

                    <div>
                      <label htmlFor="auditorBranchName" className="text-sm font-semibold text-slate-700">Chi nhánh <span className="font-normal text-slate-400">(không bắt buộc)</span></label>
                      <input
                        id="auditorBranchName"
                        className={`mt-2 w-full rounded-xl border bg-white px-4 py-2.5 text-sm text-slate-700 shadow-sm placeholder:text-slate-400 focus:outline-none ${resolveInputValidationClass(auditorBranchNameClass)}`}
                        placeholder="Chi nhánh mở tài khoản"
                        maxLength={200}
                        value={auditorBranchName}
                        onChange={(event) => setAuditorBranchName(event.target.value)}
                      />
                    </div>

                    {auditorStatusMessage && (
                      <p role="status" className="rounded-lg bg-violet-100 px-3 py-2 text-xs text-violet-700">{auditorStatusMessage}</p>
                    )}

                    <button
                      type="button"
                      className="w-full rounded-xl bg-violet-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-violet-700 disabled:cursor-not-allowed disabled:bg-slate-200"
                      disabled={!isAuditorRegisterReady}
                      onClick={() => void handleSubmitAuditorRegister()}
                    >
                      Tạo hồ sơ Kiểm toán viên
                    </button>
                  </div>
                )}

                {registerErrorMessage && (
                  <div role="alert" className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600">
                    {registerErrorMessage}
                  </div>
                )}

                <div className={`${infoBoxClassName} mt-4`}>
                  <button className="flex w-full items-center justify-between" onClick={handleToggleInfoBox}>
                    <div className="flex items-center gap-2 text-sm font-semibold text-slate-700">
                      <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <circle cx="12" cy="12" r="10" />
                        <line x1="12" y1="16" x2="12" y2="12" />
                        <line x1="12" y1="8" x2="12.01" y2="8" />
                      </svg>
                      Tại sao không cần seed phrase?
                    </div>
                    <svg
                      className={`h-4 w-4 transition-transform ${infoBoxChevronClassName}`}
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </button>
                  <div className={infoBoxBodyClassName}>
                    DCP sử dụng công nghệ <strong className="text-teal-600">Account Abstraction (ERC-4337)</strong> — ví của bạn
                    được tạo tự động từ tài khoản Google. An toàn như ngân hàng, không cần ghi nhớ hay lưu trữ khóa bí mật. Mọi giao
                    dịch vẫn ghi nhận đầy đủ trên Blockchain.
                  </div>
                </div>

                <button
                  className="mt-5 inline-flex items-center gap-2 text-sm font-semibold text-slate-500 hover:text-slate-700"
                  onClick={handleGoToRoleStep}
                >
                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                    <polyline points="15 18 9 12 15 6" />
                  </svg>
                  Quay lại chọn vai trò
                </button>
              </div>
            )}

            {currentStep === 3 && selectedRole === "organization" && (
              <div>
                <div className="text-sm font-semibold text-emerald-600">Xác minh tổ chức 🏛</div>
                <h1 className="mt-2 text-2xl font-semibold text-slate-900">Hoàn tất KYC</h1>
                <p className="mt-2 text-sm text-slate-500">Thông tin KYC đảm bảo tính hợp pháp của tổ chức bạn</p>

                {/* Ghi chú: Dùng bố cục dạng cột để đồng bộ trình bày form với các bước trước. */}
                <div className="mt-6 space-y-4">
                  <div>
                    <label className="text-sm font-semibold text-slate-700">
                      Tên tổ chức <span className="text-rose-500">*</span>
                    </label>
                    <div
                      className={`mt-2 flex items-center gap-3 rounded-xl border bg-white px-4 py-2.5 shadow-sm ${resolveInputValidationClass(
                        organizationNameClass
                      )}`}
                    >
                      <svg className="h-5 w-5 text-slate-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                        <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
                        <polyline points="9 22 9 12 15 12 15 22" />
                      </svg>
                      <input
                        type="text"
                        className="w-full text-sm text-slate-700 placeholder:text-slate-400 focus:outline-none"
                        placeholder="Quỹ từ thiện Ánh Sáng Việt Nam"
                        value={organizationName}
                        onChange={(event) => handleOrganizationNameChange(event.target.value)}
                      />
                    </div>
                  </div>

                  <div>
                    <label className="text-sm font-semibold text-slate-700">
                      Mã số thuế / Mã số tổ chức <span className="text-rose-500">*</span>
                    </label>
                    <div
                      className={`mt-2 flex items-center gap-3 rounded-xl border bg-white px-4 py-2.5 shadow-sm ${resolveInputValidationClass(
                        organizationTaxClass
                      )}`}
                    >
                      <svg className="h-5 w-5 text-slate-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                        <rect x="2" y="7" width="20" height="14" rx="2" />
                        <path d="M16 21V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v16" />
                      </svg>
                      <input
                        type="text"
                        className="w-full text-sm text-slate-700 placeholder:text-slate-400 focus:outline-none"
                        placeholder="0123456789"
                        value={organizationTaxCode}
                        onChange={(event) => handleOrganizationTaxCodeChange(event.target.value)}
                      />
                    </div>
                  </div>

                  <div>
                    <label className="text-sm font-semibold text-slate-700">Website chính thức</label>
                    <div className="mt-2 flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-2.5 shadow-sm">
                      <svg className="h-5 w-5 text-slate-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                        <circle cx="12" cy="12" r="10" />
                        <line x1="2" y1="12" x2="22" y2="12" />
                        <path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z" />
                      </svg>
                      <input
                        type="url"
                        className="w-full text-sm text-slate-700 placeholder:text-slate-400 focus:outline-none"
                        placeholder="https://toichuc.org"
                        value={organizationWebsite}
                        onChange={(event) => handleOrganizationWebsiteChange(event.target.value)}
                      />
                    </div>
                  </div>

                  <div>
                    <label className="text-sm font-semibold text-slate-700">
                      Mô tả tổ chức <span className="text-rose-500">*</span>
                    </label>
                    <textarea
                      className={`mt-2 min-h-[120px] w-full rounded-xl border bg-white px-4 py-3 text-sm text-slate-700 placeholder:text-slate-400 focus:outline-none ${resolveInputValidationClass(
                        organizationDescriptionClass
                      )}`}
                      placeholder="Mô tả ngắn về lĩnh vực hoạt động của tổ chức (tối đa 300 ký tự)"
                      maxLength={knowYourCustomerCharacterLimit}
                      value={organizationDescription}
                      onChange={(event) => handleOrganizationDescriptionChange(event.target.value)}
                    ></textarea>
                    <div className="mt-2 text-xs text-slate-400">
                      <span className="font-semibold text-slate-500">{descriptionCount}</span>/{knowYourCustomerCharacterLimit}
                    </div>
                  </div>

                  <div>
                    <label className="text-sm font-semibold text-slate-700">
                      Upload giấy tờ pháp lý <span className="text-rose-500">*</span>
                    </label>
                    {/* Ghi chú: Giữ vùng upload nổi bật để người dùng dễ thao tác kéo thả. */}
                    <div
                      className={`${uploadZoneClassName} mt-2`}
                      onClick={handleUploadClick}
                      onDragOver={handleDragOver}
                      onDragLeave={handleDragLeave}
                      onDrop={handleDrop}
                    >
                      <div className="text-2xl">📎</div>
                      <div className="mt-2 text-sm font-semibold text-slate-700">Kéo thả hoặc click để chọn file</div>
                      <div className="mt-1 text-xs text-slate-500">PDF, JPG, PNG — tối đa 10MB</div>
                    </div>
                    <input
                      id="organizationFileInput"
                      type="file"
                      className="hidden"
                      accept=".pdf,.jpg,.jpeg,.png"
                      multiple
                      onChange={handleUploadChange}
                    />
                    <div className="mt-2 text-xs text-slate-500">
                      Đã chọn {organizationFiles.length}/{maximumKycFileCount} file
                    </div>
                    <div className="mt-3 space-y-2">
                      {uploadInfoList.map((uploadInfo) => (
                        <div key={uploadInfo.id} className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
                          <div className="text-xl">{uploadInfo.icon}</div>
                          <div className="flex-1">
                            <div className="text-sm font-semibold text-slate-700">{uploadInfo.name}</div>
                            <div className="text-xs text-slate-500">{uploadInfo.sizeLabel}</div>
                          </div>
                          <button
                            type="button"
                            className="flex h-8 w-8 items-center justify-center rounded-full border border-slate-200 text-slate-400 hover:border-rose-300 hover:text-rose-500"
                            onClick={(event) => handleRemoveFile(event, uploadInfo.id)}
                          >
                            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                              <line x1="18" y1="6" x2="6" y2="18" />
                              <line x1="6" y1="6" x2="18" y2="18" />
                            </svg>
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="mt-6 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <div className="flex items-center gap-2 text-sm font-semibold text-slate-700">
                    <svg className="h-4 w-4 text-slate-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <circle cx="12" cy="12" r="10" />
                      <polyline points="12 6 12 12 16 14" />
                    </svg>
                    Thời gian xét duyệt
                  </div>
                  <div className="mt-2 text-sm text-slate-500">
                    Đội ngũ DCP sẽ xem xét hồ sơ trong vòng 1–3 ngày làm việc. Bạn sẽ nhận email thông báo kết quả qua tài khoản
                    Google đã đăng ký.
                  </div>
                </div>

                <div className="mt-6 flex flex-col gap-3 sm:flex-row">
                  <button
                    className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-semibold text-slate-600 hover:border-slate-300"
                    onClick={() => handleGoToStep(2)}
                  >
                    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                      <polyline points="15 18 9 12 15 6" />
                    </svg>
                    Quay lại
                  </button>
                  <button
                    className="flex-1 rounded-xl bg-teal-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-teal-700 disabled:cursor-not-allowed disabled:bg-slate-200"
                    disabled={!isKycReady}
                    onClick={handleSubmitKyc}
                  >
                    📤 Nộp hồ sơ KYC
                  </button>
                </div>

                {kycSubmitErrorMessage && (
                  <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
                    {kycSubmitErrorMessage}
                  </div>
                )}
              </div>
            )}

            {currentStep === 3 && selectedRole === "auditor" && (
              <div>
                <div className="text-sm font-semibold text-violet-600">Kích hoạt quyền kiểm toán 🔍</div>
                <h1 className="mt-2 text-2xl font-semibold text-slate-900">Nạp VND & đặt cọc</h1>
                <p className="mt-2 text-sm text-slate-500">{AUDITOR_STEP_THREE_SUBTITLE}</p>

                <div className="mt-6 space-y-3 rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-slate-500">Mức cọc tối thiểu</span>
                    <strong className="text-slate-800">{formatDctAmount(auditorMinimumStakeThreshold || "0")} VND</strong>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-slate-500">Số dư hiện có</span>
                    <strong className="text-slate-800">{formatDctAmount(auditorTokenBalance || "0")} VND</strong>
                  </div>
                  <div className="flex items-start justify-between gap-3">
                    <span className="text-slate-500">Ví Smart Account</span>
                    <div className="flex items-center gap-2">
                      <code className="font-mono text-xs text-slate-700">{compactAuditorWalletAddress}</code>
                      <button type="button" className="text-xs font-semibold text-violet-600 hover:text-violet-700" onClick={handleCopyAddress}>
                        {isCopySuccess ? "✓ Đã sao chép" : "⎘ Sao chép"}
                      </button>
                    </div>
                  </div>
                </div>

                {auditorStakeStage === "NEED_TOKEN" && (
                  <div className="mt-6 rounded-2xl border border-amber-200 bg-amber-50 p-4">
                    <p className="text-sm font-semibold text-amber-900">Bạn còn thiếu {formatDctAmount(auditorTokenShortfall.toString())} VND để đặt cọc.</p>
                    <p className="mt-1 text-xs text-amber-800">VND được nạp trực tiếp vào ví Smart Account của bạn.</p>
                    {auditorTokenShortfall > 0n && auditorTokenShortfall < 10000n && (
                      <p className="mt-2 text-xs font-medium text-amber-800">Mức nạp tối thiểu mỗi lần là 10.000 VNĐ.</p>
                    )}
                    {auditorDepositAmount === null && (
                      <p className="mt-2 text-xs font-medium text-rose-800">Số VND cần nạp vượt giới hạn thanh toán. Vui lòng liên hệ hỗ trợ.</p>
                    )}
                    <div className="mt-4 flex flex-col gap-3 sm:flex-row">
                      <button
                        type="button"
                        className="flex-1 rounded-xl bg-violet-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-violet-700 disabled:cursor-not-allowed disabled:bg-slate-300"
                        disabled={isRegisterProcessing || auditorDepositAmount === null}
                        onClick={() => void handleCreateAuditorDeposit()}
                      >
                        {auditorDepositAmount === null
                          ? "💳 Số VND vượt giới hạn"
                          : `💳 Nạp ${formatDctAmount(String(auditorDepositAmount))} VND`}
                      </button>
                      <button
                        type="button"
                        className="rounded-xl border border-slate-300 px-4 py-2.5 text-sm font-semibold text-slate-600 hover:border-slate-400 disabled:cursor-not-allowed disabled:text-slate-400"
                        disabled={isRegisterProcessing}
                        onClick={() => void handleRefreshAuditorTokenBalance()}
                      >
                        🔄 Kiểm tra lại số dư
                      </button>
                    </div>
                  </div>
                )}

                {auditorStakeStage === "AWAITING_PAYMENT" && (
                  <div className="mt-6 rounded-2xl border border-sky-200 bg-sky-50 p-4">
                    <p className="text-sm font-semibold text-sky-900">Đang chờ thanh toán phiếu nạp VND</p>
                    <p className="mt-2 text-xs text-sky-800">Mã đơn đối soát: <code className="font-mono font-semibold">{auditorDepositOrderCode}</code></p>
                    {auditorDepositExpiresAt && (
                      <p className="mt-1 text-xs text-sky-800">Phiếu hết hạn lúc: {new Date(auditorDepositExpiresAt).toLocaleString("vi-VN")}</p>
                    )}
                    {auditorDepositPaymentUrl && (
                      <a
                        className="mt-3 inline-flex text-sm font-semibold text-violet-700 underline underline-offset-2"
                        href={auditorDepositPaymentUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Mở lại trang thanh toán
                      </a>
                    )}
                    <button
                      type="button"
                      className="mt-4 w-full rounded-xl bg-violet-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-violet-700 disabled:cursor-not-allowed disabled:bg-slate-300"
                      disabled={isRegisterProcessing}
                      onClick={() => void handleCheckAuditorDeposit()}
                    >
                      ✅ Tôi đã thanh toán
                    </button>
                  </div>
                )}

                {auditorStakeStage === "READY_TO_STAKE" && (
                  <div className="mt-6 rounded-2xl border border-violet-200 bg-violet-50 p-4">
                    <p className="text-sm font-medium text-violet-900">Đã đủ số dư VND. Hệ thống đang tự động ghi nhận khoản cọc trên Blockchain.</p>
                    <p className="mt-2 text-xs leading-5 text-violet-800">Bạn không cần gửi thêm thao tác. Quyền Kiểm toán viên chỉ được cấp sau khi giao dịch on-chain được xác minh thành công.</p>
                  </div>
                )}

                {auditorStakeStage === "FAILED" && (
                  <div className="mt-6 rounded-2xl border border-amber-200 bg-amber-50 p-4">
                    <p className="text-sm font-medium text-amber-900">Hệ thống chưa thể hoàn tất khoản cọc tự động.</p>
                    <p className="mt-2 text-xs leading-5 text-amber-800">Không có khoản VND nào bị trừ thêm. Hệ thống chỉ gửi lại giao dịch cọc trong giới hạn an toàn và luôn kiểm tra số dư on-chain trước khi thực hiện.</p>
                  </div>
                )}

                {(auditorStakeStage === "VERIFYING" || auditorStakeStage === "FAILED") && (
                  <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-4">
                    {auditorStakeTxHash && <p className="break-all font-mono text-xs text-slate-600">Tx: {auditorStakeTxHash}</p>}
                    <button
                      type="button"
                      className="mt-3 w-full rounded-xl border border-violet-300 px-4 py-2.5 text-sm font-semibold text-violet-700 hover:bg-violet-50 disabled:cursor-not-allowed disabled:text-slate-400"
                      disabled={isRegisterProcessing || !auditorIntentId}
                      onClick={() => void handleCheckAuditorStatus(auditorStakeStage === "FAILED")}
                    >
                      🔄 Kiểm tra trạng thái
                    </button>
                  </div>
                )}

                {auditorStatusMessage && (
                  <p role="status" className="mt-4 rounded-xl border border-violet-100 bg-violet-50 px-3 py-2 text-sm text-violet-700">{auditorStatusMessage}</p>
                )}
                {auditorErrorMessage && (
                  <p role="alert" className="mt-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">{auditorErrorMessage}</p>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
      <AuthLegalModal
        open={isLegalModalOpen}
        onClose={() => setIsLegalModalOpen(false)}
        variant={legalModalVariant}
        triggerRef={legalModalVariant === 'terms' ? termsLinkRef : privacyLinkRef}
      />
      <style jsx global>{`
        /* Ghi chú logic phức tạp: chỉ tinh chỉnh lớp CSS do Google render để đồng nhất giao diện nút với trang đăng nhập, */
        /* không thay đổi hành vi callback xác thực Google. */
        #googleRedirectButtonContainer .nsm7Bb-HzV7m-LgbsSe-bN97Pc-sM5MNb {
          border: none !important;
          box-shadow: none !important;
        }
      `}</style>
    </div>
  );
}
