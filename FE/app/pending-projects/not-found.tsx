import Link from 'next/link';

/** Trang fallback an toàn khi hồ sơ niêm yết đã hết hạn hoặc không tồn tại. */
export default function PendingProjectsNotFound() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-16 text-center">
      <h1 className="text-2xl font-bold text-slate-900">Không tìm thấy dự án đang niêm yết</h1>
      <p className="mt-3 text-slate-600">Hồ sơ có thể đã được kích hoạt, chuyển sang tranh chấp hoặc không tồn tại.</p>
      <Link href="/pending-projects" className="mt-6 inline-block rounded-lg bg-teal-700 px-4 py-2 font-semibold text-white">Quay lại danh sách</Link>
    </main>
  );
}
