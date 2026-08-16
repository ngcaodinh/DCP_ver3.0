import Link from 'next/link';
import type { ReactElement } from 'react';

/** Hiển thị trang 404 nhẹ riêng cho SBT detail, không kéo theo canvas toàn cục. */
export default function SbtTokenNotFound(): ReactElement {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-12">
      <section className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
        <h1 className="text-2xl font-bold text-slate-900">SBT không tồn tại</h1>
        <p className="mt-3 text-sm text-slate-600">Vui lòng kiểm tra lại token ID trong đường dẫn.</p>
        <Link
          href="/"
          className="mt-6 inline-flex min-h-11 items-center justify-center rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 transition-colors hover:border-emerald-600 hover:bg-emerald-50 hover:text-emerald-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
        >
          Về trang chủ
        </Link>
      </section>
    </main>
  );
}
