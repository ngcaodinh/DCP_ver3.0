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

/**
 * Runtime namespace object cho DeliveryResult.
 *
 * Test dùng pattern:
 *   const { DeliveryResult } = await import('../types/delivery.types')
 *   const s: typeof DeliveryResult.types = { success: true, channel: 'EMAIL', ... }
 *
 * Property `types` là placeholder có kiểu DeliveryResult để TypeScript
 * cho phép dùng `typeof DeliveryResult.types` làm type annotation trong test.
 */
export const DeliveryResult = {
  /** Placeholder kiểu — dùng `typeof DeliveryResult.types` làm type annotation trong test */
  types: null as unknown as DeliveryResult,
  /** Kiểm tra result có phải DeliverySuccess không */
  isSuccess: (r: DeliveryResult): r is DeliverySuccess => r.success === true,
  /** Kiểm tra result có phải DeliveryFailure không */
  isFailure: (r: DeliveryResult): r is DeliveryFailure => r.success === false,
} as const;

/**
 * Runtime namespace object cho DispatchContext.
 *
 * Test dùng pattern:
 *   const { DispatchContext } = await import('../types/delivery.types')
 *   const ctx: typeof DispatchContext.contextType = { userId: '...', ... }
 *
 * Property `contextType` là placeholder có kiểu DispatchContext để TypeScript
 * cho phép dùng `typeof DispatchContext.contextType` làm type annotation trong test.
 */
export const DispatchContext = {
  /** Placeholder kiểu — dùng `typeof DispatchContext.contextType` làm type annotation trong test */
  contextType: null as unknown as DispatchContext,
  /** Kiểm tra context có đủ thông tin cho EMAIL channel không */
  hasEmail: (ctx: DispatchContext): boolean => !!ctx.userEmail,
  /** Kiểm tra context có đủ thông tin cho PUSH channel không */
  hasPush: (ctx: DispatchContext): boolean => !!ctx.fcmDeviceToken,
  /** Kiểm tra context có đủ thông tin cho SMS channel không */
  hasSms: (ctx: DispatchContext): boolean => !!ctx.phoneNumber,
} as const;
