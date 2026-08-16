import type { ReactElement } from 'react';
import type { ImpactSbtGalleryEntry } from '@/app/types/impactSbt';

interface SbtMilestoneTimelineProps {
  entries: ImpactSbtGalleryEntry[];
  currentTokenId: number;
}

/** Định dạng thời điểm xác nhận milestone và giữ dữ liệu gốc nếu timestamp lỗi. */
function formatConfirmedAt(value: string | null): string {
  if (!value) return 'Chưa rõ thời điểm';
  const parsedDate = new Date(value);
  if (Number.isNaN(parsedDate.getTime())) return value;
  return parsedDate.toLocaleString('vi-VN', { hour12: false });
}

/** Render các milestone theo thứ tự đã được page chuẩn hóa, không tự fetch hoặc thay đổi dữ liệu đầu vào. */
export default function SbtMilestoneTimeline({ entries, currentTokenId }: SbtMilestoneTimelineProps): ReactElement {
  return (
    <section data-testid="sbt-milestone-timeline" className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="text-lg font-semibold text-slate-900">Milestone đã ghi nhận</h2>
      {entries.length === 0 ? (
        <p className="mt-4 text-sm text-slate-600">Chưa có milestone nào được ghi nhận công khai.</p>
      ) : (
        <ol className="mt-5 space-y-0">
          {entries.map((entry, index) => {
            const isCurrentToken = entry.onChainTokenId === currentTokenId;
            const entryKey = `${entry.projectId}-${entry.onChainTokenId ?? `milestone-${entry.milestone}`}`;
            return (
              <li key={entryKey} className="relative flex gap-4 pb-6 last:pb-0">
                {index < entries.length - 1 && (
                  <span aria-hidden="true" className="absolute left-4 top-9 h-[calc(100%-1.5rem)] w-px bg-slate-200" />
                )}
                <span
                  aria-hidden="true"
                  className={`relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border text-sm font-bold ${
                    isCurrentToken
                      ? 'border-cyan-600 bg-cyan-600 text-white'
                      : 'border-slate-300 bg-white text-slate-600'
                  }`}
                >
                  {entry.milestone}
                </span>
                <div
                  aria-current={isCurrentToken ? 'step' : undefined}
                  className={`min-w-0 flex-1 rounded-lg border p-3 ${
                    isCurrentToken ? 'border-cyan-200 bg-cyan-50' : 'border-slate-200 bg-slate-50'
                  }`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="font-semibold text-slate-900">Milestone {entry.milestone}</h3>
                    {isCurrentToken && (
                      <span className="rounded-full bg-cyan-100 px-2 py-1 text-xs font-semibold text-cyan-800">SBT hiện tại</span>
                    )}
                  </div>
                  <p className="mt-2 text-sm text-slate-600">Đã ghi nhận trên chain · {entry.beneficiaryCount} người thụ hưởng</p>
                  <p className="mt-1 text-xs text-slate-500">Xác nhận: {formatConfirmedAt(entry.confirmedAt)}</p>
                  {entry.onChainTokenId !== null && (
                    <p className="mt-1 font-mono text-xs text-slate-500">Token #{entry.onChainTokenId}</p>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
