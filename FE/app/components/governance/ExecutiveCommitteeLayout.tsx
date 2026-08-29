'use client';

import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { clearAuthSession, readAuthSession } from '@/app/utils/authSession';
import { EXECUTIVE_COMMITTEE_POLICY } from '@/app/utils/executiveCommitteePolicy';
import ExecutivePortalClient from './ExecutivePortalClient';
import { ActiveProjectsPanel } from './ActiveProjectsPanel';
import { ChairActionsPanel } from './ChairActionsPanel';
import { DisbursementVotingPanel } from './DisbursementVotingPanel';
import { ExecutiveCommitteeNavigation, type ExecutiveCommitteeTab, type ExecutiveViewerRole } from './ExecutiveCommitteeNavigation';

/** Bố cục chung cho hai cổng Ủy ban, guard role tại client để tránh flash dữ liệu sang sai vai. */
export function ExecutiveCommitteeLayout(props: { viewerRole: ExecutiveViewerRole }): ReactElement {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<ExecutiveCommitteeTab>('ACTIVE_PROJECTS');
  const [isAuthorized, setIsAuthorized] = useState(false);

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

  if (!isAuthorized) {
    return <main className="grid min-h-screen place-items-center bg-slate-50 px-4">
      <div className="flex items-center gap-3 rounded-2xl border border-violet-100 bg-white px-5 py-4 text-sm font-medium text-slate-700 shadow-sm">
        <div aria-label="Đang xác minh quyền truy cập" className="h-5 w-5 animate-spin rounded-full border-2 border-violet-700 border-t-transparent" />
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

  return <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_#ede9fe_0,_#f8fafc_36rem,_#f8fafc_100%)]">
    <div className="mx-auto w-full max-w-6xl space-y-4 px-3 py-4 sm:space-y-6 sm:px-4 sm:py-8">
      <header className="relative isolate overflow-hidden rounded-3xl bg-gradient-to-br from-violet-950 via-violet-800 to-indigo-700 p-5 text-white shadow-[0_20px_50px_-20px_rgba(76,29,149,0.75)] sm:p-7">
        <div aria-hidden="true" className="absolute -right-16 -top-24 h-56 w-56 rounded-full bg-fuchsia-400/20 blur-2xl" />
        <div aria-hidden="true" className="absolute -bottom-28 left-1/3 h-56 w-56 rounded-full bg-sky-300/15 blur-3xl" />
        <div className="relative grid gap-6 lg:grid-cols-[minmax(0,1fr)_17rem] lg:items-end">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/10 px-3 py-1 text-xs font-semibold tracking-wide text-violet-100 backdrop-blur-sm">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-300" />
                CỔNG ỦY BAN ĐIỀU HÀNH
              </span>
              <span className="rounded-full bg-fuchsia-200/15 px-3 py-1 text-xs font-semibold text-fuchsia-100">{roleLabel}</span>
            </div>
            <h1 className="mt-4 text-3xl font-bold tracking-tight sm:text-4xl">Không gian quyết định minh bạch</h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-violet-100 sm:text-base">{roleDescription}</p>
          </div>
          <aside className="rounded-2xl border border-white/15 bg-slate-950/20 p-4 backdrop-blur-sm">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-violet-200">Ngưỡng biểu quyết</p>
            <p className="mt-2 text-lg font-bold">01 Chủ tịch + 02 Ủy viên</p>
            <p className="mt-1 text-sm leading-5 text-violet-100">Cùng một phía trong tổng số {EXECUTIVE_COMMITTEE_POLICY.expectedMemberSeats} ghế Ủy viên.</p>
          </aside>
        </div>
        <dl className="relative mt-6 grid grid-cols-3 divide-x divide-white/15 rounded-2xl border border-white/10 bg-white/10 backdrop-blur-sm">
          <div className="min-w-0 px-3 py-3 sm:px-4">
            <dt className="text-[11px] font-medium uppercase tracking-wide text-violet-200">Chủ tịch bắt buộc</dt>
            <dd className="mt-1 text-lg font-bold">{EXECUTIVE_COMMITTEE_POLICY.requiredChairVotes}/1</dd>
          </div>
          <div className="min-w-0 px-3 py-3 sm:px-4">
            <dt className="text-[11px] font-medium uppercase tracking-wide text-violet-200">Ủy viên tối thiểu</dt>
            <dd className="mt-1 text-lg font-bold">{EXECUTIVE_COMMITTEE_POLICY.requiredMemberVotes}/{EXECUTIVE_COMMITTEE_POLICY.expectedMemberSeats}</dd>
          </div>
          <div className="min-w-0 px-3 py-3 sm:px-4">
            <dt className="text-[11px] font-medium uppercase tracking-wide text-violet-200">Nguyên tắc</dt>
            <dd className="mt-1 text-sm font-bold leading-5">Đồng thuận cùng phía</dd>
          </div>
        </dl>
      </header>

      <ExecutiveCommitteeNavigation activeTab={activeTab} onSelect={setActiveTab} />
      <section role="tabpanel" id={activePanelId} aria-labelledby={activeTabId}>
        {props.viewerRole === 'CHAIR' ? <ChairActionsPanel /> : null}
        {activeTab === 'ACTIVE_PROJECTS' ? <ActiveProjectsPanel /> : null}
        {activeTab === 'DISBURSEMENT' ? <DisbursementVotingPanel /> : null}
        {activeTab === 'PROJECT_VERDICT' ? <ExecutivePortalClient /> : null}
      </section>
    </div>
  </main>;
}
