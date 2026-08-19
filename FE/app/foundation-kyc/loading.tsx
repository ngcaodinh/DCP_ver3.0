/** Hiển thị skeleton trong lúc Next.js tải shell cổng KYC public. */
export default function FoundationKycLoading(): React.ReactElement {
  return (
    <main className="min-h-screen bg-[#f4fbfa] px-4 py-5 sm:py-8">
      <div className="mx-auto max-w-7xl">
        <div className="mx-auto mb-8 h-10 w-full max-w-6xl animate-pulse rounded-xl bg-white/80" />
        <div className="mx-auto grid min-h-[720px] w-full max-w-6xl animate-pulse overflow-hidden rounded-[2rem] bg-white shadow-sm lg:grid-cols-[0.82fr_1.18fr]">
          <div className="bg-emerald-900/20" />
          <div className="p-10"><div className="h-8 w-2/3 rounded bg-slate-100" /><div className="mt-8 space-y-5">{[1, 2, 3, 4, 5, 6].map(item => <div key={item} className="h-12 rounded-xl bg-slate-100" />)}</div></div>
        </div>
      </div>
    </main>
  );
}
