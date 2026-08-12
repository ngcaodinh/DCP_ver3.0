import type { EmailPreferenceNotificationType, NotificationItem } from './types';

interface EmailPreferencePresentation {
  label: string;
  description: string;
}

const NOTIFICATION_ICON_BY_TYPE: Record<string, string> = {
  DONATION_RECEIVED: '💚',
  DISBURSEMENT_SIGNED: '✍️',
  PROJECT_APPROVED: '✓',
  KYC_EXPIRING: '⏳',
  LARGE_DONATION: '💎',
  DISBURSEMENT_COMPLETED: '✓',
  MANUAL_REVIEW_ESCALATION: '⚠️',
  OVERRIDE_APPROVED: '🛡️',
  SBT_MINT_FAILED: '⚠️',
  SYSTEM: '🔔'
};

const EMAIL_PREFERENCE_PRESENTATION_BY_TYPE: Record<EmailPreferenceNotificationType, EmailPreferencePresentation> = {
  LARGE_DONATION: {
    label: 'Quyên góp lớn',
    description: 'Nhận email khi có khoản quyên góp lớn cho dự án của bạn.'
  },
  DISBURSEMENT_COMPLETED: {
    label: 'Giải ngân hoàn tất',
    description: 'Nhận email khi một yêu cầu giải ngân đã hoàn tất.'
  },
  MANUAL_REVIEW_ESCALATION: {
    label: 'Yêu cầu cần xem xét',
    description: 'Nhận email khi có yêu cầu cần được xem xét thủ công.'
  },
  OVERRIDE_APPROVED: {
    label: 'Ghi đè được phê duyệt',
    description: 'Nhận email khi một yêu cầu ghi đè đã được phê duyệt.'
  },
  SBT_MINT_FAILED: {
    label: 'Lỗi mint SBT',
    description: 'Nhận email khi quá trình mint SBT gặp lỗi cần xử lý.'
  }
};

/** Trả icon an toàn cho mọi type, bao gồm SYSTEM hoặc type mới chưa được frontend biết đến. */
export function getNotificationIcon(notificationType: string): string {
  return NOTIFICATION_ICON_BY_TYPE[notificationType] ?? '🔔';
}

/** Định dạng thời điểm theo locale Việt Nam và trả fallback khi dữ liệu BE không parse được. */
export function formatNotificationTimestamp(createdAt: string): string {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) {
    return 'Không rõ thời gian';
  }
  return date.toLocaleString('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

/** Tạo accessible label ngắn gọn cho notification để người dùng dùng screen reader biết trạng thái đọc. */
export function getNotificationAccessibleLabel(notification: NotificationItem): string {
  const readState = notification.isRead ? 'đã đọc' : 'chưa đọc';
  return `${notification.title}, ${readState}, ${formatNotificationTimestamp(notification.createdAt)}`;
}

/** Nhãn và mô tả dễ hiểu cho năm email toggle được phép hiển thị trong settings E4. */
export function getEmailPreferencePresentation(notificationType: EmailPreferenceNotificationType): {
  label: string;
  description: string;
} {
  return EMAIL_PREFERENCE_PRESENTATION_BY_TYPE[notificationType];
}
