/**
 * Giữ loading boundary để Link prefetch chỉ lấy shell, không render page và tiêu ticket một lần.
 * Đồng thời hiển thị skeleton nhẹ trong lúc lấy context project và thống kê feedback.
 */
export default function FeedbackLoading(): React.ReactElement {
  return (
    <main className="min-h-screen bg-slate-50 px-4 py-8 sm:py-12" aria-busy="true" aria-live="polite">
      <div className="mx-auto w-full max-w-2xl">
        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-8">
          <p className="text-sm font-semibold text-slate-400">DCP · Phản hồi cộng đồng</p>
          <div className="mt-3 h-9 w-3/4 animate-pulse rounded bg-slate-200" />
          <div className="mt-6 space-y-4">
            <div className="h-4 w-full animate-pulse rounded bg-slate-100" />
            <div className="h-24 w-full animate-pulse rounded-xl bg-slate-100" />
            <div className="h-11 w-full animate-pulse rounded-xl bg-slate-100" />
          </div>
          <p className="sr-only">Đang tải biểu mẫu phản hồi</p>
        </section>
      </div>
    </main>
  );
}
