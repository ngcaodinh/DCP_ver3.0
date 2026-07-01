/**
 * Các kiểu kết quả delivery cho E2 — Multi-channel Delivery.
 */

/**
 * Kết quả delivery thành công qua 1 channel.
 */
export type DeliverySuccess = {
  success: true;
  channel: string;
  /** ID/identifier từ provider (messageId của email, FCM messageId, etc.) */
  providerMessageId?: string;
  /** Latency từ lúc gọi đến khi có response (ms) */
  latencyMs?: number;
};

/**
 * Kết quả delivery thất bại qua 1 channel.
 */
export type DeliveryFailure = {
  success: false;
  channel: string;
  errorMessage: string;
  /** Mã lỗi từ provider (nếu có) */
  errorCode?: string;
  retryable: boolean;
};

/**
 * Discriminated union cho kết quả delivery.
 * Gọi code dùng `result.success === true` để phân biệt.
 */
export type DeliveryResult = DeliverySuccess | DeliveryFailure;

/**
 * Kết quả dispatch của tất cả channels cho 1 notification.
 */
export type DispatchResult = {
  notificationId: string;
  channelResults: DeliveryResult[];
  allSucceeded: boolean;
  anyFailed: boolean;
};

/**
 * Thông tin user cần thiết cho việc dispatch notification.
 * Lấy từ service layer hoặc cache.
 */
export type DispatchContext = {
  userId: string;
  /** Email của user — bắt buộc nếu EMAIL channel được request */
  userEmail?: string;
  /** Device FCM token — bắt buộc nếu PUSH channel được request */
  fcmDeviceToken?: string;
  /** Số điện thoại — bắt buộc nếu SMS channel được request */
  phoneNumber?: string;
  /** Token unsubscribe — được inject vào email */
  unsubscribeToken?: string;
  /** Số tiền donation (cho threshold check LARGE_DONATION) */
  donationAmountVnd?: number;
};
