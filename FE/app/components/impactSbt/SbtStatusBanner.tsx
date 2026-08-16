import type { ReactElement } from 'react';
import type { ImpactSbtTokenStatus } from '@/app/types/impactSbt';

interface SbtStatusBannerProps {
  tokenStatus: ImpactSbtTokenStatus | null;
  reason: string | null;
}

/** Hiển thị cảnh báo thu hồi token theo đúng trạng thái on-chain public. */
export default function SbtStatusBanner({ tokenStatus, reason }: SbtStatusBannerProps): ReactElement | null {
  if (tokenStatus !== 'REVOKED') return null;

  return (
    <section
      data-testid="sbt-status-banner"
      role="alert"
      className="mb-6 rounded-xl border border-red-200 bg-red-50 p-4 text-red-800"
    >
      <p className="font-semibold">SBT này đã bị thu hồi</p>
      <p className="mt-1 text-sm">
        Lý do: {reason?.trim() || 'Không có lý do được ghi nhận.'}
      </p>
    </section>
  );
}
