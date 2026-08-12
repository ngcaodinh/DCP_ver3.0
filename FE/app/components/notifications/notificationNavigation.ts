/**
 * Trả internal route được BE/PO chốt cho metadata navigation.
 * E4 chưa có enum kind/id và whitelist route chính thức, do đó đóng an toàn bằng null thay vì suy đoán URL.
 */
export function getNotificationNavigationPath(_metadata: Record<string, unknown>): string | null {
  return null;
}
