'use client';

import { type FormEvent, type ReactElement, useEffect, useRef, useState } from 'react';
import { buildSameOriginApiUrl, fetchApi, type ApiErrorResponse } from '@/app/utils/apiClient';
import { readAuthSession } from '@/app/utils/authSession';
import { refreshAuthSession } from '@/app/utils/authSessionRefresh';
import { EvidenceCameraCapture } from '../common/evidenceCamera/EvidenceCameraCapture';
import type { CapturedEvidencePhoto } from '../common/evidenceCamera/types';
import { submitAuditorListingVerification } from '@/app/utils/auditorPortalApi';

interface AuditorListingVerificationFormProps { projectId: string; projectName: string; onCompleted: () => Promise<void>; onClose: () => void; }
type Verdict = 'CONFIRMED' | 'CHALLENGE';

/** Nhận diện lỗi xác thực theo mã lỗi kể cả khi reverse proxy trả sai HTTP status thành 5xx. */
function isAuthenticationError(error: unknown): boolean {
  const apiError = error as ApiErrorResponse;
  return apiError.statusCode === 401 || apiError.errorCode === 'UNAUTHENTICATED';
}

/** Thu thập một kết luận thực địa theo hai API độc lập, bắt buộc ảnh camera cho cả hai nhánh. */
export default function AuditorListingVerificationForm({ projectId, projectName, onCompleted, onClose }: AuditorListingVerificationFormProps): ReactElement {
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');
  const [photos, setPhotos] = useState<CapturedEvidencePhoto[]>([]);
  const [message, setMessage] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const photosRef = useRef(photos);

  /** Giữ tham chiếu ảnh mới nhất để luôn giải phóng preview URL khi đóng form. */
  useEffect(() => { photosRef.current = photos; }, [photos]);
  useEffect(() => () => photosRef.current.forEach(photo => URL.revokeObjectURL(photo.previewObjectUrl)), []);

  /** Gửi payload đúng endpoint theo kết luận, không chuyển trường reason sang nhánh xác nhận. */
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!verdict || !photos.length || (verdict === 'CHALLENGE' && reason.trim().length < 30)) return;
    setIsSubmitting(true);
    try {
      // Khôi phục access token ngay tại thời điểm gửi để tránh request không có Authorization
      // khi tab vừa mở lại hoặc access token đã bị xoay bởi một request khác.
      let accessToken = (readAuthSession().accessToken || '').trim();
      if (!accessToken) {
        const refreshResult = await refreshAuthSession();
        if (refreshResult.status !== 'REFRESHED' || !refreshResult.accessToken.trim()) {
          throw new Error('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại để gửi xác minh.');
        }
        accessToken = refreshResult.accessToken;
      }

      const capturedPhotos = photos.map(({ localId, previewObjectUrl, ...photo }) => photo);
      const clientSubmittedAt = new Date().toISOString();
      const submitVerification = async (token: string): Promise<void> => {
        if (verdict === 'CONFIRMED') {
          await submitAuditorListingVerification(token, { projectId, note: note.trim() || undefined, clientSubmittedAt, photos: capturedPhotos });
          return;
        }
        await fetchApi(buildSameOriginApiUrl('/api/project-governance/challenges'), { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ projectId, reason: reason.trim(), clientSubmittedAt, photos: capturedPhotos }) });
      };

      try {
        await submitVerification(accessToken);
      } catch (error) {
        // Một số proxy cũ chuyển lỗi UNAUTHENTICATED thành HTTP 500; vẫn phải xoay token
        // theo errorCode để không bắt người dùng logout/login thủ công.
        if (!isAuthenticationError(error)) throw error;

        // Chỉ retry sau khi refresh thành công vì request bị chặn trước khi backend đọc body hoặc tạo dữ liệu.
        const refreshResult = await refreshAuthSession();
        if (refreshResult.status !== 'REFRESHED' || !refreshResult.accessToken.trim()) {
          throw new Error('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại để gửi xác minh.');
        }
        await submitVerification(refreshResult.accessToken);
      }
      photos.forEach(photo => URL.revokeObjectURL(photo.previewObjectUrl));
      await onCompleted();
      setSuccessMessage(verdict === 'CONFIRMED' ? 'Đã ghi nhận xác minh thực địa thành công.' : 'Đã ghi nhận khiếu nại thành công.');
    } catch (error) {
      const apiError = error as ApiErrorResponse;
      setMessage(apiError.errorCode === 'DUPLICATE_EVIDENCE_PHOTO' ? 'Một ảnh đã được dùng cho bản ghi khác. Vui lòng chụp ảnh mới.' : apiError.message || 'Không thể ghi nhận xác minh thực địa.');
    } finally {
      setIsSubmitting(false);
    }
  }

  if (!verdict) return <section className="mt-6 min-w-0 rounded-2xl border border-emerald-200 bg-emerald-50/50 p-4 sm:p-5"><h3 className="break-words text-xl font-bold text-slate-950">Chụp xác minh thực địa: {projectName}</h3><p className="mt-2 text-sm text-slate-600">Chọn kết quả phù hợp sau khi đối chiếu hiện trạng với hồ sơ dự án.</p><div className="mt-4 grid gap-3 sm:grid-cols-2"><button type="button" onClick={() => setVerdict('CONFIRMED')} className="rounded-xl border border-emerald-300 bg-white p-4 text-left"><b className="text-emerald-800">Dự án đúng với sự thật</b><span className="mt-2 block text-sm text-slate-600">Hiện trạng ngoài thực địa khớp với hồ sơ. Ảnh của bạn được lưu làm bằng chứng, dự án tiếp tục kích hoạt bình thường.</span></button><button type="button" onClick={() => setVerdict('CHALLENGE')} className="rounded-xl border border-amber-300 bg-white p-4 text-left"><b className="text-amber-800">Dự án sai sự thật</b><span className="mt-2 block text-sm text-slate-600">Có sai lệch giữa hồ sơ và hiện trường. Dự án sẽ tạm khóa để Ủy ban Điều hành xem xét.</span></button></div><button type="button" onClick={onClose} className="mt-4 text-sm font-bold text-slate-600">Huỷ</button></section>;

  return <><form onSubmit={event => void submit(event)} className="mt-6 min-w-0 rounded-2xl border border-amber-200 bg-amber-50/70 p-4 sm:p-5"><h3 className="break-words text-xl font-bold text-slate-950">{verdict === 'CONFIRMED' ? 'Xác nhận dự án đúng sự thật' : 'Gửi khiếu nại dự án'}</h3>{verdict === 'CONFIRMED' ? <textarea aria-label="Ghi chú xác nhận" value={note} onChange={event => setNote(event.target.value)} maxLength={500} placeholder="Ghi chú tuỳ chọn" className="mt-4 w-full rounded-xl border border-emerald-200 p-3 text-base sm:text-sm" /> : <div className="mt-4"><div className="mb-2 flex flex-col items-start gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-4"><label htmlFor="auditor-challenge-reason" className="text-sm font-bold text-slate-800">Lý do khiếu nại</label><span className="text-xs font-semibold text-slate-500">Tối thiểu 30 ký tự</span></div><textarea id="auditor-challenge-reason" aria-label="Lý do khiếu nại" aria-describedby="auditor-challenge-reason-count" value={reason} onChange={event => setReason(event.target.value)} minLength={30} maxLength={2000} required placeholder="Lý do khiếu nại (30–2000 ký tự)" className="w-full rounded-xl border border-amber-200 p-3 text-base sm:text-sm" /><p id="auditor-challenge-reason-count" className="mt-2 text-right text-xs text-slate-500">{reason.length}/2000 ký tự</p></div>}<div className="mt-4"><EvidenceCameraCapture maxPhotos={5} photos={photos} onChange={setPhotos} moduleLabel="xác minh thực địa" disabled={isSubmitting} /></div><div className="mt-4 flex flex-col gap-3 sm:flex-row"><button type="button" onClick={() => setVerdict(null)} disabled={isSubmitting} className="min-h-11 w-full rounded-xl border px-4 py-2 text-sm font-bold sm:w-auto">Quay lại</button><button type="submit" disabled={isSubmitting || !photos.length || (verdict === 'CHALLENGE' && reason.trim().length < 30)} className="min-h-11 w-full rounded-xl bg-[#0e7c6b] px-4 py-2 text-sm font-bold text-white sm:w-auto">{isSubmitting ? 'Đang gửi…' : 'Gửi xác minh'}</button></div></form>{message && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="alertdialog" aria-modal="true" aria-labelledby="auditor-verification-error-title" aria-describedby="auditor-verification-error-message"><div className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl"><h3 id="auditor-verification-error-title" className="text-base font-bold text-slate-900">Không thể gửi xác minh</h3><p id="auditor-verification-error-message" className="mt-2 text-sm text-slate-700">{message}</p><button type="button" onClick={() => setMessage('')} className="mt-5 w-full rounded-lg bg-[#0e7c6b] px-4 py-2 text-sm font-bold text-white">Đã hiểu</button></div></div>}{successMessage && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-labelledby="auditor-verification-success-title" aria-describedby="auditor-verification-success-message"><div className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl"><h3 id="auditor-verification-success-title" className="text-base font-bold text-emerald-800">Gửi xác minh thành công</h3><p id="auditor-verification-success-message" className="mt-2 text-sm text-slate-700">{successMessage}</p><button type="button" onClick={onClose} className="mt-5 w-full rounded-lg bg-[#0e7c6b] px-4 py-2 text-sm font-bold text-white">Đóng</button></div></div>}</>;
}
