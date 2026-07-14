import type { Metadata } from 'next';
import TransparencyDashboardClient from '../components/transparency/TransparencyDashboardClient';

export const metadata: Metadata = {
  title: 'Minh bạch dòng tiền',
  description:
    'Theo dõi dòng tiền minh bạch trên DCP: nạp VND, phát hành token, quyên góp và giải ngân, đối soát on-chain theo thời gian thực.',
  alternates: {
    canonical: '/transparency'
  },
  openGraph: {
    title: 'Minh bạch dòng tiền | DCP',
    description:
      'Theo dõi dòng tiền minh bạch trên DCP: nạp VND, phát hành token, quyên góp và giải ngân, đối soát on-chain theo thời gian thực.',
    url: '/transparency'
  }
};

/**
 * Hàm trang Minh bạch dòng tiền.
 * Mục đích: render bảng minh bạch (timeline + donut) qua component client cô lập.
 */
export default function TransparencyPage() {
  return <TransparencyDashboardClient />;
}
