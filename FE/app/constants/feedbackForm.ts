export const FEEDBACK_MAX_COMMENT_LENGTH = 1000;
export const FEEDBACK_MAX_ANONYMOUS_NAME_LENGTH = 100;

export const FEEDBACK_STATUS_VALUES = [
  'success',
  'duplicate',
  'expired',
  'invalid',
  'closed',
  'ratelimit',
  'error'
] as const;

export type FeedbackStatus = (typeof FEEDBACK_STATUS_VALUES)[number];

const FEEDBACK_STATUS_MESSAGES: Record<FeedbackStatus, string> = {
  success: 'Cảm ơn bạn! Phản hồi đã được ghi nhận và sẽ hiển thị sau khi kiểm duyệt.',
  duplicate: 'Nội dung này vừa được gửi. Nếu muốn bổ sung, vui lòng viết thêm chi tiết.',
  expired: 'Phiên gửi đã hết hạn hoặc đã dùng. Vui lòng tải lại trang và gửi lại.',
  invalid: 'Thông tin chưa hợp lệ. Vui lòng chọn số sao và nhập nhận xét.',
  closed: 'Dự án hiện chưa mở nhận phản hồi.',
  ratelimit: 'Hệ thống đang bận. Vui lòng thử lại sau ít phút.',
  error: 'Hệ thống đang bận. Vui lòng thử lại sau.'
};

/** Chỉ ánh xạ status đã whitelist thành nội dung banner cố định, tránh reflected-content injection. */
export function getFeedbackStatusMessage(status: string | undefined): string | null {
  if (!status || !FEEDBACK_STATUS_VALUES.includes(status as FeedbackStatus)) {
    return null;
  }
  return FEEDBACK_STATUS_MESSAGES[status as FeedbackStatus];
}
