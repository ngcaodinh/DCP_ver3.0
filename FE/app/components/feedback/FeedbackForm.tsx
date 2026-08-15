import { buildApiUrl } from '../../utils/apiClient';
import {
  FEEDBACK_MAX_ANONYMOUS_NAME_LENGTH,
  FEEDBACK_MAX_COMMENT_LENGTH
} from '../../constants/feedbackForm';
import StarRating from './StarRating';

interface FeedbackFormProps {
  projectId: string;
  submissionTicket: string;
}

/** Hiển thị form POST trực tiếp tới backend để dùng cùng một luồng khi bật hoặc tắt JavaScript. */
export default function FeedbackForm({ projectId, submissionTicket }: FeedbackFormProps): React.ReactElement {
  return (
    <form
      method="POST"
      action={buildApiUrl('/api/feedback/single')}
      className="space-y-5"
    >
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="submissionTicket" value={submissionTicket} />
      <input type="hidden" name="redirect" value="1" />

      <StarRating />

      <div className="space-y-2">
        <label htmlFor="feedback-comment" className="mb-2 block text-sm font-semibold text-slate-800">
          Nhận xét của bạn
        </label>
        <textarea
          id="feedback-comment"
          name="comment"
          required
          maxLength={FEEDBACK_MAX_COMMENT_LENGTH}
          inputMode="text"
          rows={4}
          aria-describedby="feedback-comment-help"
          className="w-full rounded-xl border border-slate-300 px-4 py-3 text-base text-slate-900 outline-none transition-colors focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100"
          placeholder="Chia sẻ trải nghiệm của bạn"
        />
        <p id="feedback-comment-help" className="text-xs leading-5 text-slate-500">
          Không nhập thông tin nhạy cảm hoặc thông tin liên hệ của người thụ hưởng.
        </p>
      </div>

      <div className="space-y-2">
        <label htmlFor="anonymous-name" className="mb-2 block text-sm font-semibold text-slate-800">
          Tên hiển thị <span className="font-normal text-slate-500">(không bắt buộc)</span>
        </label>
        <input
          id="anonymous-name"
          name="anonymousName"
          type="text"
          maxLength={FEEDBACK_MAX_ANONYMOUS_NAME_LENGTH}
          autoComplete="name"
          aria-describedby="anonymous-name-help"
          className="w-full rounded-xl border border-slate-300 px-4 py-3 text-base text-slate-900 outline-none transition-colors focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100"
          placeholder="Bạn có thể để trống"
        />
        <p id="anonymous-name-help" className="text-xs leading-5 text-slate-500">
          Tùy chọn. Tên hiển thị được bảo vệ trước khi lưu trữ.
        </p>
      </div>

      <input
        type="text"
        name="contactEmail"
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
        style={{ position: 'absolute', left: '-9999px' }}
      />

      <button
        type="submit"
        className="min-h-11 w-full rounded-xl bg-emerald-700 px-5 py-3 text-base font-semibold text-white transition-colors duration-200 hover:bg-emerald-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
      >
        Gửi phản hồi
      </button>
    </form>
  );
}
