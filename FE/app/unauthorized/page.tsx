'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';

type QuickNavigationItem = {
  href: string;
  label: string;
  description: string;
};

const quickNavigationItemList: QuickNavigationItem[] = [
  {
    href: '/',
    label: 'Trang chủ DCP',
    description: 'Quay về trang chính để tiếp tục hành trình quyên góp minh bạch.'
  },
  {
    href: '/donations',
    label: 'Danh sách chiến dịch',
    description: 'Xem các chiến dịch đang mở và quyên góp nhanh chóng.'
  },
  {
    href: '/login',
    label: 'Đăng nhập hệ thống',
    description: 'Đăng nhập lại bằng đúng tài khoản có quyền truy cập phù hợp.'
  }
];

/**
 * Hàm hiển thị trang lỗi 403 khi người dùng không có quyền truy cập.
 * Mục đích: thông báo rõ trạng thái phân quyền và dẫn người dùng về luồng an toàn.
 */
export default function UnauthorizedPage() {
  const router = useRouter();

  return (
    <main className="relative isolate flex min-h-screen items-center justify-center overflow-hidden bg-gradient-to-br from-[#e6f7f4] via-white to-[#f0fdfa] px-4 py-10 sm:px-6 lg:px-8">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,_rgba(14,124,107,0.15),_transparent_55%)]"
      />

      <section className="relative z-10 w-full max-w-4xl rounded-3xl border border-emerald-900/15 bg-white/95 p-6 shadow-xl backdrop-blur sm:p-10">
        <span className="inline-flex rounded-full border border-[#0E7C6B]/20 bg-[#0E7C6B]/10 px-4 py-1 text-xs font-semibold uppercase tracking-wide text-[#0E7C6B]">
          403 · Forbidden
        </span>

        <h1 className="mt-4 text-3xl font-extrabold text-slate-800 sm:text-4xl lg:text-5xl">
          Bạn chưa có quyền truy cập trang này
        </h1>

        <p className="mt-4 max-w-2xl text-sm leading-7 text-slate-600 sm:text-base">
          Tài khoản hiện tại chưa được cấp quyền phù hợp. Vui lòng quay lại bước trước đó hoặc trở về trang chủ để
          tiếp tục thao tác trong phạm vi cho phép.
        </p>

        <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
          <Link
            href="/"
            className="inline-flex items-center justify-center rounded-lg bg-[#0E7C6B] px-5 py-3 text-sm font-semibold text-white transition hover:bg-[#0c6c5d] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0E7C6B] focus-visible:ring-offset-2"
          >
            Về trang chủ
          </Link>

          <button
            type="button"
            onClick={() => router.back()}
            className="inline-flex items-center justify-center rounded-lg border border-[#0E7C6B]/30 bg-white px-5 py-3 text-sm font-semibold text-[#0E7C6B] transition hover:bg-[#ecfdf5] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0E7C6B] focus-visible:ring-offset-2"
          >
            Quay lại trang trước
          </button>
        </div>

        <div className="mt-8 rounded-2xl border border-emerald-900/15 bg-slate-50 p-4 sm:p-5">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Điểm điều hướng gợi ý</p>

          <div className="mt-3 grid gap-3 md:grid-cols-3">
            {quickNavigationItemList.map(navigationItem => (
              <Link
                key={navigationItem.href}
                href={navigationItem.href}
                className="group rounded-xl border border-emerald-900/15 bg-white p-4 transition hover:-translate-y-0.5 hover:border-[#1AAE97]/40 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0E7C6B] focus-visible:ring-offset-2"
              >
                <p className="text-sm font-bold text-slate-800 transition group-hover:text-[#0E7C6B]">
                  {navigationItem.label}
                </p>
                <p className="mt-2 text-xs leading-6 text-slate-500">{navigationItem.description}</p>
              </Link>
            ))}
          </div>

          <p className="mt-4 text-xs leading-6 text-slate-500">
            Nếu bạn cho rằng đây là lỗi phân quyền, hãy liên hệ quản trị hệ thống để được hỗ trợ nhanh chóng.
          </p>
        </div>
      </section>
    </main>
  );
}
