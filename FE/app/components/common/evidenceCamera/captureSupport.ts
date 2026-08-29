/** Phát hiện điều kiện trình duyệt tối thiểu để chụp ảnh camera an toàn. */
export function getCameraCaptureSupport(): { isSupported: boolean; missingCapabilities: string[] } {
  if (typeof window === 'undefined') return { isSupported: false, missingCapabilities: ['window'] };
  const missingCapabilities = [!window.isSecureContext && 'HTTPS', !navigator.mediaDevices?.getUserMedia && 'camera', !navigator.geolocation && 'geolocation'].filter(Boolean) as string[];
  return { isSupported: missingCapabilities.length === 0, missingCapabilities };
}
