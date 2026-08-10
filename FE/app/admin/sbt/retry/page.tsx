import type { Metadata } from 'next';
import type { ReactElement } from 'react';
import SbtRetryPageClient from './SbtRetryPageClient';

export const metadata: Metadata = {
  title: 'SBT Mint Retry | DCP',
  description: 'Quản lý retry các SBT mint job thất bại trong DLQ.'
};

/** Trang quản trị SBT Mint Retry tại /admin/sbt/retry. */
export default function SbtRetryPage(): ReactElement {
  return <SbtRetryPageClient />;
}
