'use client';

import React, { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import Link from 'next/link';
import { fetchDonationCertificate } from '../../certificates/services';
import type { DonationCertificatePublicResponse } from '../../certificates/types';

/**
 * Cấu hình giao diện và thông điệp trực quan tương ứng với từng trạng thái xác thực.
 */
const presentation = {
  VERIFIED: {
    label: 'Đã xác minh on-chain',
    badgeTone: 'bg-emerald-50 text-emerald-700 border-emerald-200 shadow-emerald-100/50',
    badgeDot: 'bg-emerald-500',
    headingTone: 'text-emerald-800',
    gradientBg: 'from-emerald-500/10 via-teal-500/5 to-transparent',
    borderGlow: 'border-emerald-500/30',
    statusDesc: 'Chứng nhận hợp lệ, toàn vẹn và đã được ghi nhận bất biến trên mạng lưới Blockchain.'
  },
  PENDING: {
    label: 'Đang chờ blockchain finality',
    badgeTone: 'bg-amber-50 text-amber-800 border-amber-200 shadow-amber-100/50',
    badgeDot: 'bg-amber-500 animate-ping',
    headingTone: 'text-amber-800',
    gradientBg: 'from-amber-500/10 via-yellow-500/5 to-transparent',
    borderGlow: 'border-amber-500/30',
    statusDesc: 'Giao dịch đang chờ xác nhận khối cuối cùng. Hệ thống đang tự động cập nhật liên tục.'
  },
  UNAVAILABLE: {
    label: 'Tạm thời chưa thể kiểm tra blockchain',
    badgeTone: 'bg-amber-50 text-amber-800 border-amber-200 shadow-amber-100/50',
    badgeDot: 'bg-amber-500',
    headingTone: 'text-amber-800',
    gradientBg: 'from-amber-500/10 via-yellow-500/5 to-transparent',
    borderGlow: 'border-amber-500/30',
    statusDesc: 'Kết nối mạng blockchain tạm thời quá tải hoặc chưa sẵn sàng. Đang tiến hành thử lại.'
  },
  REVOKED: {
    label: 'Chứng nhận đã bị thu hồi',
    badgeTone: 'bg-red-50 text-red-700 border-red-200 shadow-red-100/50',
    badgeDot: 'bg-red-500',
    headingTone: 'text-red-700',
    gradientBg: 'from-red-500/10 via-rose-500/5 to-transparent',
    borderGlow: 'border-red-500/30',
    statusDesc: 'Chứng nhận này đã bị thu hồi chính thức theo quy trình quản trị hoặc điều chỉnh giao dịch.'
  }
} as const;

/**
 * Định dạng thời gian theo chuẩn hiển thị tiếng Việt.
 * @param isoString Chuỗi thời gian ISO cần định dạng.
 */
function formatDateTime(isoString?: string | null): string {
  if (!isoString) return 'Chưa cập nhật';
  try {
    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) return isoString;
    return new Intl.DateTimeFormat('vi-VN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).format(date);
  } catch {
    return isoString;
  }
}

/**
 * Rút gọn chuỗi dài như địa chỉ ví hoặc hash để hiển thị tối ưu trên thiết bị di động.
 * @param text Chuỗi cần rút gọn.
 * @param startChars Số ký tự đầu giữ lại.
 * @param endChars Số ký tự cuối giữ lại.
 */
function truncateMiddle(text?: string | null, startChars = 10, endChars = 8): string {
  if (!text) return '';
  if (text.length <= startChars + endChars + 3) return text;
  return `${text.slice(0, startChars)}...${text.slice(-endChars)}`;
}

/**
 * Component hiển thị trang xác minh chứng nhận tri ân quyên góp chuẩn chỉnh, bảo mật on-chain.
 * Giữ nguyên toàn bộ logic fetch, polling, xử lý 404, liên kết PDF/Explorer và các selector kiểm thử.
 */
export default function DonationCertificateVerification({ certificateId }: { certificateId: string }): ReactElement {
  const [certificate, setCertificate] = useState<DonationCertificatePublicResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [showQrModal, setShowQrModal] = useState(false);

  /**
   * Tải thông tin chứng nhận từ backend API với cơ chế abort signal.
   */
  const load = useCallback(async (signal?: AbortSignal): Promise<void> => {
    setIsRefreshing(true);
    try {
      const data = await fetchDonationCertificate(certificateId, signal);
      setCertificate(data);
      setError(null);
    } catch (caught) {
      const status = (caught as { statusCode?: number }).statusCode;
      setError(status === 404 ? 'Không tìm thấy chứng nhận' : 'Không thể kiểm tra chứng nhận lúc này.');
    } finally {
      setIsRefreshing(false);
    }
  }, [certificateId]);

  // Hook khởi tạo fetch ban đầu khi component mount
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  // Hook polling tự động khi trạng thái là PENDING hoặc UNAVAILABLE
  useEffect(() => {
    if (!certificate || !['PENDING', 'UNAVAILABLE'].includes(certificate.verificationStatus)) return;
    const intervalMs = certificate.verificationStatus === 'PENDING' ? 2_000 : 5_000;
    const timer = window.setInterval(() => void load(), intervalMs);
    return () => window.clearInterval(timer);
  }, [certificate, load]);

  /**
   * Sao chép văn bản vào clipboard và hiển thị hiệu ứng thông báo thành công tức thì.
   */
  const handleCopy = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      window.setTimeout(() => setCopiedKey(null), 2500);
    } catch {
      // Bỏ qua lỗi sao chép không được cấp quyền
    }
  };

  // Màn hình hiển thị khi xảy ra lỗi tìm kiếm hoặc kết nối
  if (error) {
    return (
      <main className="min-h-screen bg-[#F8FAFB] text-[#0D1117] relative flex flex-col justify-between selection:bg-[#0E7C6B]/20">
        {/* Thanh Header Điều Hướng */}
        <header className="sticky top-0 z-30 border-b border-[#0E7C6B]/10 bg-[#F8FAFB]/90 backdrop-blur-md">
          <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
            <Link href="/" className="flex items-center gap-3 text-decoration-none group">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-[#0E7C6B] to-[#1AAE97] text-white shadow-md shadow-[#0E7C6B]/20 transition group-hover:scale-105">
                ❤
              </span>
              <div>
                <div className="text-base font-extrabold tracking-tight text-[#0D1117]">DCP</div>
                <div className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold">Decentralized Charity</div>
              </div>
            </Link>
            <Link
              href="/donations"
              className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3.5 py-1.5 text-xs font-semibold text-gray-700 shadow-sm transition hover:bg-gray-50 hover:border-gray-300"
            >
              <span>← Quay lại Chiến dịch</span>
            </Link>
          </div>
        </header>

        {/* Nội dung thông báo lỗi chuẩn UX */}
        <div className="flex-1 flex items-center justify-center px-4 py-16">
          <div className="w-full max-w-lg rounded-2xl border border-red-200/80 bg-white p-8 text-center shadow-xl shadow-red-500/5">
            <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-red-50 text-red-600 ring-8 ring-red-50/50">
              <svg className="h-8 w-8" fill="none" viewBox="0 0 24 24" strokeWidth={1.75} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
              </svg>
            </div>
            <h1 className="text-xl sm:text-2xl font-bold text-gray-900 tracking-tight">{error}</h1>
            <p className="mt-3 text-sm text-gray-600 leading-relaxed">
              Mã chứng nhận <span className="font-mono font-semibold text-gray-800 break-all">{certificateId}</span> không tồn tại trên hệ thống hoặc đã bị gỡ bỏ. Vui lòng kiểm tra lại liên kết hoặc quét lại mã QR trên chứng từ.
            </p>
            <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-3">
              <button
                type="button"
                onClick={() => void load()}
                className="w-full sm:w-auto inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-[#0E7C6B] to-[#1AAE97] px-5 py-2.5 text-sm font-semibold text-white shadow-md shadow-[#0E7C6B]/20 transition hover:opacity-95"
              >
                <svg className={`h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
                </svg>
                <span>Kiểm tra lại</span>
              </button>
              <Link
                href="/donations"
                className="w-full sm:w-auto inline-flex items-center justify-center rounded-xl border border-gray-300 bg-white px-5 py-2.5 text-sm font-semibold text-gray-700 transition hover:bg-gray-50"
              >
                Khám phá chiến dịch
              </Link>
            </div>
          </div>
        </div>

        {/* Chân trang tối giản */}
        <footer className="border-t border-gray-200/80 py-6 text-center text-xs text-gray-500">
          Decentralized Charity Platform (DCP) • Minh bạch quyên góp bằng công nghệ Blockchain
        </footer>
      </main>
    );
  }

  // Màn hình Skeleton Loading trong khi chờ dữ liệu API phản hồi
  if (!certificate) {
    return (
      <main className="min-h-screen bg-[#F8FAFB] text-[#0D1117] relative flex flex-col justify-between selection:bg-[#0E7C6B]/20">
        <header className="sticky top-0 z-30 border-b border-[#0E7C6B]/10 bg-[#F8FAFB]/90 backdrop-blur-md">
          <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
            <div className="flex items-center gap-3">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-[#0E7C6B] to-[#1AAE97] text-white shadow-md shadow-[#0E7C6B]/20">
                ❤
              </span>
              <div>
                <div className="text-base font-extrabold tracking-tight text-[#0D1117]">DCP</div>
                <div className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold">Decentralized Charity</div>
              </div>
            </div>
          </div>
        </header>

        <div className="flex-1 flex flex-col items-center justify-center px-4 py-16">
          <div className="w-full max-w-xl rounded-2xl border border-gray-200/80 bg-white p-8 text-center shadow-lg">
            <div className="relative mx-auto mb-6 flex h-20 w-20 items-center justify-center">
              <div className="absolute inset-0 animate-ping rounded-full bg-[#0E7C6B]/15" />
              <div className="relative flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-[#0E7C6B] to-[#1AAE97] text-white shadow-lg shadow-[#0E7C6B]/25">
                <svg className="h-7 w-7 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                </svg>
              </div>
            </div>
            <h2 className="text-lg font-bold text-gray-900">Đang kiểm tra chứng nhận…</h2>
            <p className="mt-2 text-sm text-gray-500">Đang đồng bộ dữ liệu giao dịch và truy vấn trạng thái finality từ Smart Contract...</p>
            <div className="mt-6 mx-auto h-2 w-48 overflow-hidden rounded-full bg-gray-100">
              <div className="h-full w-1/2 animate-[pulse_1s_ease-in-out_infinite] rounded-full bg-gradient-to-r from-[#0E7C6B] to-[#1AAE97]" />
            </div>
          </div>
        </div>

        <footer className="border-t border-gray-200/80 py-6 text-center text-xs text-gray-500">
          Decentralized Charity Platform (DCP) • Minh bạch quyên góp bằng công nghệ Blockchain
        </footer>
      </main>
    );
  }

  const status = presentation[certificate.verificationStatus];
  const amountFormatted = certificate.certificate
    ? BigInt(certificate.certificate.amountRaw).toLocaleString('vi-VN')
    : '0';
  const vndEquivalentFormatted = certificate.certificate?.vndEquivalent
    ? Number(certificate.certificate.vndEquivalent).toLocaleString('vi-VN')
    : amountFormatted;

  return (
    <main className="min-h-screen bg-[#F8FAFB] text-[#0D1117] relative flex flex-col justify-between selection:bg-[#0E7C6B]/20">
      {/* Background Decor Gradients */}
      <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
        <div className="absolute -top-40 left-1/2 -translate-x-1/2 h-[500px] w-[800px] rounded-full bg-gradient-to-b from-[#0E7C6B]/10 via-[#1AAE97]/5 to-transparent blur-3xl" />
        <div className="absolute top-[40%] right-[-10%] h-[400px] w-[400px] rounded-full bg-amber-500/5 blur-3xl" />
      </div>

      {/* Header Điều Hướng Toàn Cục */}
      <header className="sticky top-0 z-30 border-b border-[#0E7C6B]/10 bg-[#F8FAFB]/90 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
          <Link href="/" className="flex items-center gap-3 text-decoration-none group">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-[#0E7C6B] to-[#1AAE97] text-white shadow-md shadow-[#0E7C6B]/20 transition group-hover:scale-105">
              ❤
            </span>
            <div>
              <div className="text-base font-extrabold tracking-tight text-[#0D1117]">DCP</div>
              <div className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold">Decentralized Charity</div>
            </div>
          </Link>

          <div className="flex items-center gap-3">
            <Link
              href="/donations"
              className="hidden sm:inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold text-gray-600 transition hover:bg-gray-100 hover:text-gray-900"
            >
              <span>Chiến dịch</span>
            </Link>
            <Link
              href="/impact-gallery"
              className="hidden sm:inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold text-gray-600 transition hover:bg-gray-100 hover:text-gray-900"
            >
              <span>Impact Gallery</span>
            </Link>
            <button
              type="button"
              onClick={() => void load()}
              disabled={isRefreshing}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3.5 py-1.5 text-xs font-semibold text-gray-700 shadow-sm transition hover:bg-gray-50 hover:border-gray-300 disabled:opacity-60"
            >
              <svg className={`h-3.5 w-3.5 text-[#0E7C6B] ${isRefreshing ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
              </svg>
              <span>Kiểm tra lại</span>
            </button>
          </div>
        </div>
      </header>

      {/* Thân Trang Chính */}
      <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 lg:py-12">
        {/* Tiêu Đề Trang & Huy Hiệu Trạng Thái Xác Thực */}
        <div className="text-center space-y-3 mb-8 sm:mb-10">
          <div className="inline-flex items-center gap-2 rounded-full border border-[#0E7C6B]/20 bg-[#0E7C6B]/5 px-3.5 py-1 text-xs font-semibold text-[#0E7C6B]">
            <span className="flex h-2 w-2 rounded-full bg-[#1AAE97]" />
            <span>Cổng Tra Cứu & Xác Thực Minh Bạch On-Chain</span>
          </div>

          <h1 className="text-2xl sm:text-4xl font-extrabold tracking-tight text-[#0D1117]">
            Xác minh Chứng nhận Tri ân
          </h1>

          <p className="mx-auto max-w-2xl text-sm sm:text-base text-gray-600">
            Hệ thống đối soát mật mã độc lập giữa dữ liệu chứng nhận và Smart Contract trên Blockchain Polygon.
          </p>

          <div className="pt-2 flex flex-wrap items-center justify-center gap-3">
            <div className={`inline-flex items-center gap-2.5 rounded-full border px-4 py-1.5 text-sm font-semibold shadow-sm transition ${status.badgeTone}`}>
              <span className={`h-2.5 w-2.5 rounded-full ${status.badgeDot}`} />
              <span>{status.label}</span>
            </div>

            {certificate.chain?.networkName && (
              <div className="inline-flex items-center gap-1.5 rounded-full border border-gray-200 bg-white px-3 py-1 text-xs font-medium text-gray-600 shadow-sm">
                <span className="text-[11px] text-gray-400">Mạng:</span>
                <span className="font-semibold text-gray-800">{certificate.chain.networkName}</span>
              </div>
            )}
          </div>
        </div>

        {/* KHỐI CHỨNG NHẬN TRI ÂN NGHỆ THUẬT (Visual Certificate Card) */}
        {certificate.certificate && (
          <section className="relative overflow-hidden rounded-3xl border-2 border-[#0E7C6B]/25 bg-gradient-to-b from-white via-white to-[#F0FDF4]/30 p-6 sm:p-10 shadow-2xl shadow-[#0E7C6B]/10">
            {/* Họa tiết trang trí góc chứng nhận */}
            <div className="absolute top-0 left-0 h-16 w-16 border-t-4 border-l-4 border-[#0E7C6B]/40 rounded-tl-3xl pointer-events-none" />
            <div className="absolute top-0 right-0 h-16 w-16 border-t-4 border-r-4 border-[#0E7C6B]/40 rounded-tr-3xl pointer-events-none" />
            <div className="absolute bottom-0 left-0 h-16 w-16 border-b-4 border-l-4 border-[#0E7C6B]/40 rounded-bl-3xl pointer-events-none" />
            <div className="absolute bottom-0 right-0 h-16 w-16 border-b-4 border-r-4 border-[#0E7C6B]/40 rounded-br-3xl pointer-events-none" />

            {/* Dải Huy Hiệu & Mã Chứng Nhận */}
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 border-b border-[#0E7C6B]/10 pb-6">
              <div className="flex items-center gap-3">
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-[#0E7C6B] to-[#1AAE97] text-white shadow-lg shadow-[#0E7C6B]/25">
                  <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" strokeWidth={1.75} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 18.75h-9m9 0a3 3 0 013 3h-15a3 3 0 013-3m9 0v-3.375c0-.621-.503-1.125-1.125-1.125h-.871M7.5 18.75v-3.375c0-.621.504-1.125 1.125-1.125h.872m5.007 0H9.497m5.007 0a7.454 7.454 0 01-.982-3.172M9.497 14.25a7.454 7.454 0 00.981-3.172M5.25 4.236c-.982.143-1.954.317-2.916.52A6.003 6.003 0 007.73 9.728M5.25 4.236V4.5c0 2.108.966 3.99 2.48 5.228M5.25 4.236V2.721C7.456 2.41 9.71 2.25 12 2.25c2.291 0 4.545.16 6.75.47v1.516M7.73 9.728a6.726 6.726 0 002.767 1.35m0 0a6.726 6.726 0 002.767-1.35m0 0a6.003 6.003 0 005.396-4.972c-.962-.203-1.934-.377-2.916-.52" />
                  </svg>
                </div>
                <div>
                  <h2 className="text-xs font-bold uppercase tracking-[0.2em] text-[#0E7C6B]">
                    Chứng Thư Tri Ân Tấm Lòng Vàng
                  </h2>
                  <div className="text-sm font-semibold text-gray-700">
                    Decentralized Charity Certificate of Honor
                  </div>
                </div>
              </div>

              {/* Mã Chứng Nhận & Nút Copy */}
              <div className="flex items-center gap-2 rounded-xl bg-gray-50 border border-gray-200/80 px-3 py-1.5 text-xs">
                <span className="text-gray-400 font-medium">Mã ID:</span>
                <span className="font-mono font-semibold text-gray-800 break-all">{certificate.certificateId}</span>
                <button
                  type="button"
                  onClick={() => handleCopy(certificate.certificateId, 'certId')}
                  className="text-gray-400 hover:text-[#0E7C6B] transition p-1"
                  title="Sao chép mã chứng nhận"
                  aria-label="Sao chép mã chứng nhận"
                >
                  {copiedKey === 'certId' ? (
                    <span className="text-emerald-600 text-[11px] font-semibold">✓ Đã chép</span>
                  ) : (
                    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.849A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.599m9.332 0c.07.3.107.61.107.926V5.25m-9.332 0a2.25 2.25 0 00-.107.926v1.5a2.25 2.25 0 002.25 2.25h6a2.25 2.25 0 002.25-2.25v-1.5c0-.316-.037-.626-.107-.926m-9.332 0h9.332m-9.332 0A2.25 2.25 0 005.25 6v12a2.25 2.25 0 002.25 2.25h9a2.25 2.25 0 002.25-2.25V6a2.25 2.25 0 00-2.25-2.25h-1.5" />
                    </svg>
                  )}
                </button>
              </div>
            </div>

            {/* Nội Dung Vinh Danh Chính (Bảo tồn đoạn text kiểm thử nguyên vẹn) */}
            <div className="my-8 text-center sm:my-10 space-y-4">
              <p className="text-xs uppercase tracking-[0.25em] text-gray-500 font-semibold">
                Trân trọng ghi nhận và tri ân tấm lòng vàng của nhà hảo tâm
              </p>

              {/* Tên Người Quyên Góp */}
              <div className="text-3xl sm:text-5xl font-extrabold tracking-tight text-[#0D1117]">
                {certificate.certificate.donorName}
              </div>

              {/* Đoạn văn bản chính thức xác nhận đóng góp (Chứa strong name và thông tin theo cấu trúc chuẩn) */}
              <div className="mx-auto max-w-3xl rounded-2xl bg-[#0E7C6B]/5 border border-[#0E7C6B]/15 p-6 text-base sm:text-lg leading-relaxed text-gray-800">
                <p>
                  <strong>{certificate.certificate.donorName}</strong> đã đóng góp{' '}
                  <span className="font-bold text-[#0E7C6B]">{amountFormatted} DCT</span> cho “
                  <span className="font-bold text-[#0D1117]">{certificate.certificate.projectName}</span>”.
                </p>
                {certificate.certificate.organizationName && (
                  <p className="mt-2 text-xs sm:text-sm text-gray-600 font-medium">
                    Đơn vị tiếp nhận và thực hiện: <span className="font-semibold text-gray-900">{certificate.certificate.organizationName}</span>
                  </p>
                )}
              </div>

              {/* Địa Chỉ Ví Quyên Góp */}
              <div className="pt-2 flex flex-col sm:flex-row items-center justify-center gap-2">
                <span className="text-xs font-semibold text-gray-500">Địa chỉ ví nhà hảo tâm:</span>
                <div className="inline-flex items-center gap-2 rounded-xl bg-white border border-gray-200 px-3.5 py-1.5 shadow-sm">
                  <svg className="h-4 w-4 text-[#0E7C6B]" fill="none" viewBox="0 0 24 24" strokeWidth={1.75} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a2.25 2.25 0 00-2.25-2.25H15a3 3 0 11-6 0H5.25A2.25 2.25 0 003 12m18 0v6a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 18v-6m18 0V9M3 12V9m18 0a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 9m18 0V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v3" />
                  </svg>
                  <p className="font-mono text-xs sm:text-sm text-gray-800 break-all select-all">
                    {certificate.certificate.donorAddress}
                  </p>
                  <button
                    type="button"
                    onClick={() => handleCopy(certificate.certificate!.donorAddress, 'donorAddr')}
                    className="text-gray-400 hover:text-[#0E7C6B] transition p-1"
                    title="Sao chép địa chỉ ví"
                    aria-label="Sao chép địa chỉ ví"
                  >
                    {copiedKey === 'donorAddr' ? (
                      <span className="text-emerald-600 text-[10px] font-bold">✓ Đã chép</span>
                    ) : (
                      <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.849A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.599m9.332 0c.07.3.107.61.107.926V5.25m-9.332 0a2.25 2.25 0 00-.107.926v1.5a2.25 2.25 0 002.25 2.25h6a2.25 2.25 0 002.25-2.25v-1.5c0-.316-.037-.626-.107-.926m-9.332 0h9.332m-9.332 0A2.25 2.25 0 005.25 6v12a2.25 2.25 0 002.25 2.25h9a2.25 2.25 0 002.25-2.25V6a2.25 2.25 0 00-2.25-2.25h-1.5" />
                      </svg>
                    )}
                  </button>
                </div>
              </div>
            </div>

            {/* Lưới Thông Tin Chi Tiết Của Chứng Nhận */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 border-t border-[#0E7C6B]/10 pt-6">
              <div className="rounded-xl bg-white p-4 border border-gray-100 shadow-sm">
                <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider">Số tiền quyên góp</div>
                <div className="mt-1 text-lg font-bold text-[#0E7C6B]">{amountFormatted} DCT</div>
                <div className="text-xs text-gray-500 font-medium">≈ {vndEquivalentFormatted} VNĐ</div>
              </div>

              <div className="rounded-xl bg-white p-4 border border-gray-100 shadow-sm">
                <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider">Thời điểm đóng góp</div>
                <div className="mt-1 text-sm font-bold text-gray-900">{formatDateTime(certificate.certificate.donatedAt)}</div>
                <div className="text-xs text-gray-500">Ghi nhận tức thì</div>
              </div>

              <div className="rounded-xl bg-white p-4 border border-gray-100 shadow-sm">
                <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider">Thời điểm cấp chứng nhận</div>
                <div className="mt-1 text-sm font-bold text-gray-900">{formatDateTime(certificate.issuedAt)}</div>
                <div className="text-xs text-gray-500">On-Chain Finalized</div>
              </div>

              <div className="rounded-xl bg-white p-4 border border-gray-100 shadow-sm">
                <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider">Chính sách định giá</div>
                <div className="mt-1 text-xs font-bold text-gray-900 font-mono">1 DCT = 1 VNĐ</div>
                <div className="text-xs text-emerald-600 font-medium">Phi lợi nhuận 100%</div>
              </div>
            </div>

            {/* Con Dấu Mộc Xác Thực Kỹ Thuật Số */}
            <div className="mt-8 flex flex-col sm:flex-row items-center justify-between gap-4 rounded-2xl bg-gradient-to-r from-gray-50 to-white p-4 border border-gray-200">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-100 text-emerald-700">
                  <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
                  </svg>
                </div>
                <div>
                  <div className="text-xs font-bold text-gray-900">Bảo Chứng Toàn Vẹn Bằng Mật Mã Học</div>
                  <div className="text-[11px] text-gray-500">Mã băm và bản ghi giao dịch không thể bị chỉnh sửa hay làm giả mạo</div>
                </div>
              </div>

              <div className="text-right">
                <div className="text-[10px] uppercase font-semibold text-gray-400">Kiểm tra lần cuối</div>
                <div className="text-xs font-semibold text-gray-700">{formatDateTime(certificate.verificationCheckedAt)}</div>
              </div>
            </div>
          </section>
        )}

        {/* KHỐI BẰNG CHỨNG ON-CHAIN & BLOCKCHAIN EXPLORER */}
        {certificate.chain && (
          <section className="mt-8 rounded-3xl border border-gray-200/90 bg-white p-6 sm:p-8 shadow-lg shadow-gray-200/50">
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 border-b border-gray-100 pb-5">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-50 text-[#0E7C6B]">
                  <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.75} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m13.35-.622l1.757-1.757a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244" />
                  </svg>
                </div>
                <div>
                  <h3 className="text-base font-bold text-gray-900">Bằng Chứng Giao Dịch Trên Blockchain</h3>
                  <p className="text-xs text-gray-500">Xác thực độc lập qua Blockchain Explorer của mạng lưới {certificate.chain.networkName}</p>
                </div>
              </div>

              {/* Nút Mở Explorer (Bảo tồn chính xác role link và name text theo kiểm thử) */}
              <a
                href={certificate.chain.explorerUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-2 rounded-xl bg-[#0E7C6B]/10 hover:bg-[#0E7C6B]/20 text-[#0E7C6B] px-4 py-2 text-xs font-semibold transition"
              >
                <span>Mở blockchain explorer</span>
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
                </svg>
              </a>
            </div>

            {/* Chi Tiết Giao Dịch & Transaction Hash */}
            <div className="mt-6 space-y-4">
              <div>
                <div className="text-xs font-semibold text-gray-500 mb-1.5 flex items-center justify-between">
                  <span>Mã băm giao dịch (Transaction Hash)</span>
                  <button
                    type="button"
                    onClick={() => handleCopy(certificate.chain!.transactionHash, 'txHash')}
                    className="text-[#0E7C6B] hover:underline text-[11px] font-semibold flex items-center gap-1"
                  >
                    {copiedKey === 'txHash' ? '✓ Đã sao chép' : 'Sao chép hash'}
                  </button>
                </div>
                <div className="rounded-xl bg-gray-50 border border-gray-200/90 p-3.5">
                  <p className="font-mono text-xs sm:text-sm text-gray-800 break-all select-all font-medium">
                    {certificate.chain.transactionHash}
                  </p>
                </div>
              </div>

              {/* Lưới Thông Số Kỹ Thuật Blockchain */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 pt-2">
                <div className="rounded-xl border border-gray-100 bg-gray-50/70 p-3.5">
                  <div className="text-[11px] font-medium text-gray-500">Khối xác thực (Block)</div>
                  <div className="mt-1 font-mono text-sm font-bold text-gray-900">
                    #{certificate.chain.blockNumber.toLocaleString('vi-VN')}
                  </div>
                  <div className="text-[10px] text-emerald-600 font-semibold mt-0.5">
                    {certificate.currentConfirmations ? `${certificate.currentConfirmations} xác nhận khối` : 'Đã xác nhận'}
                  </div>
                </div>

                <div className="rounded-xl border border-gray-100 bg-gray-50/70 p-3.5">
                  <div className="text-[11px] font-medium text-gray-500">Địa chỉ Smart Contract</div>
                  <div className="mt-1 font-mono text-xs font-semibold text-gray-900 break-all">
                    {truncateMiddle(certificate.chain.contractAddress, 10, 8)}
                  </div>
                  <button
                    type="button"
                    onClick={() => handleCopy(certificate.chain!.contractAddress, 'contractAddr')}
                    className="text-[10px] text-[#0E7C6B] hover:underline font-semibold mt-0.5 block"
                  >
                    {copiedKey === 'contractAddr' ? '✓ Đã chép' : 'Sao chép địa chỉ'}
                  </button>
                </div>

                <div className="rounded-xl border border-gray-100 bg-gray-50/70 p-3.5">
                  <div className="text-[11px] font-medium text-gray-500">Cơ chế bảo chứng Finality</div>
                  <div className="mt-1 font-mono text-xs font-bold text-gray-900">
                    {certificate.chain.finalityMode}
                  </div>
                  <div className="text-[10px] text-gray-500 mt-0.5">Log Index: #{certificate.chain.logIndex}</div>
                </div>
              </div>
            </div>
          </section>
        )}

        {/* KHỐI NÚT HÀNH ĐỘNG CHÍNH (Action Toolbar) */}
        <div className="mt-8 flex flex-wrap items-center justify-between gap-4 rounded-2xl bg-white border border-gray-200 p-4 sm:p-6 shadow-sm">
          <div className="flex flex-wrap items-center gap-3">
            {/* Nút Tải PDF / Tải bản đánh dấu đã thu hồi (Bảo tồn chính xác role link và name text) */}
            {certificate.pdfUrl && (
              <a
                href={certificate.pdfUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-[#0E7C6B] to-[#1AAE97] px-5 py-2.5 text-sm font-semibold text-white shadow-md shadow-[#0E7C6B]/20 transition hover:opacity-95"
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
                </svg>
                <span>
                  {certificate.verificationStatus === 'REVOKED' ? 'Tải bản đánh dấu đã thu hồi' : 'Tải PDF'}
                </span>
              </a>
            )}

            {/* Nút Mở QR Modal để Quét Trên Thiết Bị Di Động */}
            <button
              type="button"
              onClick={() => setShowQrModal(true)}
              className="inline-flex items-center gap-2 rounded-xl border border-gray-300 bg-white px-4 py-2.5 text-sm font-semibold text-gray-700 shadow-sm transition hover:bg-gray-50"
            >
              <svg className="h-4 w-4 text-gray-600" fill="none" viewBox="0 0 24 24" strokeWidth={1.75} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 4.875c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5A1.125 1.125 0 013.75 9.375v-4.5zM3.75 14.625c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5a1.125 1.125 0 01-1.125-1.125v-4.5zM14.625 3.75c-.621 0-1.125.504-1.125 1.125v4.5c0 .621.504 1.125 1.125 1.125h4.5c.621 0 1.125-.504 1.125-1.125v-4.5c0-.621-.504-1.125-1.125-1.125h-4.5zM14.625 14.625h2.25v2.25h-2.25v-2.25zM19.125 14.625h1.125v1.125h-1.125v-1.125zM16.875 16.875h2.25v2.25h-2.25v-2.25z" />
              </svg>
              <span>Quét mã QR</span>
            </button>

            {/* Nút Sao Chép Liên Kết Trang Xác Minh */}
            <button
              type="button"
              onClick={() => handleCopy(certificate.verificationUrl || window.location.href, 'shareUrl')}
              className="inline-flex items-center gap-2 rounded-xl border border-gray-300 bg-white px-4 py-2.5 text-sm font-semibold text-gray-700 shadow-sm transition hover:bg-gray-50"
            >
              <svg className="h-4 w-4 text-gray-600" fill="none" viewBox="0 0 24 24" strokeWidth={1.75} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M7.217 10.907a2.25 2.25 0 100 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186l9.566-5.314m-9.566 7.5l9.566 5.314m0 0a2.25 2.25 0 103.935 2.186 2.25 2.25 0 00-3.935-2.186zm0-12.814a2.25 2.25 0 103.933-2.185 2.25 2.25 0 00-3.933 2.185z" />
              </svg>
              <span>{copiedKey === 'shareUrl' ? '✓ Đã chép link' : 'Chia sẻ'}</span>
            </button>
          </div>

          <div className="flex items-center gap-3">
            {/* Nút Kiểm Tra Lại (Bảo tồn nguyên vẹn button selector) */}
            <button
              type="button"
              onClick={() => void load()}
              disabled={isRefreshing}
              className="inline-flex items-center gap-2 rounded-xl border border-gray-200 bg-gray-50 hover:bg-gray-100 px-4 py-2.5 text-sm font-semibold text-gray-800 transition disabled:opacity-50"
            >
              <svg className={`h-4 w-4 text-[#0E7C6B] ${isRefreshing ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
              </svg>
              <span>Kiểm tra lại</span>
            </button>
          </div>
        </div>

        {/* 3 Trụ Cột Cam Kết Minh Bạch Của Nền Tảng */}
        <div className="mt-12 grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="rounded-2xl border border-gray-200/80 bg-white p-6 shadow-sm">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-50 text-[#0E7C6B] mb-4">
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.75} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
              </svg>
            </div>
            <h4 className="text-sm font-bold text-gray-900">Bất Biến & Chống Gian Lận</h4>
            <p className="mt-1.5 text-xs text-gray-600 leading-relaxed">
              Mỗi chứng nhận được neo chặt vào block hash và log index, không một cá nhân hay tổ chức nào có thể thay đổi sau khi xác nhận.
            </p>
          </div>

          <div className="rounded-2xl border border-gray-200/80 bg-white p-6 shadow-sm">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-teal-50 text-[#1AAE97] mb-4">
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.75} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </div>
            <h4 className="text-sm font-bold text-gray-900">Minh Bạch Công Khai 100%</h4>
            <p className="mt-1.5 text-xs text-gray-600 leading-relaxed">
              Bất kỳ ai tại bất kỳ thời điểm nào cũng có thể tra cứu, đối soát chứng từ độc lập qua Polygonscan mà không cần đăng nhập.
            </p>
          </div>

          <div className="rounded-2xl border border-gray-200/80 bg-white p-6 shadow-sm">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-50 text-amber-600 mb-4">
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.75} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v12m-3-2.818l.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-.725 0-1.45-.22-2.003-.659-1.106-.879-1.106-2.303 0-3.182s2.9-.879 4.006 0l.415.33M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <h4 className="text-sm font-bold text-gray-900">Bảo Toàn Giá Trị Đóng Góp</h4>
            <p className="mt-1.5 text-xs text-gray-600 leading-relaxed">
              Quy đổi tỉ lệ 1 token = 1 VNĐ minh bạch, hỗ trợ giải ngân có giám sát cộng đồng và kiểm toán on-chain đa bên.
            </p>
          </div>
        </div>
      </div>

      {/* Modal Hiển Thị Mã QR Di Động */}
      {showQrModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-3xl bg-white p-6 text-center shadow-2xl animate-[scale-up_0.2s_ease-out]">
            <div className="flex items-center justify-between border-b border-gray-100 pb-3 mb-4">
              <h3 className="text-sm font-bold text-gray-900">Mã QR Xác Minh</h3>
              <button
                type="button"
                onClick={() => setShowQrModal(false)}
                className="rounded-full p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
                aria-label="Đóng modal"
              >
                ✕
              </button>
            </div>

            <div className="mx-auto flex h-52 w-52 items-center justify-center rounded-2xl border-2 border-dashed border-[#0E7C6B]/30 bg-[#0E7C6B]/5 p-3">
              {/* Ảnh QR Code tạo động qua endpoint chuẩn để quét trực tiếp */}
              <img
                src={`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(
                  certificate.verificationUrl || typeof window !== 'undefined' ? window.location.href : ''
                )}`}
                alt="QR Code Xác minh chứng nhận"
                className="h-full w-full rounded-xl object-contain shadow-inner"
              />
            </div>

            <p className="mt-4 text-xs text-gray-600 font-medium">
              Sử dụng camera điện thoại hoặc ứng dụng quét mã QR để mở trang xác thực chứng nhận này.
            </p>

            <div className="mt-5">
              <button
                type="button"
                onClick={() => setShowQrModal(false)}
                className="w-full rounded-xl bg-gray-100 hover:bg-gray-200 py-2.5 text-xs font-semibold text-gray-700 transition"
              >
                Đóng
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Chân Trang Chuẩn Nhất Quán */}
      <footer className="border-t border-gray-200/80 bg-white/50 backdrop-blur-sm py-8 text-center text-xs text-gray-500">
        <div className="mx-auto max-w-5xl px-4 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <span className="flex h-5 w-5 items-center justify-center rounded-md bg-[#0E7C6B] text-white text-[10px]">
              ❤
            </span>
            <span className="font-bold text-gray-700">DCP — Decentralized Charity Platform</span>
          </div>
          <div>Bảo mật ERC-4337 & Giám sát on-chain minh bạch • Việt Nam</div>
        </div>
      </footer>
    </main>
  );
}
