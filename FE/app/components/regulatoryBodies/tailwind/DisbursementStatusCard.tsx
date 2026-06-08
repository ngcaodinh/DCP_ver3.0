type DisbursementStatusCardProps = {
  fullySignedRequestCount: number;
  partiallySignedRequestCount: number;
  unsignedRequestCount: number;
};

type SigningStatusDistribution = {
  fullySignedPercentage: number;
  partiallySignedPercentage: number;
  unsignedPercentage: number;
};

/** Hàm tính phân bổ phần trăm theo tiến độ chữ ký để card luôn hiển thị dữ liệu thật từ backend. */
function buildSigningStatusDistribution(
  fullySignedRequestCount: number,
  partiallySignedRequestCount: number,
  unsignedRequestCount: number
): SigningStatusDistribution {
  const totalRequestCount = fullySignedRequestCount + partiallySignedRequestCount + unsignedRequestCount;

  if (totalRequestCount <= 0) {
    return {
      fullySignedPercentage: 0,
      partiallySignedPercentage: 0,
      unsignedPercentage: 0
    };
  }

  const fullySignedPercentage = Math.round((fullySignedRequestCount / totalRequestCount) * 100);
  const partiallySignedPercentage = Math.round((partiallySignedRequestCount / totalRequestCount) * 100);
  const unsignedPercentage = Math.max(0, 100 - fullySignedPercentage - partiallySignedPercentage);

  return {
    fullySignedPercentage,
    partiallySignedPercentage,
    unsignedPercentage
  };
}

/** Hàm component DisbursementStatusCard để hiển thị trạng thái ký duyệt hiện tại bằng dữ liệu thật, không dùng mock. */
export default function DisbursementStatusCard({
  fullySignedRequestCount,
  partiallySignedRequestCount,
  unsignedRequestCount
}: DisbursementStatusCardProps) {
  const {
    fullySignedPercentage,
    partiallySignedPercentage,
    unsignedPercentage
  } = buildSigningStatusDistribution(
    fullySignedRequestCount,
    partiallySignedRequestCount,
    unsignedRequestCount
  );

  const circlePerimeterLength = 302;
  const fullySignedStrokeLength = (fullySignedPercentage / 100) * circlePerimeterLength;
  const partiallySignedStrokeLength = (partiallySignedPercentage / 100) * circlePerimeterLength;
  const unsignedStrokeLength = (unsignedPercentage / 100) * circlePerimeterLength;

  return (
    <div className="rounded-xl border border-emerald-900/15 bg-white p-5">
      <h2 className="text-sm font-bold">Tình trạng ký duyệt hiện tại</h2>
      <p className="mt-0.5 text-xs text-slate-500">Phân bổ theo tiến độ chữ ký</p>

      <div className="mt-4 flex flex-col items-center gap-4">
        <div className="relative h-[120px] w-[120px]">
          <svg viewBox="0 0 120 120" className="-rotate-90">
            <circle cx="60" cy="60" r="48" fill="none" stroke="#EAF1F8" strokeWidth="14" />
            <circle
              cx="60"
              cy="60"
              r="48"
              fill="none"
              stroke="#0E9F6E"
              strokeWidth="14"
              strokeDasharray={`${fullySignedStrokeLength} ${circlePerimeterLength}`}
              strokeLinecap="round"
            />
            <circle
              cx="60"
              cy="60"
              r="48"
              fill="none"
              stroke="#1AAE97"
              strokeWidth="14"
              strokeDasharray={`${partiallySignedStrokeLength} ${circlePerimeterLength}`}
              strokeDashoffset={-fullySignedStrokeLength}
              strokeLinecap="round"
            />
            <circle
              cx="60"
              cy="60"
              r="48"
              fill="none"
              stroke="#F59E0B"
              strokeWidth="14"
              strokeDasharray={`${unsignedStrokeLength} ${circlePerimeterLength}`}
              strokeDashoffset={-(fullySignedStrokeLength + partiallySignedStrokeLength)}
              strokeLinecap="round"
            />
          </svg>

          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <p className="font-mono text-xl font-semibold text-slate-900">{fullySignedPercentage}%</p>
            <p className="text-[9px] uppercase tracking-[0.12em] text-slate-500">Đủ chữ ký</p>
          </div>
        </div>

        <div className="w-full space-y-1.5 text-xs">
          <p className="flex items-center justify-between">
            <span className="text-slate-600"><span className="mr-2 inline-block h-2.5 w-2.5 rounded-sm bg-emerald-500" />Đã đủ chữ ký</span>
            <span className="font-mono text-slate-800">{fullySignedPercentage}% · {fullySignedRequestCount}</span>
          </p>
          <p className="flex items-center justify-between">
            <span className="text-slate-600"><span className="mr-2 inline-block h-2.5 w-2.5 rounded-sm bg-cyan-500" />Đã ký một phần</span>
            <span className="font-mono text-slate-800">{partiallySignedPercentage}% · {partiallySignedRequestCount}</span>
          </p>
          <p className="flex items-center justify-between">
            <span className="text-slate-600"><span className="mr-2 inline-block h-2.5 w-2.5 rounded-sm bg-amber-500" />Chưa có chữ ký</span>
            <span className="font-mono text-slate-800">{unsignedPercentage}% · {unsignedRequestCount}</span>
          </p>
        </div>
      </div>
    </div>
  );
}

