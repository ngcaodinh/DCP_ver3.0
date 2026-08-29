'use client';

/* eslint-disable @next/next/no-img-element */

import { type ReactElement, useEffect, useRef, useState } from 'react';
import { EVIDENCE_CAPTURE_POLICY } from '@/app/utils/evidenceCapturePolicy';
import { captureImageFromVideo } from './captureImageFromVideo';
import { getCameraCaptureSupport } from './captureSupport';
import type { CapturedEvidencePhoto, GeolocationGateState } from './types';

interface EvidenceCameraCaptureProps {
  maxPhotos: number;
  photos: CapturedEvidencePhoto[];
  onChange: (photos: CapturedEvidencePhoto[]) => void;
  moduleLabel: string;
  disabled?: boolean;
  onSupportChange?: (isSupported: boolean) => void;
}

const PERMISSION_DENIED_ERROR_CODE = 1;

/** Ước lượng byte từ base64 để chặn tổng dung lượng trước khi gọi API. */
function getBase64ByteLength(value: string): number {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((value.length * 3) / 4) - padding);
}

/** Xác định lỗi trình duyệt báo quyền camera bị từ chối. */
function isPermissionDeniedError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('name' in error)) return false;
  return error.name === 'NotAllowedError';
}

/** Cung cấp giao diện chụp ảnh trực tiếp với GPS gate, không có đường chọn hay tải file. */
export function EvidenceCameraCapture({ maxPhotos, photos, onChange, moduleLabel, disabled = false, onSupportChange }: EvidenceCameraCaptureProps): ReactElement {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const positionRef = useRef<GeolocationPosition | null>(null);
  const firstFixRef = useRef<number | null>(null);
  const photosRef = useRef(photos);
  const onSupportChangeRef = useRef(onSupportChange);
  const [state, setState] = useState<GeolocationGateState>('IDLE');
  const [reason, setReason] = useState('');
  const [accuracy, setAccuracy] = useState<number | null>(null);
  const [captureError, setCaptureError] = useState('');
  const hasRequestedCaptureRef = useRef(false);
  const startCaptureDevicesRef = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => { photosRef.current = photos; }, [photos]);
  useEffect(() => { onSupportChangeRef.current = onSupportChange; }, [onSupportChange]);

  useEffect(() => {
    let disposed = false;
    let watchId: number | null = null;
    /** Dừng stream camera để giải phóng thiết bị khi người dùng ẩn trang hoặc đóng form. */
    const stopCamera = (): void => {
      streamRef.current?.getTracks().forEach(track => track.stop());
      streamRef.current = null;
      if (videoRef.current) videoRef.current.srcObject = null;
    };
    /** Hủy theo dõi vị trí đang hoạt động để không tiếp tục thu thập GPS ngoài ý muốn. */
    const stopLocationWatch = (): void => {
      if (watchId !== null) navigator.geolocation.clearWatch(watchId);
      watchId = null;
    };
    /** Xin camera và GPS trực tiếp từ lần bấm nút để trình duyệt có user activation hợp lệ. */
    const startCaptureDevices = async (): Promise<void> => {
      const support = getCameraCaptureSupport();
      onSupportChangeRef.current?.(support.isSupported);
      if (!support.isSupported) {
        setState('UNSUPPORTED');
        return;
      }

      stopCamera();
      stopLocationWatch();
      positionRef.current = null;
      firstFixRef.current = null;
      setAccuracy(null);
      setState('ACQUIRING');
      setCaptureError('');
      watchId = navigator.geolocation.watchPosition(
        position => {
          positionRef.current = position;
          firstFixRef.current ||= Date.now();
          setAccuracy(position.coords.accuracy);
          setState(position.coords.accuracy <= EVIDENCE_CAPTURE_POLICY.maxAccuracyMeters
            ? 'READY'
            : Date.now() - firstFixRef.current >= EVIDENCE_CAPTURE_POLICY.lowAccuracyDelayMs ? 'OVERRIDE_AVAILABLE' : 'LOW_ACCURACY');
        },
        error => setState(error.code === PERMISSION_DENIED_ERROR_CODE ? 'PERMISSION_DENIED' : 'CAPTURE_ERROR'),
        { enableHighAccuracy: true, maximumAge: 0, timeout: 15_000 }
      );

      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
        if (disposed || document.hidden) {
          stream.getTracks().forEach(track => track.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
      } catch (error) {
        stopLocationWatch();
        setState(isPermissionDeniedError(error) ? 'PERMISSION_DENIED' : 'CAPTURE_ERROR');
      }
    };
    startCaptureDevicesRef.current = startCaptureDevices;

    /** Chỉ khởi động lại thiết bị khi tab hiện lại nếu người dùng đã chủ động cho phép trước đó. */
    const handleVisibilityChange = (): void => {
      if (document.hidden) {
        stopCamera();
        stopLocationWatch();
        return;
      }
      if (hasRequestedCaptureRef.current) void startCaptureDevices();
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      disposed = true;
      startCaptureDevicesRef.current = null;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      stopCamera();
      stopLocationWatch();
      photosRef.current.forEach(photo => URL.revokeObjectURL(photo.previewObjectUrl));
    };
  }, []);

  useEffect(() => {
    if (!firstFixRef.current || state === 'READY' || state === 'OVERRIDE_AVAILABLE') return undefined;
    const remainingDelay = Math.max(0, EVIDENCE_CAPTURE_POLICY.lowAccuracyDelayMs - (Date.now() - firstFixRef.current));
    const timer = window.setTimeout(() => setState(current => current === 'LOW_ACCURACY' ? 'OVERRIDE_AVAILABLE' : current), remainingDelay);
    return () => window.clearTimeout(timer);
  }, [state]);

  const canCapture = !disabled && photos.length < maxPhotos && (state === 'READY' || (state === 'OVERRIDE_AVAILABLE' && reason.trim().length >= 20));

  /** Bắt đầu xin quyền camera và vị trí từ thao tác trực tiếp của người dùng. */
  const requestCapturePermissions = (): void => {
    hasRequestedCaptureRef.current = true;
    void startCaptureDevicesRef.current?.();
  };

  const capture = async (): Promise<void> => {
    const position = positionRef.current;
    if (!videoRef.current || !position || !canCapture) return;
    try {
      const { blob, contentBase64 } = await captureImageFromVideo(videoRef.current);
      const totalBytes = photos.reduce((sum, photo) => sum + getBase64ByteLength(photo.contentBase64), 0) + blob.size;
      if (blob.size > EVIDENCE_CAPTURE_POLICY.maxImageBytes || totalBytes > EVIDENCE_CAPTURE_POLICY.maxTotalBytes) {
        setCaptureError('Ảnh vượt giới hạn dung lượng cho phép.');
        return;
      }
      const override = state === 'OVERRIDE_AVAILABLE';
      const capturedAt = new Date();
      onChange([...photos, {
        localId: crypto.randomUUID(), contentBase64, mimeType: 'image/jpeg', fileName: `capture-${capturedAt.getTime()}.jpg`,
        previewObjectUrl: URL.createObjectURL(blob), gps: { latitude: position.coords.latitude, longitude: position.coords.longitude },
        accuracyMeters: position.coords.accuracy, capturedAtClient: capturedAt.toISOString(),
        geolocationTimestamp: new Date(position.timestamp).toISOString(), lowAccuracyOverride: override,
        overrideUnlockedAfterMs: override && firstFixRef.current ? Date.now() - firstFixRef.current : null,
        lowAccuracyReason: override ? reason.trim() : null
      }]);
      setCaptureError('');
    } catch {
      setCaptureError('Không thể chụp ảnh. Vui lòng kiểm tra camera và thử lại.');
    }
  };

  const message = state === 'IDLE'
    ? 'Nhấn “Bật camera và vị trí” để cấp quyền chụp ảnh minh chứng tại hiện trường.'
    : state === 'UNSUPPORTED'
    ? 'Thiết bị cần HTTPS, camera và định vị để chụp trực tiếp.'
    : state === 'PERMISSION_DENIED'
      ? 'Camera hoặc vị trí chưa được cấp quyền. Hãy cho phép quyền rồi thử lại.'
      : state === 'CAPTURE_ERROR'
        ? 'Không thể truy cập camera hoặc vị trí. Hãy kiểm tra thiết bị rồi thử lại.'
      : state === 'ACQUIRING'
        ? 'Đang bắt tín hiệu định vị…'
        : state === 'READY'
          ? `Định vị đạt chuẩn · ±${Math.round(accuracy || 0)} m`
          : `Sai số hiện tại ±${Math.round(accuracy || 0)} mét — cần dưới ${EVIDENCE_CAPTURE_POLICY.maxAccuracyMeters} mét mới chụp được.`;

  return <section className="min-w-0 space-y-3 rounded border p-3">
    <p className="text-sm font-medium">Ảnh camera cho {moduleLabel}</p>
    <video ref={videoRef} autoPlay muted playsInline className="aspect-video w-full rounded bg-slate-900" />
    <p role="status" className={state === 'READY' ? 'text-sm text-teal-700' : 'text-sm text-amber-700'}>{message}</p>
    {state === 'OVERRIDE_AVAILABLE' && <textarea aria-label="Lý do sai số GPS" value={reason} onChange={event => setReason(event.target.value)} minLength={20} maxLength={300} placeholder="Nêu lý do sai số GPS (20–300 ký tự)" className="w-full rounded border p-2 text-base sm:text-sm" />}
    {captureError && <p role="alert" className="text-sm text-red-700">{captureError}</p>}
    {(state === 'IDLE' || state === 'PERMISSION_DENIED' || state === 'CAPTURE_ERROR') && <button type="button" disabled={disabled} onClick={requestCapturePermissions} className="rounded border px-3 py-2 disabled:opacity-50">{state === 'IDLE' ? 'Bật camera và vị trí' : 'Thử lại quyền'}</button>}
    <button type="button" disabled={!canCapture} onClick={() => void capture()} className="rounded bg-teal-700 px-3 py-2 text-white disabled:opacity-50">Chụp ảnh</button>
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {photos.map(photo => <div key={photo.localId}>
        <img src={photo.previewObjectUrl} alt="Ảnh đã chụp" className="aspect-square w-full rounded object-cover" />
        <button
          type="button"
          aria-label="Xóa ảnh đã chụp"
          disabled={disabled}
          onClick={() => { URL.revokeObjectURL(photo.previewObjectUrl); onChange(photos.filter(item => item.localId !== photo.localId)); }}
          className="mt-2 inline-flex min-h-9 w-full items-center justify-center gap-1.5 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-semibold text-rose-700 shadow-sm transition-colors hover:border-rose-300 hover:bg-rose-100 hover:text-rose-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="size-4">
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 7h16m-10 4v6m4-6v6M9 7l1-3h4l1 3m-8 0 1 13h8l1-13" />
          </svg>
          <span>Xóa ảnh</span>
        </button>
      </div>)}
    </div>
  </section>;
}
