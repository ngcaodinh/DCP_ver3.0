type MetricCardProps = {
  valueText: string;
  labelText: string;
  trendText: string;
  trendClassName: 'trend-up' | 'trend-dn';
  colorVariant: 'amber' | 'cyan' | 'green' | 'navy';
};

/** Hàm trả về cặp màu theo biến thể thẻ để đồng bộ phong cách card metric với file mẫu HTML. */
function getMetricToneClassName(colorVariant: MetricCardProps['colorVariant']): string {
  if (colorVariant === 'amber') return 'before:from-amber-500 before:to-amber-300';
  if (colorVariant === 'cyan') return 'before:from-cyan-500 before:to-sky-300';
  if (colorVariant === 'green') return 'before:from-emerald-600 before:to-emerald-300';
  return 'before:from-[#0E7C6B] before:to-[#1AAE97]';
}

/** Hàm component MetricCard để hiển thị số liệu tổng quan dạng thẻ trực quan, đồng nhất spacing. */
export default function MetricCard({ valueText, labelText, trendText, trendClassName, colorVariant }: MetricCardProps) {
  return (
    <article className={`relative overflow-hidden rounded-xl border border-emerald-900/15 bg-white px-5 py-5 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md before:absolute before:inset-x-0 before:top-0 before:h-[3px] before:bg-gradient-to-r ${getMetricToneClassName(colorVariant)}`}>
      <p className="font-mono text-[30px] leading-none text-slate-900">{valueText}</p>
      <p className="mt-1.5 text-[12px] leading-4 text-slate-500">{labelText}</p>
      <p className={`mt-2 text-[12px] font-medium leading-4 ${trendClassName === 'trend-up' ? 'text-emerald-600' : 'text-red-600'}`}>{trendText}</p>
    </article>
  );
}

