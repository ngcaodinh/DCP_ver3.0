import { describe, expect, it } from "vitest";
import { AUDITOR_ROLE_LABEL } from "@/app/constants/auditorRegistration";
import { REGISTER_ROLE_CONFIG } from "@/app/constants/registerRoles";

describe("REGISTER_ROLE_CONFIG", () => {
  it("giữ Donor hai bước và Organization ba bước như luồng đăng ký trước đó", () => {
    expect(REGISTER_ROLE_CONFIG.donor).toMatchObject({
      label: "Nhà hảo tâm",
      hasThirdStep: false,
      stepLabels: { second: "Đăng ký|Google", third: "" },
    });
    expect(REGISTER_ROLE_CONFIG.organization).toMatchObject({
      label: "Tổ chức từ thiện",
      hasThirdStep: true,
      stepLabels: { second: "Đăng ký|Google", third: "Xác minh|KYC" },
    });
  });

  it("cấu hình Auditor đủ ba bước với nhãn cọc DCT và không trùng vai trò Google login", () => {
    expect(REGISTER_ROLE_CONFIG.auditor).toMatchObject({
      label: AUDITOR_ROLE_LABEL,
      hasThirdStep: true,
      stepLabels: { second: "Đăng ký|& tài khoản", third: "Đặt cọc|VND" },
    });
    expect(REGISTER_ROLE_CONFIG.auditor.badge).toContain(AUDITOR_ROLE_LABEL);
    expect(REGISTER_ROLE_CONFIG.auditor.greeting).toContain(AUDITOR_ROLE_LABEL);
  });
});
