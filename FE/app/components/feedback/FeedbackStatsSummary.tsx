export interface FeedbackStatsSummaryData {
  avgRating: number | null;
  totalCount: number;
}

interface FeedbackStatsSummaryProps {
  stats: FeedbackStatsSummaryData | null;
}

/** Hiển thị dòng thống kê tùy chọn và bỏ qua payload null hoặc sai cấu trúc từ API F3. */
export default function FeedbackStatsSummary({ stats }: FeedbackStatsSummaryProps): React.ReactElement | null {
  if (
    !stats ||
    (stats.avgRating !== null && (!Number.isFinite(stats.avgRating) || stats.avgRating < 1 || stats.avgRating > 5)) ||
    stats.avgRating === null ||
    !Number.isInteger(stats.totalCount) ||
    stats.totalCount < 1
  ) {
    return null;
  }

  return (
    <p className="mb-6 text-sm font-medium text-slate-600">
      {stats.avgRating}★ · {stats.totalCount} phản hồi
    </p>
  );
}
