import { getDeadlineClass } from './helpers';
import type { UrgentRequestItem } from './types';

type UrgentTableProps = {
  urgentRequestItemList: UrgentRequestItem[];
  onOpenDrawer: (urgentRequestItem: UrgentRequestItem) => void;
};

/** Hàm tách tiến độ chữ ký từ chuỗi dạng x/y để hiển thị dot-progress giống file mẫu. */
function getSignatureProgress(signatureState: string): { signedCount: number; totalCount: number } {
  const [signedText, totalText] = signatureState.split('/');
  const signedCount = Number(signedText);
  const totalCount = Number(totalText);

  // Logic này chặn dữ liệu lỗi để UI không vỡ nếu giá trị chữ ký không đúng định dạng.
  if (!Number.isFinite(signedCount) || !Number.isFinite(totalCount) || totalCount <= 0) {
    return { signedCount: 0, totalCount: 3 };
  }

  return { signedCount, totalCount };
}

/** Hàm trả về class màu theo trạng thái từng dot trong tiến độ chữ ký để người dùng nhận biết nhanh. */
function getSignatureDotClass(dotIndex: number, signedCount: number): string {
  if (dotIndex < signedCount) return 'bg-emerald-500 text-white';
  if (dotIndex === signedCount) return 'bg-cyan-400 text-[#0A5C50]';
  return 'bg-slate-200 text-slate-500';
}

/** Hàm component UrgentTable để hiển thị danh sách yêu cầu gấp và thao tác mở drawer chi tiết. */
export default function UrgentTable({ urgentRequestItemList, onOpenDrawer }: UrgentTableProps) {
  return (
    <div className="overflow-hidden rounded-xl border border-emerald-900/15 bg-white">
      <div className="flex items-center justify-between border-b border-emerald-900/15 px-6 py-3.5">
        <p className="text-[14px] font-bold leading-5 text-slate-900">⚡ Yêu cầu cần xử lý gấp</p>
        <button type="button" className="text-[11.5px] font-semibold text-cyan-700 transition hover:opacity-70">Xem tất cả →</button>
      </div>

      <div className="overflow-x-auto">
        <table className="min-w-full text-left">
          <thead className="bg-slate-50 text-[10px] uppercase tracking-[0.08em] text-slate-500">
            <tr>
              {['Dự án / Tổ chức', 'Số tiền', 'Chữ ký', 'Hết hạn', ''].map(headerLabel => (
                <th key={headerLabel} className="px-6 py-2.5 font-semibold">{headerLabel}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {urgentRequestItemList.map(urgentRequestItem => {
              const signatureProgress = getSignatureProgress(urgentRequestItem.signatureState);

              return (
                <tr key={urgentRequestItem.id} className="border-t border-slate-100 text-sm transition hover:bg-slate-50/80">
                  <td className="px-6 py-3.5 align-middle">
                    <p className="text-[13px] font-semibold leading-5 text-slate-900">{urgentRequestItem.projectName}</p>
                    <p className="mt-0.5 text-[12px] leading-4 text-slate-500">{urgentRequestItem.organizationName}</p>
                  </td>
                  <td className="px-6 py-3.5 align-middle font-mono text-[13px] font-semibold text-slate-800">{urgentRequestItem.amountText}</td>
                  <td className="px-6 py-3.5 align-middle">
                    <div className="flex items-center gap-2">
                      <div className="flex gap-1">
                        {Array.from({ length: signatureProgress.totalCount }).map((_, dotIndex) => (
                          <span key={`${urgentRequestItem.id}-${dotIndex}`} className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-[9px] font-bold ${getSignatureDotClass(dotIndex, signatureProgress.signedCount)}`}>
                            {dotIndex < signatureProgress.signedCount ? '✓' : dotIndex === signatureProgress.signedCount ? '•' : '○'}
                          </span>
                        ))}
                      </div>
                      <span className="font-mono text-[11px] text-slate-500">{urgentRequestItem.signatureState}</span>
                    </div>
                  </td>
                  <td className="px-6 py-3.5 align-middle">
                    <span className={`inline-flex rounded-md px-2.5 py-1 text-[11px] font-semibold leading-none ${getDeadlineClass(urgentRequestItem.deadlineLevel)}`}>
                      {urgentRequestItem.deadlineText}
                    </span>
                  </td>
                  <td className="px-6 py-3.5 text-right align-middle">
                    <button
                      type="button"
                      onClick={() => onOpenDrawer(urgentRequestItem)}
                      className="rounded-md bg-[#1AAE97] px-3 py-1.5 text-[11px] font-bold leading-none text-[#0A5C50] transition hover:bg-[#129b86]"
                    >
                      Xem & Ký
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

