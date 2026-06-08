import type { TimelineItem } from './types';

type TimelineCardProps = {
  timelineItemList: TimelineItem[];
};

/** Hàm trả về màu nền và viền icon theo loại sự kiện để timeline bám sát tone màu file mẫu. */
function getTimelineToneClassName(type: TimelineItem['type']): string {
  if (type === 'sign') return 'border-cyan-200 bg-cyan-100 text-cyan-700';
  if (type === 'view') return 'border-emerald-200 bg-emerald-100 text-emerald-700';
  if (type === 'reject') return 'border-red-200 bg-red-100 text-red-600';
  return 'border-slate-300 bg-slate-100 text-slate-700';
}

/** Hàm trả về icon SVG theo loại sự kiện để giao diện rõ nghĩa và đồng nhất hơn ký hiệu text. */
function getTimelineIcon(type: TimelineItem['type']) {
  if (type === 'sign') return <path d="M3 8.5l2.1 2.1L9 6.7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none" />;
  if (type === 'view') return <path d="M1.5 8s2.4-3.5 6.5-3.5S14.5 8 14.5 8s-2.4 3.5-6.5 3.5S1.5 8 1.5 8zm6.5 1.8a1.8 1.8 0 100-3.6 1.8 1.8 0 000 3.6z" fill="currentColor" />;
  if (type === 'reject') return <path d="M5.2 5.2l5.6 5.6m0-5.6l-5.6 5.6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" fill="none" />;
  return <path d="M8 2.2a5.8 5.8 0 105.8 5.8M8 1v3m0 8v3m7-7h-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" />;
}

/** Hàm component TimelineCard để hiển thị hoạt động gần đây theo dạng timeline dễ theo dõi. */
export default function TimelineCard({ timelineItemList }: TimelineCardProps) {
  return (
    <div className="rounded-xl border border-emerald-900/15 bg-white">
      <div className="border-b border-emerald-900/15 px-5 py-3.5">
        <h2 className="text-[14px] font-bold leading-5 text-slate-900">Hoạt động gần đây</h2>
      </div>
      <ul>
        {timelineItemList.map((timelineItem, index) => (
          <li key={`${timelineItem.actionText}-${timelineItem.timeText}`} className="relative flex items-start gap-3 border-b border-slate-100 px-5 py-3.5 last:border-b-0">
            {index < timelineItemList.length - 1 ? <span className="absolute left-[33px] top-[42px] h-[calc(100%-30px)] w-px bg-slate-200" /> : null}
            <span className={`relative z-10 inline-flex h-7 w-7 items-center justify-center rounded-full border ${getTimelineToneClassName(timelineItem.type)}`}>
              <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden="true">{getTimelineIcon(timelineItem.type)}</svg>
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[12.5px] font-semibold leading-5 text-slate-900">{timelineItem.actionText}</p>
              <p className="text-[11.5px] leading-4 text-slate-600">{timelineItem.detailText}</p>
            </div>
            <span className="shrink-0 font-mono text-[10.5px] text-slate-500">{timelineItem.timeText}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

