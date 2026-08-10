/** Skeleton card giữ kích thước tương đương SBT card để tránh layout shift khi tải gallery. */
export default function SbtCardSkeleton() {
  return (
    <div
      data-testid="sbt-card-skeleton"
      aria-hidden="true"
      className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm"
    >
      <div className="aspect-square animate-pulse bg-slate-200" />
      <div className="space-y-3 p-4">
        <div className="h-5 w-3/4 animate-pulse rounded bg-slate-200" />
        <div className="h-3 w-1/2 animate-pulse rounded bg-slate-100" />
        <div className="grid grid-cols-2 gap-3">
          <div className="h-10 animate-pulse rounded bg-slate-100" />
          <div className="h-10 animate-pulse rounded bg-slate-100" />
        </div>
      </div>
    </div>
  );
}
