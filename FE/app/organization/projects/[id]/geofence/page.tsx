import type { Metadata } from 'next';
import { GeofenceEditorLazy } from '@/app/components/oracle/GeofenceEditorLazy';

export const metadata: Metadata = {
  title: 'Chỉnh sửa vùng địa lý dự án | DCP',
  description: 'Vẽ và chỉnh sửa ranh giới địa lý (geofence) cho dự án từ thiện.',
};

/**
 * Trang Geofence Editor cho Organization — /organization/projects/[id]/geofence
 * Cho phép tổ chức từ thiện vẽ polygon ranh giới và cài bán kính Haversine.
 * Chỉ org sở hữu dự án mới có quyền lưu (BE kiểm tra ownership + role).
 */
export default async function GeofencePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-6 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-3xl">
        {/* Breadcrumb */}
        <nav className="mb-2 text-xs text-slate-400">
          <a href="/organizations" className="hover:text-slate-600">
            Tổ chức
          </a>
          <span className="mx-1.5">›</span>
          <span className="text-slate-600 font-medium">Chỉnh sửa vùng địa lý</span>
        </nav>

        <div className="mb-6">
          <h1 className="text-2xl font-bold text-slate-900">Vùng địa lý dự án</h1>
          <p className="mt-1 text-sm text-slate-500">
            Vẽ ranh giới polygon và cài bán kính xác minh ảnh minh chứng (Haversine).
            Oracle sẽ dùng vùng này để kiểm tra GPS ảnh upload.
          </p>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <GeofenceEditorLazy projectId={id} />
        </div>
      </div>
    </main>
  );
}
