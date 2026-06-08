import type { Metadata } from 'next';
import RegulatoryBodiesPageClientTailwind from '../components/regulatoryBodies/RegulatoryBodiesPageClientTailwind';

export const metadata: Metadata = {
  title: 'DCP - Cơ quan giám sát',
  description: 'Trang Cơ quan giám sát sử dụng dữ liệu thật từ backend cho các luồng kiểm duyệt.'
};

/**
 * Hàm trang Cơ quan giám sát.
 * Mục đích: hiển thị giao diện Cơ quan giám sát toàn màn hình bằng component cô lập, không ảnh hưởng các trang khác.
 */
export default function RegulatoryBodiesPage() {
  return <RegulatoryBodiesPageClientTailwind />;
}
