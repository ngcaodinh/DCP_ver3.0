import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EvidenceCameraCapture } from '@/app/components/common/evidenceCamera/EvidenceCameraCapture';

const originalHiddenDescriptor = Object.getOwnPropertyDescriptor(document, 'hidden');
const originalMediaDevicesDescriptor = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
const originalGeolocationDescriptor = Object.getOwnPropertyDescriptor(navigator, 'geolocation');
const originalSecureContextDescriptor = Object.getOwnPropertyDescriptor(window, 'isSecureContext');

/** Khôi phục API trình duyệt sau mỗi test để không rò rỉ capability mock. */
function restoreDescriptor(target: object, key: string, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) Object.defineProperty(target, key, descriptor);
  else Reflect.deleteProperty(target, key);
}

afterEach(() => {
  vi.restoreAllMocks();
  restoreDescriptor(document, 'hidden', originalHiddenDescriptor);
  restoreDescriptor(navigator, 'mediaDevices', originalMediaDevicesDescriptor);
  restoreDescriptor(navigator, 'geolocation', originalGeolocationDescriptor);
  restoreDescriptor(window, 'isSecureContext', originalSecureContextDescriptor);
});

describe('EvidenceCameraCapture', () => {
  it('renders an accessible styled delete button and removes the selected photo', () => {
    const onChange = vi.fn();
    const revokeObjectUrl = vi.spyOn(URL, 'revokeObjectURL');
    const photo = {
      localId: 'photo-001', contentBase64: 'Zm9v', mimeType: 'image/jpeg' as const, fileName: 'capture.jpg', previewObjectUrl: 'blob:photo-001',
      gps: { latitude: 21, longitude: 105 }, accuracyMeters: 10, capturedAtClient: '2026-01-01T00:00:00.000Z',
      geolocationTimestamp: '2026-01-01T00:00:00.000Z', lowAccuracyOverride: false, overrideUnlockedAfterMs: null, lowAccuracyReason: null,
    };

    render(<EvidenceCameraCapture maxPhotos={5} photos={[photo]} onChange={onChange} moduleLabel="khiếu nại" />);

    const deleteButton = screen.getByRole('button', { name: 'Xóa ảnh đã chụp' });
    expect(deleteButton).toHaveClass('border-rose-200', 'bg-rose-50');
    fireEvent.click(deleteButton);

    expect(revokeObjectUrl).toHaveBeenCalledWith(photo.previewObjectUrl);
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it('only requests camera and location after the user explicitly enables them', async () => {
    const getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [] });
    const watchPosition = vi.fn(() => 42);

    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: { watchPosition, clearWatch: vi.fn() } });

    const { unmount } = render(<EvidenceCameraCapture maxPhotos={5} photos={[]} onChange={vi.fn()} moduleLabel="khiếu nại" />);

    expect(getUserMedia).not.toHaveBeenCalled();
    expect(watchPosition).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Bật camera và vị trí' }));
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));
    expect(watchPosition).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('shows the denied-permission message only when the browser returns a permission error', async () => {
    const getUserMedia = vi.fn().mockRejectedValue({ name: 'NotAllowedError' });

    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: { watchPosition: vi.fn(), clearWatch: vi.fn() } });

    const { unmount } = render(<EvidenceCameraCapture maxPhotos={5} photos={[]} onChange={vi.fn()} moduleLabel="khiếu nại" />);
    fireEvent.click(screen.getByRole('button', { name: 'Bật camera và vị trí' }));

    expect(await screen.findByText('Camera hoặc vị trí chưa được cấp quyền. Hãy cho phép quyền rồi thử lại.')).toBeInTheDocument();
    unmount();
  });

  it('does not mislabel a non-permission camera failure as a denied permission', async () => {
    const getUserMedia = vi.fn().mockRejectedValue({ name: 'NotReadableError' });

    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: { watchPosition: vi.fn(), clearWatch: vi.fn() } });

    const { unmount } = render(<EvidenceCameraCapture maxPhotos={5} photos={[]} onChange={vi.fn()} moduleLabel="khiếu nại" />);
    fireEvent.click(screen.getByRole('button', { name: 'Bật camera và vị trí' }));

    expect(await screen.findByText('Không thể truy cập camera hoặc vị trí. Hãy kiểm tra thiết bị rồi thử lại.')).toBeInTheDocument();
    expect(screen.queryByText('Camera hoặc vị trí chưa được cấp quyền. Hãy cho phép quyền rồi thử lại.')).not.toBeInTheDocument();
    unmount();
  });

  it('does not mislabel an unavailable location as a denied permission', async () => {
    const getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [] });
    const watchPosition = vi.fn((_success: PositionCallback, error: PositionErrorCallback) => {
      error({ code: 2 } as GeolocationPositionError);
      return 42;
    });

    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: { watchPosition, clearWatch: vi.fn() } });

    const { unmount } = render(<EvidenceCameraCapture maxPhotos={5} photos={[]} onChange={vi.fn()} moduleLabel="khiếu nại" />);
    fireEvent.click(screen.getByRole('button', { name: 'Bật camera và vị trí' }));

    expect(await screen.findByText('Không thể truy cập camera hoặc vị trí. Hãy kiểm tra thiết bị rồi thử lại.')).toBeInTheDocument();
    expect(screen.queryByText('Camera hoặc vị trí chưa được cấp quyền. Hãy cho phép quyền rồi thử lại.')).not.toBeInTheDocument();
    unmount();
  });

  it('clears the active location watcher while hidden and creates only one fresh watcher on resume', async () => {
    const firstTrackStop = vi.fn();
    const secondTrackStop = vi.fn();
    const getUserMedia = vi.fn()
      .mockResolvedValueOnce({ getTracks: () => [{ stop: firstTrackStop }] })
      .mockResolvedValueOnce({ getTracks: () => [{ stop: secondTrackStop }] });
    const clearWatch = vi.fn();
    const watchPosition = vi.fn((success: PositionCallback) => {
      success({ coords: { accuracy: 10, latitude: 21, longitude: 105 }, timestamp: Date.now() } as GeolocationPosition);
      return 42;
    });

    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: { watchPosition, clearWatch } });
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });

    const { unmount } = render(<EvidenceCameraCapture maxPhotos={5} photos={[]} onChange={vi.fn()} moduleLabel="khiếu nại" />);
    fireEvent.click(screen.getByRole('button', { name: 'Bật camera và vị trí' }));
    await waitFor(() => expect(watchPosition).toHaveBeenCalledTimes(1));

    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    fireEvent(document, new Event('visibilitychange'));
    expect(clearWatch).toHaveBeenCalledWith(42);
    expect(firstTrackStop).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    fireEvent(document, new Event('visibilitychange'));
    await waitFor(() => expect(watchPosition).toHaveBeenCalledTimes(2));
    unmount();
    expect(clearWatch).toHaveBeenCalledTimes(2);
    expect(secondTrackStop).toHaveBeenCalledTimes(1);
  });
});
