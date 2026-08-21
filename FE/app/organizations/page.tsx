import type { Metadata } from 'next';
import OrganizationsPageView from '../components/organizations/OrganizationsPageView';
import type { OrganizationPageKey } from '../components/organizations/types';

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

/** Hàm trang Organizations. Mục đích: hiển thị layout Organizations và khởi tạo tab hợp lệ từ URL. */
export default async function OrganizationsPage({
  searchParams
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { tab } = await searchParams;
  const initialPage: OrganizationPageKey = tab === 'projects' ? 'projects' : 'dashboard';

  return <OrganizationsPageView initialPage={initialPage} />;
}
