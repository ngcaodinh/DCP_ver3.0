import { getNavigationItems } from './data';
import type { NavigationItem, PageKey } from './types';

type SidebarProps = {
  selectedPageKey: PageKey;
  navigationItemList: NavigationItem[];
  onSelectPage: (pageKey: PageKey) => void;
  onCloseMobileMenu?: () => void;
};

/** Hiển thị điều hướng Admin theo allowlist và đóng menu ngay sau khi người dùng điều hướng trên màn hình nhỏ. */
export default function Sidebar({ selectedPageKey, navigationItemList, onSelectPage, onCloseMobileMenu }: SidebarProps) {
  const navItems = navigationItemList.length > 0 ? navigationItemList : getNavigationItems();

  return (
    <aside className="flex h-full w-[252px] shrink-0 flex-col overflow-y-auto border-r border-[#0F6B5D] bg-gradient-to-b from-[#0E7C6B] via-[#0A5C50] to-[#08473F] text-white lg:sticky lg:top-0 lg:h-screen">
      <div className="border-b border-white/10 px-4 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/15 shadow-[0_8px_20px_rgba(0,0,0,0.18)] ring-1 ring-white/20">
            <svg viewBox="0 0 24 24" className="h-5 w-5 text-white" fill="currentColor" aria-hidden="true">
              <path d="M12 21.7C5.8 17.5 2 13.2 2 9a6 6 0 0112 0 6 6 0 0112 0c0 4.2-3.8 8.5-10 12.7z" />
            </svg>
          </div>
          <div>
            <p className="text-[15px] font-bold leading-none">DCP</p>
            <p className="mt-1 text-[10px] uppercase tracking-[0.12em] text-white/55">Decentralized Charity Platform</p>
          </div>
        </div>
        <div className="mt-3 rounded-lg border border-cyan-200/25 bg-cyan-200/10 px-2.5 py-1.5 text-[11px] font-medium text-white/85">● Cổng Quản trị Hệ thống</div>
      </div>

      <p className="px-3 pt-4 text-[10px] font-semibold uppercase tracking-[0.14em] text-white/45">Điều hướng chính</p>
      <nav aria-orientation="vertical" className="relative top-auto z-auto flex h-auto w-auto flex-col space-y-1.5 border-0 bg-transparent p-0 px-3 pt-2 shadow-none backdrop-blur-0">
        {navItems.map(navigationItem => (
          <button
            key={navigationItem.key}
            type="button"
            onClick={() => {
              onSelectPage(navigationItem.key);
              onCloseMobileMenu?.();
            }}
            className={`group flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left text-[13px] font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-200 ${selectedPageKey === navigationItem.key ? 'border border-white/25 bg-white/15 text-white' : 'text-white/75 hover:bg-white/10 hover:text-white'}`}
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d={navigationItem.iconPath} />
            </svg>
            <span className="flex-1">{navigationItem.label}</span>
            {navigationItem.badge ? <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold leading-none ${selectedPageKey === navigationItem.key ? 'bg-white/20 text-white' : 'bg-red-500 text-white'}`}>{navigationItem.badge}</span> : null}
          </button>
        ))}
      </nav>
    </aside>
  );
}
