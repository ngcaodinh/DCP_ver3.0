/** Skeleton tránh trang niêm yết công khai bị trống khi server đang tải dữ liệu. */
export default function PendingProjectsLoading() {
  return (
    <main className="mx-auto max-w-6xl px-4 py-10" aria-busy="true">
      <div className="h-8 w-64 animate-pulse rounded bg-slate-200" />
      <div className="mt-6 grid gap-4 md:grid-cols-2">
        {[0, 1, 2].map(index => <div key={index} className="h-48 animate-pulse rounded-xl bg-slate-100" />)}
      </div>
    </main>
  );
}
