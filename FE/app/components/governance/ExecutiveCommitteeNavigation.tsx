import type { ReactElement } from 'react';

export type ExecutiveCommitteeTab = 'ACTIVE_PROJECTS' | 'DISBURSEMENT' | 'PROJECT_VERDICT';
export type ExecutiveViewerRole = 'CHAIR' | 'MEMBER';

/** Điều hướng ba việc duy nhất của Ủy ban; nhãn phản ánh nghiệp vụ chứ không lộ tên code backend. */
export function ExecutiveCommitteeNavigation(props: { activeTab: ExecutiveCommitteeTab; onSelect: (tab: ExecutiveCommitteeTab) => void }): ReactElement {
  const tabs: Array<{ id: ExecutiveCommitteeTab; label: string; order: string }> = [
    { id: 'ACTIVE_PROJECTS', label: 'Dự án đang hoạt động', order: '01' },
    { id: 'DISBURSEMENT', label: 'Duyệt giải ngân', order: '02' },
    { id: 'PROJECT_VERDICT', label: 'Phán quyết dự án bị tố', order: '03' }
  ];

  return <nav aria-label="Điều hướng Ủy ban" className="-mx-3 overflow-x-auto px-3 pb-1 sm:mx-0 sm:px-0">
    <div role="tablist" className="flex min-w-max gap-2 rounded-2xl border border-violet-100 bg-white/85 p-1.5 shadow-sm backdrop-blur sm:min-w-0">
      {tabs.map(tab => {
        const isActive = props.activeTab === tab.id;
        return <button key={tab.id} id={'executive-' + tab.id + '-tab'} role="tab" aria-controls={'executive-' + tab.id + '-panel'} aria-selected={isActive} aria-label={tab.label} type="button" onClick={() => props.onSelect(tab.id)} className={'group min-h-11 whitespace-nowrap rounded-xl px-3 py-2 text-left text-sm font-semibold transition-all focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-700 sm:flex-1 sm:px-4 ' + (isActive ? 'bg-violet-700 text-white shadow-[0_8px_18px_-10px_rgba(91,33,182,0.95)]' : 'text-slate-600 hover:bg-violet-50 hover:text-violet-800')}>
          <span className={'mr-2 inline-flex h-5 w-5 items-center justify-center rounded-md text-[10px] ' + (isActive ? 'bg-white/15 text-violet-100' : 'bg-slate-100 text-slate-500 group-hover:bg-violet-100 group-hover:text-violet-700')}>{tab.order}</span>
          {tab.label}
        </button>;
      })}
    </div>
  </nav>;
}
