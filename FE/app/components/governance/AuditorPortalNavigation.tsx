'use client';

import Link from 'next/link';
import { type ReactElement, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

export type AuditorPortalTab = 'CHALLENGES' | 'FIELD_REPORTS' | 'STAKE' | 'EARNINGS';

interface AuditorNavigationItem {
  id: AuditorPortalTab;
  label: string;
  tabId: string;
  panelId: string;
}

interface AuditorPortalNavigationProps {
  activeTab: AuditorPortalTab;
  onTabChange: (tab: AuditorPortalTab) => void;
  onLogout: () => void;
}

const auditorNavigationItemList: AuditorNavigationItem[] = [
  { id: 'CHALLENGES', label: 'Khiếu nại niêm yết', tabId: 'auditor-challenges-tab', panelId: 'auditor-challenges-panel' },
  { id: 'FIELD_REPORTS', label: 'Biên bản hiện trường', tabId: 'auditor-field-reports-tab', panelId: 'auditor-field-reports-panel' },
  { id: 'STAKE', label: 'Cọc & Tài khoản nhận tiền', tabId: 'auditor-stake-tab', panelId: 'auditor-stake-panel' },
  { id: 'EARNINGS', label: 'Thù lao & Phạt', tabId: 'auditor-earnings-tab', panelId: 'auditor-earnings-panel' },
];

/** Hiển thị header nghiệp vụ riêng cho Auditor và điều hướng giữa bốn khu vực nghiệp vụ. */
export default function AuditorPortalNavigation({ activeTab, onTabChange, onLogout }: AuditorPortalNavigationProps): ReactElement {
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  useEffect(() => {
    if (!isMobileMenuOpen) return undefined;

    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    /** Đóng drawer khi người dùng nhấn Escape để thao tác bàn phím luôn nhất quán. */
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setIsMobileMenuOpen(false);
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousBodyOverflow;
    };
  }, [isMobileMenuOpen]);

  /** Chuyển nghiệp vụ từ menu mobile rồi đóng drawer để người dùng thấy nội dung vừa chọn. */
  const handleMobileTabChange = (tab: AuditorPortalTab): void => {
    onTabChange(tab);
    setIsMobileMenuOpen(false);
  };

  /** Đóng menu mobile trước khi mở bước xác nhận đăng xuất để thao tác không bị che khuất. */
  const handleLogoutClick = (): void => {
    setIsMobileMenuOpen(false);
    onLogout();
  };

  return (
    <header className="sticky top-0 z-50 border-b border-emerald-900/10 bg-white/90 shadow-[0_4px_20px_rgba(15,23,42,0.04)] backdrop-blur-xl">
      <div className="mx-auto flex min-h-16 w-full max-w-7xl items-center justify-between gap-4 px-4 sm:px-6">
        <Link href="/auditor" className="flex shrink-0 items-center gap-2.5" aria-label="Cổng kiểm toán viên">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#0e7c6b] shadow-[0_8px_24px_rgba(14,124,107,0.24)]">
            <svg viewBox="0 0 24 24" className="h-6 w-6 fill-white" aria-hidden="true">
              <path d="M12 21.7C5.8 17.5 2 13.2 2 9a6 6 0 0112 0 6 6 0 0112 0c0 4.2-3.8 8.5-10 12.7z" />
            </svg>
          </span>
          <span className="hidden sm:block">
            <span className="block font-extrabold leading-none tracking-tight text-slate-950">DCP</span>
            <span className="mt-1 block text-[10px] font-medium leading-none tracking-wide text-emerald-700">Cổng kiểm toán viên</span>
          </span>
        </Link>

        <nav aria-label="Nghiệp vụ Kiểm toán viên" className="hidden min-w-0 flex-1 items-center justify-end gap-1 lg:flex" role="tablist">
          {auditorNavigationItemList.map(item => (
            <button
              key={item.id}
              type="button"
              id={item.tabId}
              role="tab"
              aria-controls={item.panelId}
              aria-selected={activeTab === item.id}
              onClick={() => onTabChange(item.id)}
              className={`min-h-10 rounded-xl px-3 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-emerald-200 xl:px-4 ${activeTab === item.id ? 'bg-emerald-50 text-[#0e7c6b]' : 'text-slate-600 hover:bg-emerald-50 hover:text-[#0e7c6b]'}`}
            >
              {item.label}
            </button>
          ))}
        </nav>

        <button type="button" onClick={handleLogoutClick} className="hidden min-h-10 shrink-0 items-center rounded-xl border border-red-200 px-3 text-sm font-semibold text-red-700 transition-colors hover:bg-red-50 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-red-100 lg:inline-flex">Đăng xuất</button>

        <button
          type="button"
          className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[#0e7c6b] text-white shadow-sm transition hover:bg-[#0a5c50] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-emerald-200 lg:hidden"
          aria-label={isMobileMenuOpen ? 'Đóng menu' : 'Mở menu'}
          aria-expanded={isMobileMenuOpen}
          aria-controls="auditor-mobile-menu"
          onClick={() => setIsMobileMenuOpen(current => !current)}
        >
          <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            {isMobileMenuOpen ? <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" /> : <><path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" /></>}
          </svg>
        </button>
      </div>

      {isMobileMenuOpen && typeof document !== 'undefined' && createPortal(
        <>
          <button type="button" className="fixed inset-0 z-[60] bg-slate-950/45 lg:hidden" onClick={() => setIsMobileMenuOpen(false)} aria-label="Đóng menu" />
          <aside id="auditor-mobile-menu" className="fixed inset-y-0 right-0 z-[70] flex w-[88vw] max-w-sm flex-col overflow-y-auto bg-white shadow-[-12px_0_36px_rgba(15,23,42,0.18)] lg:hidden" role="dialog" aria-modal="true" aria-label="Menu nghiệp vụ Auditor">
            <div className="flex min-h-16 items-center justify-between border-b border-emerald-100 px-5">
              <div>
                <p className="font-extrabold tracking-tight text-slate-950">DCP</p>
                <p className="text-[10px] font-medium tracking-wide text-emerald-700">Cổng kiểm toán viên</p>
              </div>
              <button type="button" className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-50 text-[#0e7c6b] transition hover:bg-emerald-100 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-emerald-200" onClick={() => setIsMobileMenuOpen(false)} aria-label="Đóng menu">
                <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" /></svg>
              </button>
            </div>
            <nav aria-label="Nghiệp vụ Kiểm toán viên trên mobile" className="!static !z-auto !block !h-auto !min-h-0 !flex-1 !border-0 !bg-transparent !p-0 !backdrop-blur-none">
              <ul className="space-y-1 px-3 py-4">
                {auditorNavigationItemList.map(item => (
                  <li key={item.id}>
                    <button
                      type="button"
                      aria-pressed={activeTab === item.id}
                      onClick={() => handleMobileTabChange(item.id)}
                      className={`flex min-h-12 w-full items-center rounded-xl px-4 text-left text-sm font-semibold transition-colors ${activeTab === item.id ? 'bg-emerald-50 text-[#0e7c6b]' : 'text-slate-700 hover:bg-emerald-50 hover:text-[#0e7c6b]'}`}
                    >
                      {item.label}
                    </button>
                  </li>
                ))}
              </ul>
            </nav>
            <div className="border-t border-slate-100 p-4">
              <button type="button" onClick={handleLogoutClick} className="inline-flex min-h-11 w-full items-center justify-center rounded-xl border border-red-200 px-4 text-sm font-semibold text-red-700 transition-colors hover:bg-red-50 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-red-100">Đăng xuất</button>
            </div>
          </aside>
        </>,
        document.body
      )}
    </header>
  );
}
