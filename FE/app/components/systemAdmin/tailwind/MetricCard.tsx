'use client';

// =============================================================================
// MetricCard cho System Admin Page
// Clone from: FE/app/components/regulatoryBodies/tailwind/MetricCard.tsx
// Mục đích: Thẻ hiển thị số liệu thống kê với gradient border-top và trend indicator
// =============================================================================

type MetricCardProps = {
  colorVariant: 'amber' | 'cyan' | 'green' | 'teal';
  valueText: string;
  labelText: string;
  trendText: string;
  trendClassName: 'trend-up' | 'trend-dn';
};

export default function MetricCard({
  colorVariant,
  valueText,
  labelText,
  trendText,
  trendClassName,
}: MetricCardProps) {
  const accentColor = {
    amber: 'bg-gradient-to-r from-amber-500 to-amber-600',
    cyan: 'bg-gradient-to-r from-cyan-500 to-cyan-600',
    green: 'bg-gradient-to-r from-emerald-500 to-emerald-600',
    teal: 'bg-gradient-to-r from-[#0E7C6B] to-[#1AAE97]',
  }[colorVariant];

  return (
    <div className="relative overflow-hidden rounded-xl border border-emerald-900/15 bg-white px-5 py-5">
      {/* Top accent gradient bar — thay vì div rời */}
      <div className={`absolute left-0 top-0 h-[3px] w-full rounded-b-md ${accentColor}`} />

      {/* Value */}
      <p className="font-mono text-[30px] font-bold leading-none text-slate-900">{valueText}</p>

      {/* Label */}
      <p className="mt-1.5 text-[12px] leading-4 text-slate-500">{labelText}</p>

      {/* Trend */}
      <div className={`mt-3 text-xs font-medium ${trendClassName === 'trend-up' ? 'text-emerald-600' : 'text-red-600'
        }`}>
        {trendText}
      </div>
    </div>
  );
}
