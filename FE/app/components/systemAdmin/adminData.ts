// =============================================================================
// Admin Page Data
// Clone from: FE/app/components/regulatoryBodies/regulatoryBodiesData.ts
// Mục đích: Cung cấp dữ liệu mock cho dashboard của trang Admin
// =============================================================================

export type MetricItem = {
  colorVariant: 'amber' | 'cyan' | 'green' | 'navy';
  value: string;
  label: string;
  trendText: string;
  trendClassName: 'trend-up' | 'trend-dn';
};

export type UrgentRequestItem = {
  id: string;
  projectName: string;
  organizationName: string;
  amountText: string;
  signatureState: '1/3' | '2/3';
  deadlineText: string;
  deadlineClassName: 'urgent' | 'normal' | 'ok';
};

/**
 * Hàm lấy danh sách số liệu tổng quan cho Admin Dashboard.
 * Mục đích: cung cấp dữ liệu thống kê hệ thống cho trang Admin.
 */
export function getMetricItemList(): MetricItem[] {
  return [
    {
      colorVariant: 'amber',
      value: '12',
      label: 'Dự án chờ duyệt',
      trendText: '▲ 3 so với tuần trước',
      trendClassName: 'trend-up',
    },
    {
      colorVariant: 'cyan',
      value: '5',
      label: 'Hồ sơ KYC chờ duyệt',
      trendText: '▼ 1 so với tuần trước',
      trendClassName: 'trend-dn',
    },
    {
      colorVariant: 'green',
      value: '24',
      label: 'Người dùng mới tháng này',
      trendText: '▲ 8 so với tháng trước',
      trendClassName: 'trend-up',
    },
    {
      colorVariant: 'navy',
      value: '6.8T',
      label: 'Tổng giá trị giao dịch (VNĐ)',
      trendText: '▲ 15% so với tháng trước',
      trendClassName: 'trend-up',
    },
  ];
}

/**
 * Hàm lấy danh sách yêu cầu cần xử lý gấp cho Admin.
 * Mục đích: cho phép click mở drawer chi tiết như flow thật.
 */
export function getUrgentRequestItemList(): UrgentRequestItem[] {
  return [
    {
      id: 'REQ-2026-031',
      projectName: 'Mái ấm vùng cao Lào Cai',
      organizationName: 'Quỹ Trẻ Em Việt Xanh',
      amountText: '450,000,000₫',
      signatureState: '1/3',
      deadlineText: '08:32:11',
      deadlineClassName: 'urgent',
    },
    {
      id: 'REQ-2026-028',
      projectName: 'Nước sạch cho miền Tây',
      organizationName: 'Tổ chức Hành Động Xanh',
      amountText: '320,000,000₫',
      signatureState: '2/3',
      deadlineText: '18:24:40',
      deadlineClassName: 'normal',
    },
    {
      id: 'REQ-2026-025',
      projectName: 'Xe cứu thương cộng đồng',
      organizationName: 'Quỹ Nhân Ái Toàn Dân',
      amountText: '150,000,000₫',
      signatureState: '2/3',
      deadlineText: '02 ngày',
      deadlineClassName: 'ok',
    },
  ];
}
