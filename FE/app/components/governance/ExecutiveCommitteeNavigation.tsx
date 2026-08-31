import type { ReactElement } from 'react';

export type ExecutiveCommitteeTab = 'ACTIVE_PROJECTS' | 'PENDING_PUBLICATION' | 'DISBURSEMENT' | 'PROJECT_VERDICT';
export type ExecutiveViewerRole = 'CHAIR' | 'MEMBER';

interface ExecutiveCommitteeNavigationProps {
  activeTab: ExecutiveCommitteeTab;
  viewerRole: ExecutiveViewerRole;
  onSelect: (tab: ExecutiveCommitteeTab) => void;
  onLogout: () => void;
  onCloseMobileMenu?: () => void;
}

interface ExecutiveNavigationItem {
  id: ExecutiveCommitteeTab;
  label: string;
  iconPath: string;
}

const executiveNavigationItemList: ExecutiveNavigationItem[] = [
  { id: 'ACTIVE_PROJECTS', label: 'Dự án đang hoạt động', iconPath: 'M3 12h18M3 6h18M3 18h18' },
  { id: 'PENDING_PUBLICATION', label: 'Dự án chờ công bố', iconPath: 'M12 2a8 8 0 1 0 8 8H12V2Zm0 12v4m0 0h4m-4 0H8' },
  { id: 'DISBURSEMENT', label: 'Duyệt giải ngân', iconPath: 'M12 3v18m-6-6 6 6 6-6M5 5h14v4H5z' },
  { id: 'PROJECT_VERDICT', label: 'Phán quyết dự án bị tố', iconPath: 'M12 3 4 7v5c0 5 3.4 8.5 8 9 4.6-.5 8-4 8-9V7l-8-4Zm-3.5 9 2.3 2.3 4.8-4.8' }
];

/** Hiển thị sidebar nghiệp vụ của Ủy ban với cùng hệ nhận diện và hành vi điều hướng của các dashboard DCP. */
export function ExecutiveCommitteeNavigation({
  activeTab,
  viewerRole,
  onSelect,
  onLogout,
  onCloseMobileMenu
}: ExecutiveCommitteeNavigationProps): ReactElement {
  const roleLabel = viewerRole === 'CHAIR' ? 'Chủ tịch DAO' : 'Ủy viên Điều hành';

  /** Chuyển khu vực nghiệp vụ và đóng drawer khi người dùng đang thao tác trên màn hình nhỏ. */
  const handleSelect = (tab: ExecutiveCommitteeTab): void => {
    onSelect(tab);
    onCloseMobileMenu?.();
  };

  /** Đóng drawer trước khi mở xác nhận đăng xuất để hộp thoại luôn nhận được thao tác ưu tiên. */
  const handleLogout = (): void => {
    onCloseMobileMenu?.();
    onLogout();
  };

  return <aside className="flex min-h-screen h-[100dvh] min-w-0 w-[min(252px,calc(100vw-1rem))] shrink-0 flex-col overflow-y-auto border-r border-[#0F6B5D] bg-gradient-to-b from-[#0E7C6B] via-[#0A5C50] to-[#08473F] text-white lg:sticky lg:top-0 lg:h-screen lg:self-start">
    <div className="border-b border-white/10 px-4 py-4">
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/15 shadow-[0_8px_20px_rgba(0,0,0,0.18)] ring-1 ring-white/20">
          <svg viewBox="0 0 24 24" className="h-5 w-5 text-white" fill="currentColor" aria-hidden="true">
            <path d="M12 21.7C5.8 17.5 2 13.2 2 9a6 6 0 0112 0 6 6 0 0112 0c0 4.2-3.8 8.5-10 12.7z" />
          </svg>
        </span>
        <div className="min-w-0">
          <p className="text-[15px] font-bold leading-none">DCP</p>
          <p title="Decentralized Charity Platform" className="mt-1 truncate text-[10px] uppercase tracking-[0.12em] text-white/55">Decentralized Charity Platform</p>
        </div>
      </div>
      <p className="mt-3 flex min-w-0 items-center gap-2 rounded-lg border border-cyan-200/25 bg-cyan-200/10 px-2.5 py-1.5 text-[11px] font-medium text-white/85">
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0 text-emerald-200" fill="currentColor" aria-hidden="true"><circle cx="12" cy="12" r="4" /></svg>
        <span className="min-w-0 truncate">Cổng Ủy ban Điều hành</span>
      </p>
    </div>

    <div className="px-3 pt-4">
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-white/45">Điều hướng chính</p>
      <div aria-label="Điều hướng Ủy ban" aria-orientation="vertical" className="mt-2 flex min-h-0 w-full flex-col space-y-1.5" role="tablist">
        {executiveNavigationItemList.map(item => {
          const isActive = activeTab === item.id;
          return <button
            key={item.id}
            type="button"
            id={'executive-' + item.id + '-tab'}
            role="tab"
            aria-controls={'executive-' + item.id + '-panel'}
            aria-selected={isActive}
            onClick={() => handleSelect(item.id)}
            className={`group flex min-h-11 min-w-0 w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-200 ${isActive ? 'border border-white/25 bg-white/15 text-white' : 'text-white/75 hover:bg-white/10 hover:text-white'}`}
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d={item.iconPath} />
            </svg>
            <span className="min-w-0 truncate">{item.label}</span>
          </button>;
        })}
      </div>
    </div>

    <div className="mt-auto border-t border-white/10 p-3">
      <div className="rounded-xl bg-white/10 px-3 py-2.5">
        <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-white/50">Vai trò hiện tại</p>
        <p className="mt-1 text-sm font-semibold text-white">{roleLabel}</p>
      </div>
      <button type="button" onClick={handleLogout} className="mt-3 flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-white/20 px-3 py-2 text-sm font-semibold text-white/90 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-200">
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10 17l5-5-5-5M15 12H3m10-7h5a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-5" /></svg>
        Đăng xuất
      </button>
    </div>
  </aside>;
}
