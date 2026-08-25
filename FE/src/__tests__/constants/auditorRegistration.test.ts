import { describe, expect, it } from "vitest";
import {
  AUDITOR_INTENT_STORAGE_KEY,
  AUDITOR_PAYOUT_SUPPORTED_BANKS,
  formatDctAmount,
  getAuditorApiErrorMessage,
  normalizeAuditorAccountHolderName,
} from "@/app/constants/auditorRegistration";

const PAYOS_BANK_KEYS = [
  "VIETCOMBANK", "BIDV", "VIETINBANK", "AGRIBANK", "ACB", "MB", "KIENLONGBANK", "SHINHAN BANK", "SHINHANBANK",
  "TECHCOMBANK", "MBBANK", "VPBANK", "SACOMBANK", "TPBANK", "OCB", "HDBANK", "VIB", "SHB", "MSB", "SEABANK", "LPBANK",
];

describe("auditorRegistration constants", () => {
  it("giữ 19 ngân hàng nhận tiền khớp whitelist PayOS backend", () => {
    const supportedBankValues = AUDITOR_PAYOUT_SUPPORTED_BANKS.map(({ value }) => value);
    expect(AUDITOR_PAYOUT_SUPPORTED_BANKS).toHaveLength(19);
    expect(new Set(supportedBankValues).size).toBe(19);
    expect(supportedBankValues).toEqual([
      "Vietcombank", "BIDV", "VietinBank", "Agribank", "ACB", "MB", "KienlongBank", "Shinhan Bank",
      "Techcombank", "VPBank", "Sacombank", "TPBank", "OCB", "HDBank", "VIB", "SHB", "MSB", "SeABank", "LPBank",
    ]);
    AUDITOR_PAYOUT_SUPPORTED_BANKS.forEach(({ value }) => {
      const normalizedValue = value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
      expect(PAYOS_BANK_KEYS).toContain(normalizedValue);
    });
  });

  it("chuẩn hóa chủ tài khoản và định dạng DCT 0 decimals", () => {
    expect(normalizeAuditorAccountHolderName("Nguyễn Văn Đức")).toBe("NGUYEN VAN DUC");
    expect(normalizeAuditorAccountHolderName("  trần thị b ")).toMatch(/^[A-Z\s]+$/);
    expect(formatDctAmount("3000000")).toBe("3.000.000");
    expect(formatDctAmount("not-a-number")).toBe("not-a-number");
  });

  it("ánh xạ lỗi giới hạn và token Google trước khi dùng message chung", () => {
    expect(getAuditorApiErrorMessage({ errorCode: "RATE_LIMIT_EXCEEDED", message: "x" }, "fallback")).toContain("1 giờ");
    expect(getAuditorApiErrorMessage({ errorCode: "UNAUTHENTICATED", message: "x" }, "fallback")).toContain("Google");
    expect(getAuditorApiErrorMessage({ errorCode: "PAYMASTER_POLICY_MISMATCH", message: "x" }, "fallback")).toContain("Không có VND nào bị trừ thêm");
    expect(getAuditorApiErrorMessage({ message: "Email này đã tồn tại." }, "fallback")).toBe("Email này đã tồn tại.");
    expect(getAuditorApiErrorMessage(new Error("boom"), "fallback")).toBe("boom");
    expect(getAuditorApiErrorMessage(undefined, "fallback")).toBe("fallback");
    expect(AUDITOR_INTENT_STORAGE_KEY).toBe("dcpAuditorOnboardingIntentId");
  });
});
