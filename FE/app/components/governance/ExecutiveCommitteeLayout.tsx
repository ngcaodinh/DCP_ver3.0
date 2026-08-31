'use client';

import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { clearAuthSession, readAuthSession } from '@/app/utils/authSession';
import { useLogoutConfirmation } from '@/app/hooks/useLogoutConfirmation';
import { EXECUTIVE_COMMITTEE_POLICY } from '@/app/utils/executiveCommitteePolicy';
import ExecutivePortalClient from './ExecutivePortalClient';
import { ActiveProjectsPanel } from './ActiveProjectsPanel';
import { PendingPublicationProjectsPanel } from './PendingPublicationProjectsPanel';
import { ChairActionsPanel } from './ChairActionsPanel';
import { DisbursementVotingPanel } from './DisbursementVotingPanel';
import { ExecutiveCommitteeNavigation, type ExecutiveCommitteeTab, type ExecutiveViewerRole } from './ExecutiveCommitteeNavigation';

/** Bố cục chung cho hai cổng Ủy ban, guard role tại client để tránh flash dữ liệu sang sai vai. */
export function ExecutiveCommitteeLayout(props: { viewerRole: ExecutiveViewerRole }): ReactElement {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<ExecutiveCommitteeTab>('ACTIVE_PROJECTS');
  const [isAuthorized, setIsAuthorized] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  useEffect(() => {
    const role = readAuthSession().userRole;
    const expectedRole = props.viewerRole === 'CHAIR' ? 'executive_chair' : 'executive_member';
    if (role !== expectedRole) {
      if (role === 'executive_chair') router.replace('/executive/chair');
      else if (role === 'executive_member') router.replace('/executive/member');
      else router.replace('/unauthorized');
      return;
    }
    setIsAuthorized(true);
  }, [props.viewerRole, router]);

  useEffect(() => {
    const authenticatedWalletAddress = String(readAuthSession().userWalletAddress || '').toLowerCase();
    const ethereum = (window as Window & {
      ethereum?: {
        on?: (eventName: 'accountsChanged', listener: (accounts: string[]) => void) => void;
        removeListener?: (eventName: 'accountsChanged', listener: (accounts: string[]) => void) => void;
      };
    }).ethereum;
    const handleAccountsChanged = (accounts: string[]): void => {
      if (String(accounts[0] || '').toLowerCase() === authenticatedWalletAddress) return;
      clearAuthSession();
      router.replace('/governance/login');
    };
    ethereum?.on?.('accountsChanged', handleAccountsChanged);
    return () => ethereum?.removeListener?.('accountsChanged', handleAccountsChanged);
  }, [router]);

  useEffect(() => {
    if (!isMobileMenuOpen) return undefined;
    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    /** Tự đóng drawer khi chuyển sang desktop để không giữ khóa cuộn ngoài ý muốn. */
    const handleDesktopViewportChange = (): void => {
      if (window.innerWidth >= 1024) setIsMobileMenuOpen(false);
    };
    window.addEventListener('resize', handleDesktopViewportChange);
    /** Đóng drawer bằng Escape để thao tác bàn phím nhất quán với các cổng DCP khác. */
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setIsMobileMenuOpen(false);
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('resize', handleDesktopViewportChange);
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousBodyOverflow;
    };
  }, [isMobileMenuOpen]);

  /** Kết thúc phiên DAO sau khi xác nhận và đưa Chủ tịch hoặc Ủy viên về cổng Governance. */
  const handleConfirmedLogout = (): void => {
    clearAuthSession();
    router.replace('/governance/login');
  };

  /** Bật hoặc tắt drawer điều hướng trên mobile để không che khuất nội dung biểu quyết. */
  const handleToggleMobileMenu = (): void => {
    setIsMobileMenuOpen(current => !current);
  };

  /** Đóng drawer khi người dùng hoàn tất điều hướng hoặc chạm ra ngoài vùng menu. */
  const handleCloseMobileMenu = (): void => {
    setIsMobileMenuOpen(false);
  };

  const { requestLogout, logoutConfirmationDialog } = useLogoutConfirmation(handleConfirmedLogout);

  if (!isAuthorized) {
    return <main className="grid min-h-screen place-items-center bg-slate-50 px-4">
      <div className="flex items-center gap-3 rounded-2xl border border-emerald-100 bg-white px-5 py-4 text-sm font-medium text-slate-700 shadow-sm">
        <div aria-label="Đang xác minh quyền truy cập" className="h-5 w-5 animate-spin rounded-full border-2 border-[#0E7C6B] border-t-transparent" />
        Đang xác minh quyền truy cập
      </div>
    </main>;
  }

  const roleLabel = props.viewerRole === 'CHAIR' ? 'Chủ tịch DAO' : 'Ủy viên Điều hành';
  const roleDescription = props.viewerRole === 'CHAIR'
    ? 'Chữ ký của bạn là điều kiện bắt buộc cho mọi quyết định hợp lệ.'
    : 'Phiếu của bạn có giá trị khi đồng thuận với Chủ tịch và một Ủy viên khác.';
  const activeTabId = 'executive-' + activeTab + '-tab';
  const activePanelId = 'executive-' + activeTab + '-panel';

  return <main className="min-h-screen overflow-x-clip bg-slate-50 text-slate-900 lg:flex lg:items-start">
    <div className="hidden shrink-0 self-start lg:sticky lg:top-0 lg:block lg:h-screen">
      <ExecutiveCommitteeNavigation activeTab={activeTab} viewerRole={props.viewerRole} onSelect={setActiveTab} onLogout={requestLogout} />
    </div>

    {isMobileMenuOpen ? <div className="fixed inset-0 z-50 lg:hidden">
      <button type="button" aria-label="Đóng menu điều hướng" onClick={handleCloseMobileMenu} className="absolute inset-0 animate-[executiveScrimIn_180ms_ease-out] bg-slate-950/45 motion-reduce:animate-none" />
      <div id="executive-mobile-menu" role="dialog" aria-modal="true" aria-label="Menu điều hướng Ủy ban" className="relative min-h-screen h-[100dvh] w-[min(252px,calc(100vw-1rem))] animate-[executiveDrawerIn_220ms_ease-out] shadow-2xl motion-reduce:animate-none">
        <ExecutiveCommitteeNavigation activeTab={activeTab} viewerRole={props.viewerRole} onSelect={setActiveTab} onLogout={requestLogout} onCloseMobileMenu={handleCloseMobileMenu} />
      </div>
    </div> : null}

    <div className="min-w-0 flex-1">
      <header className="sticky inset-x-0 top-0 z-20 flex h-16 items-center justify-between border-b border-emerald-900/15 bg-white px-4 lg:z-10 lg:px-7">
        <div className="min-w-0 flex items-center gap-2.5">
          <button type="button" onClick={handleToggleMobileMenu} className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-emerald-900/15 text-slate-700 transition-colors hover:bg-emerald-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-200 lg:hidden" aria-label={isMobileMenuOpen ? 'Đóng menu điều hướng' : 'Mở menu điều hướng'} aria-expanded={isMobileMenuOpen} aria-controls="executive-mobile-menu">
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">{isMobileMenuOpen ? <><path d="M6 6l12 12" /><path d="M18 6 6 18" /></> : <><path d="M4 7h16" /><path d="M4 12h16" /><path d="M4 17h16" /></>}</svg>
          </button>
          <p className="flex min-w-0 items-center truncate text-[12.5px] font-medium leading-none text-slate-500">
            <span>DCP</span>
            <svg viewBox="0 0 20 20" className="mx-1.5 h-3.5 w-3.5 shrink-0 text-slate-400" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m7 4 5 6-5 6" /></svg>
            <span className="truncate font-semibold text-slate-900">Ủy ban Điều hành</span>
          </p>
        </div>
        <span title={roleLabel} className="max-w-[8rem] shrink-0 truncate rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-[#0E7C6B] sm:max-w-none sm:px-3 sm:text-xs">{roleLabel}</span>
      </header>

      <div className="space-y-5 p-4 sm:p-5 lg:p-7">
        <header>
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-[#0E7C6B]">Không gian quản trị DAO</p>
          <h1 className="mt-1 text-xl font-bold tracking-tight text-slate-900 sm:text-2xl">Quyết định minh bạch</h1>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-500">{roleDescription}</p>
        </header>

        <div role="region" aria-label="Ngưỡng biểu quyết" className="grid overflow-hidden rounded-2xl border border-emerald-200 bg-white p-4 shadow-[0_8px_24px_rgba(15,23,42,0.04)] sm:grid-cols-[minmax(0,1fr)_auto] sm:p-5">
          <div className="p-4 sm:p-5">
            <p className="text-xs font-bold uppercase tracking-[0.14em] text-[#0E7C6B]">Ngưỡng biểu quyết</p>
            <p className="mt-1 text-base font-bold text-slate-950 sm:text-lg">Tiếp tục 3/5 · Hủy vĩnh viễn 5/5</p>
            <p className="mt-1 text-sm leading-6 text-slate-600">Tiếp tục cần chữ ký Chủ tịch và ít nhất 2 Ủy viên. Hủy dự án chỉ có hiệu lực khi cả 5 ghế snapshot cùng ký.</p>
          </div>
          <dl className="grid grid-cols-3 border-t border-emerald-100 bg-emerald-50/70 sm:w-[23rem] sm:border-l sm:border-t-0">
            <div className="min-w-0 border-r border-emerald-100 px-3 py-3 sm:px-4">
              <dt className="break-words text-[10px] font-medium uppercase leading-4 tracking-wide text-emerald-800">Chủ tịch</dt>
              <dd className="mt-1 text-base font-bold text-slate-950">{EXECUTIVE_COMMITTEE_POLICY.requiredChairVotes}/1</dd>
            </div>
            <div className="min-w-0 border-r border-emerald-100 px-3 py-3 sm:px-4">
              <dt className="break-words text-[10px] font-medium uppercase leading-4 tracking-wide text-emerald-800">Ủy viên</dt>
              <dd className="mt-1 text-base font-bold text-slate-950">{EXECUTIVE_COMMITTEE_POLICY.requiredMemberVotes}/{EXECUTIVE_COMMITTEE_POLICY.expectedMemberSeats}</dd>
            </div>
            <div className="min-w-0 px-3 py-3 sm:px-4">
              <dt className="break-words text-[10px] font-medium uppercase leading-4 tracking-wide text-emerald-800">Nguyên tắc</dt>
              <dd className="mt-1 text-xs font-bold leading-5 text-slate-950">Đồng thuận</dd>
            </div>
          </dl>
        </div>

        <div role="tabpanel" id={activePanelId} aria-labelledby={activeTabId}>
          {props.viewerRole === 'CHAIR' && activeTab !== 'PENDING_PUBLICATION' ? <ChairActionsPanel /> : null}
          {activeTab === 'ACTIVE_PROJECTS' ? <ActiveProjectsPanel /> : null}
          {activeTab === 'PENDING_PUBLICATION' ? <PendingPublicationProjectsPanel /> : null}
          {activeTab === 'DISBURSEMENT' ? <DisbursementVotingPanel /> : null}
          {activeTab === 'PROJECT_VERDICT' ? <ExecutivePortalClient /> : null}
        </div>
      </div>
    </div>
    {logoutConfirmationDialog}
  </main>;
}
