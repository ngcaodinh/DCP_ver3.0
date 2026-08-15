/**
 * Chính sách chống flood cho form feedback public; giới hạn phút dùng ở route middleware,
 * còn giới hạn ngày được kiểm tra phân tán trong service.
 * 60 request/phút vẫn cho phép kịch bản 40 người cùng NAT, còn giới hạn ngày giữ ở 500.
 */
export const PUBLIC_FEEDBACK_SUBMISSION_POLICY = {
  minute: {
    maxRequests: 60,
    ttlSeconds: 60,
    windowMs: 60_000
  },
  daily: {
    maxRequests: 500,
    ttlSeconds: 24 * 60 * 60
  }
} as const;
