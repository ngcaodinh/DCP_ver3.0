import PendingProjectsClient from '../components/governance/PendingProjectsClient';
import type { ReactElement } from 'react';
import type { Metadata } from 'next';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { robots: { index: true, follow: true }, title: 'Dự án chờ kích hoạt' };

/** Hiển thị trang niêm yết công khai cho cửa sổ rà soát trước khi dự án được kích hoạt. */
export default function PendingProjectsPage(): ReactElement {
  return <PendingProjectsClient />;
}
