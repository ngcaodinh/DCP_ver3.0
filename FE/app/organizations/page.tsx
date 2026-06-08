import type { Metadata } from 'next';
import OrganizationsPageView from '../components/organizations/OrganizationsPageView';

export const metadata: Metadata = {
  title: 'Tổ chức từ thiện',
  description:
    'Khám phá các tổ chức từ thiện minh bạch trên DCP, theo dõi hồ sơ hoạt động và mức độ tin cậy on-chain.',
  alternates: {
    canonical: '/organizations'
  },
  openGraph: {
    title: 'Tổ chức từ thiện | DCP',
    description:
      'Khám phá các tổ chức từ thiện minh bạch trên DCP, theo dõi hồ sơ hoạt động và mức độ tin cậy on-chain.',
    url: '/organizations'
  }
};

/** Hàm trang Organizations. Mục đích: hiển thị layout Organizations đầy đủ. */
export default function OrganizationsPage() {
  return <OrganizationsPageView />;
}
