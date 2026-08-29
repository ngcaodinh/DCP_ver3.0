import { EVIDENCE_CAPTURE_POLICY } from '@/app/utils/evidenceCapturePolicy';

/** Chụp frame video, thu nhỏ cạnh dài và mã hóa JPEG base64 không kèm data URL. */
export async function captureImageFromVideo(video: HTMLVideoElement): Promise<{ blob: Blob; contentBase64: string }> {
  const largestSide = Math.max(video.videoWidth, video.videoHeight);
  const scale = largestSide > EVIDENCE_CAPTURE_POLICY.maxImageDimension ? EVIDENCE_CAPTURE_POLICY.maxImageDimension / largestSide : 1;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(video.videoWidth * scale); canvas.height = Math.round(video.videoHeight * scale);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Không thể tạo canvas chụp ảnh.');
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('Không thể mã hóa ảnh JPEG.')), 'image/jpeg', 0.82));
  const contentBase64 = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1] || ''); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob); });
  return { blob, contentBase64 };
}
