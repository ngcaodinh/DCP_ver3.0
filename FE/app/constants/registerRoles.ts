import { AUDITOR_ROLE_LABEL } from "./auditorRegistration";

export type RegisterRoleConfig = {
  label: string;
  badge: string;
  greeting: string;
  subtitle: string;
  hasThirdStep: boolean;
  stepLabels: { second: string; third: string };
};

/** Cấu hình toàn bộ copy hiển thị theo vai trò trong wizard đăng ký. */
export const REGISTER_ROLE_CONFIG: Record<"donor" | "organization" | "auditor", RegisterRoleConfig> = {
  donor: {
    label: "Nhà hảo tâm",
    badge: "💛 Nhà hảo tâm",
    greeting: "Tạo tài khoản Donor 💛",
    subtitle: "Chỉ cần 1 click — ví của bạn được tạo tự động",
    hasThirdStep: false,
    stepLabels: { second: "Đăng ký|Google", third: "" },
  },
  organization: {
    label: "Tổ chức từ thiện",
    badge: "🏢 Tổ chức từ thiện",
    greeting: "Tạo tài khoản Organization 🏢",
    subtitle: "Yêu cầu KYC sau khi tạo ví Smart Account",
    hasThirdStep: true,
    stepLabels: { second: "Đăng ký|Google", third: "Xác minh|KYC" },
  },
  auditor: {
    label: AUDITOR_ROLE_LABEL,
    badge: `🔍 ${AUDITOR_ROLE_LABEL}`,
    greeting: `Tạo tài khoản ${AUDITOR_ROLE_LABEL} 🔍`,
    subtitle: "Xác thực Google, khai tài khoản nhận tiền, rồi đặt cọc VND",
    hasThirdStep: true,
    stepLabels: { second: "Đăng ký|& tài khoản", third: "Đặt cọc|VND" },
  },
};
