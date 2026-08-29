import type { Metadata } from 'next';
import PendingProjectDetailClient from '../../components/governance/PendingProjectDetailClient';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { robots: { index: true, follow: true }, title: 'Chi tiết dự án niêm yết' };

/** Render chi tiết public theo projectId mà không đưa dữ liệu server nội bộ vào HTML. */
export default function PendingProjectDetailPage({ params }: { params: { projectId: string } }) {
  return <PendingProjectDetailClient projectId={params.projectId} />;
}
