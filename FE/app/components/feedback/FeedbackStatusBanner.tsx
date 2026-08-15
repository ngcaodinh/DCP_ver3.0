import Link from 'next/link';
import { getFeedbackStatusMessage } from '../../constants/feedbackForm';

interface FeedbackStatusBannerProps {
  projectId: string;
  status?: string;
}

/** Hiển thị banner từ danh sách trạng thái cho phép và thêm đường tải lại khi ticket hết hạn. */
export default function FeedbackStatusBanner({ projectId, status }: FeedbackStatusBannerProps): React.ReactElement | null {
  const message = getFeedbackStatusMessage(status);
  if (!message) return null;

  const isSuccess = status === 'success';
  const isNeutral = status === 'closed';
  const toneClassName = isSuccess
    ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
    : isNeutral
      ? 'border-slate-200 bg-slate-100 text-slate-800'
      : 'border-amber-200 bg-amber-50 text-amber-950';

  return (
    <div
      role={isSuccess ? 'status' : 'alert'}
      aria-live={isSuccess ? 'polite' : 'assertive'}
      className={`mb-6 rounded-xl border px-4 py-3 text-sm ${toneClassName}`}
    >
      <p>{message}</p>
      {status === 'expired' && (
        <Link href={`/feedback/${encodeURIComponent(projectId)}`} className="mt-2 inline-flex min-h-11 items-center font-semibold underline underline-offset-2">
          Tải lại trang
        </Link>
      )}
    </div>
  );
}
