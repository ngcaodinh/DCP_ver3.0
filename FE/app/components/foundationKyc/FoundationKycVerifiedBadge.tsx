'use client';

import { useFoundationKycStatus } from '@/app/hooks/useFoundationKycStatus';

/** Hiển thị badge tài khoản nhận quyên góp đã được xác minh khi backend trả trạng thái VERIFIED hợp lệ. */
export default function FoundationKycVerifiedBadge(): React.ReactElement | null {
  const statusQuery = useFoundationKycStatus();
  const status = statusQuery.data;
  if (statusQuery.isError || status?.status !== 'VERIFIED' || !status.verifiedAt) return null;

  const verifiedDate = new Date(status.verifiedAt);
  if (Number.isNaN(verifiedDate.getTime())) return null;

  return (
    <div className="mb-6 flex items-start gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3.5 text-sm text-emerald-900 shadow-sm">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-sm font-bold text-white" aria-hidden="true">✓</span>
      <div><p className="font-bold">Tài khoản nhận quyên góp đã được xác minh</p><p className="mt-0.5 text-xs leading-5 text-emerald-800"><span className="font-semibold">{status.organizationName || 'Quỹ từ thiện — Pháp nhân đại diện'}</span> · Cơ quan giám sát xác minh ngày {verifiedDate.toLocaleDateString('vi-VN')}</p></div>
    </div>
  );
}
