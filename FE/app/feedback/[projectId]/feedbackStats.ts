import { buildServerApiUrl } from '../../utils/serverApiClient';
import type { FeedbackStatsSummaryData } from '../../components/feedback/FeedbackStatsSummary';

/** Kiểm tra object động có phải record để đọc response API mà không dùng any. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Lấy thống kê với timeout riêng để lỗi hoặc độ trễ của F3 không ảnh hưởng form feedback. */
export async function fetchFeedbackStats(
  projectId: string,
  clientIdentityHeaders: Record<string, string> = {}
): Promise<FeedbackStatsSummaryData | null> {
  const abortController = new AbortController();
  const timeoutHandle = setTimeout(() => abortController.abort(), 2_000);
  try {
    const response = await fetch(buildServerApiUrl(`/api/feedback/stats/${encodeURIComponent(projectId)}`), {
      cache: 'no-store',
      headers: clientIdentityHeaders,
      signal: abortController.signal
    });
    if (!response.ok) return null;
    const body = await response.json() as unknown;
    if (!isRecord(body) || body.success !== true || !isRecord(body.data)) return null;
    const { avgRating, totalCount } = body.data;
    if (
      (avgRating !== null && (
        typeof avgRating !== 'number' ||
        !Number.isFinite(avgRating) ||
        avgRating < 1 ||
        avgRating > 5
      )) ||
      typeof totalCount !== 'number' ||
      !Number.isInteger(totalCount) ||
      totalCount < 0
    ) {
      return null;
    }
    return { avgRating, totalCount };
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutHandle);
  }
}
