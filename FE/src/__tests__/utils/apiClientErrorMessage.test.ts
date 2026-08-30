import { describe, expect, it } from "vitest";
import { getApiErrorMessage } from "@/app/utils/apiClient";

describe("getApiErrorMessage", () => {
  it("ưu tiên message hợp lệ từ payload API hoặc Error", () => {
    expect(getApiErrorMessage({ success: false, message: "Email này đã tồn tại.", errorCode: "EMAIL_EXISTS" }, "fallback"))
      .toBe("Email này đã tồn tại.");
    expect(getApiErrorMessage(new Error("boom"), "fallback")).toBe("boom");
  });

  it("dùng fallback khi message rỗng hoặc dữ liệu lỗi không có shape API", () => {
    expect(getApiErrorMessage({ message: "   " }, "fallback")).toBe("fallback");
    expect(getApiErrorMessage(undefined, "fallback")).toBe("fallback");
    expect(getApiErrorMessage(null, "fallback")).toBe("fallback");
    expect(getApiErrorMessage("lỗi dạng chuỗi", "fallback")).toBe("fallback");
    expect(getApiErrorMessage({ message: 123 }, "fallback")).toBe("fallback");
  });

  it("does not expose the failed API host for network errors", () => {
    expect(getApiErrorMessage(new TypeError("Failed to fetch (localhost:4000)"), "Không thể kết nối máy chủ.")).toBe("Không thể kết nối máy chủ.");
  });
});
