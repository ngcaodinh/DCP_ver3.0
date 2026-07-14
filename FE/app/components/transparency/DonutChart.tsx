'use client';

// =============================================================================
// DonutChart — D4: Biểu đồ donut vẽ bằng SVG thuần (stroke-dasharray), 0 dependency.
// 3 segment: huy động (emerald), giải ngân (blue), còn lại (slate).
// Xử lý edge case: tổng = 0 (vẽ vòng xám full) và remaining < 0 (kẹp về 0).
// Thêm print-color-adjust: exact để donut giữ màu khi in PDF (window.print).
// =============================================================================

import { useId } from 'react';
import { formatVnd } from './format';

/** Thuộc tính cho DonutChart. Các số liệu tính bằng VND. */
export interface DonutChartProps {
  totalRaised: number;
  totalDisbursed: number;
  remaining: number;
}

/** Một segment đã chuẩn hóa để vẽ, kèm nhãn và màu. */
interface DonutSegment {
  label: string;
  value: number;
  colorHex: string;
}

/** Bán kính vòng tròn (đơn vị viewBox). */
const DONUT_RADIUS = 60;
/** Độ dày nét vẽ vòng donut. */
const DONUT_STROKE_WIDTH = 24;
/** Chu vi vòng tròn, dùng cho stroke-dasharray. */
const DONUT_CIRCUMFERENCE = 2 * Math.PI * DONUT_RADIUS;

/** Màu token dự án cho từng segment. */
const COLOR_RAISED = '#10b981';
const COLOR_DISBURSED = '#2563eb';
const COLOR_REMAINING = '#94a3b8';
/** Màu vòng nền khi tổng = 0 (không có dữ liệu). */
const COLOR_EMPTY_TRACK = '#e2e8f0';

/**
 * Vẽ biểu đồ donut phân bổ dòng tiền của một dự án.
 * Segment "giải ngân" và "còn lại" cộng lại nằm trong "huy động"; tuy nhiên để
 * trực quan tỷ trọng, ta vẽ theo đúng 3 giá trị được truyền vào (đã chuẩn hóa).
 *
 * @param props Số liệu huy động / giải ngân / còn lại
 */
export default function DonutChart({ totalRaised, totalDisbursed, remaining }: DonutChartProps) {
  const gradientId = useId();

  // Kẹp remaining về >= 0 để tránh segment âm làm vỡ dasharray (BE có thể trả số âm nếu giải ngân vượt huy động).
  const safeRemaining = Math.max(0, remaining);
  const safeDisbursed = Math.max(0, totalDisbursed);

  const segments: DonutSegment[] = [
    { label: 'Đã giải ngân', value: safeDisbursed, colorHex: COLOR_DISBURSED },
    { label: 'Còn lại', value: safeRemaining, colorHex: COLOR_REMAINING }
  ];

  // Tổng dùng để tính tỷ trọng: ưu tiên totalRaised, fallback sang tổng segment nếu raised = 0 nhưng vẫn có giải ngân.
  const segmentSum = segments.reduce((acc, item) => acc + item.value, 0);
  const chartTotal = Math.max(totalRaised, segmentSum);
  const isEmpty = chartTotal <= 0;

  // Tính offset dồn cho từng cung: mỗi segment bắt đầu tại vị trí kết thúc của segment trước.
  let accumulatedOffset = 0;

  return (
    <div className="flex flex-col items-center gap-4">
      <svg
        viewBox="0 0 160 160"
        role="img"
        aria-label={
          isEmpty
            ? 'Biểu đồ dòng tiền: chưa có dữ liệu'
            : `Biểu đồ dòng tiền: huy động ${formatVnd(totalRaised)} đồng, đã giải ngân ${formatVnd(safeDisbursed)} đồng, còn lại ${formatVnd(safeRemaining)} đồng`
        }
        className="h-44 w-44"
        style={{ printColorAdjust: 'exact', WebkitPrintColorAdjust: 'exact' } as React.CSSProperties}
      >
        <defs>
          <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#0E7C6B" />
            <stop offset="100%" stopColor="#1AAE97" />
          </linearGradient>
        </defs>

        {/* Vòng nền: khi rỗng hiển thị nguyên vòng xám nhạt; khi có dữ liệu làm track mờ phía dưới. */}
        <circle
          cx="80"
          cy="80"
          r={DONUT_RADIUS}
          fill="none"
          stroke={COLOR_EMPTY_TRACK}
          strokeWidth={DONUT_STROKE_WIDTH}
        />

        {/* Các cung segment chỉ vẽ khi có dữ liệu. */}
        {!isEmpty &&
          segments.map((segment) => {
            if (segment.value <= 0) {
              return null;
            }
            const segmentLength = (segment.value / chartTotal) * DONUT_CIRCUMFERENCE;
            const dashArray = `${segmentLength} ${DONUT_CIRCUMFERENCE - segmentLength}`;
            // dashoffset âm để dịch điểm bắt đầu theo chiều kim đồng hồ.
            const dashOffset = -accumulatedOffset;
            accumulatedOffset += segmentLength;

            return (
              <circle
                key={segment.label}
                cx="80"
                cy="80"
                r={DONUT_RADIUS}
                fill="none"
                stroke={segment.colorHex}
                strokeWidth={DONUT_STROKE_WIDTH}
                strokeDasharray={dashArray}
                strokeDashoffset={dashOffset}
                transform="rotate(-90 80 80)"
                strokeLinecap="butt"
              />
            );
          })}

        {/* Nhãn tổng huy động ở tâm donut. */}
        <text x="80" y="76" textAnchor="middle" className="fill-slate-500" style={{ fontSize: '9px' }}>
          Huy động
        </text>
        <text x="80" y="90" textAnchor="middle" className="fill-slate-900 font-mono" style={{ fontSize: '11px' }}>
          {formatVnd(totalRaised)}
        </text>
      </svg>

      {/* Chú giải màu + số liệu chi tiết. */}
      <ul className="w-full space-y-1 text-sm">
        <li className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-2">
            <span className="inline-block h-3 w-3 rounded-sm" style={{ backgroundColor: COLOR_RAISED, printColorAdjust: 'exact', WebkitPrintColorAdjust: 'exact' } as React.CSSProperties} />
            Đã huy động
          </span>
          <span className="font-mono text-slate-900">{formatVnd(totalRaised)}</span>
        </li>
        <li className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-2">
            <span className="inline-block h-3 w-3 rounded-sm" style={{ backgroundColor: COLOR_DISBURSED, printColorAdjust: 'exact', WebkitPrintColorAdjust: 'exact' } as React.CSSProperties} />
            Đã giải ngân
          </span>
          <span className="font-mono text-slate-900">{formatVnd(safeDisbursed)}</span>
        </li>
        <li className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-2">
            <span className="inline-block h-3 w-3 rounded-sm" style={{ backgroundColor: COLOR_REMAINING, printColorAdjust: 'exact', WebkitPrintColorAdjust: 'exact' } as React.CSSProperties} />
            Còn lại
          </span>
          <span className="font-mono text-slate-900">{formatVnd(safeRemaining)}</span>
        </li>
      </ul>
    </div>
  );
}
