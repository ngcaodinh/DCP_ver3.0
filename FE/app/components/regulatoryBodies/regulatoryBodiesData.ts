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
  ipfsCid?: string;
  fileName?: string;
};

/**
 * Hàm lấy danh sách số liệu tổng quan giả lập.
 * Mục đích: cung cấp dữ liệu để hiển thị thẻ thống kê và thao tác UI không cần backend.
 */
export function getMetricItemList(): MetricItem[] {
  return [
    {
      colorVariant: 'amber',
      value: '3',
      label: 'Yêu cầu giải ngân chờ ký',
      trendText: '▲ 2 so với tuần trước',
      trendClassName: 'trend-up'
    },
    {
      colorVariant: 'cyan',
      value: '5',
      label: 'Hồ sơ KYC chờ duyệt',
      trendText: '▼ 1 so với tuần trước',
      trendClassName: 'trend-dn'
    },
    {
      colorVariant: 'green',
      value: '18',
      label: 'Đã ký duyệt tháng này',
      trendText: '▲ 6 so với tháng trước',
      trendClassName: 'trend-up'
    },
    {
      colorVariant: 'navy',
      value: '4.2T',
      label: 'Tổng giá trị giải ngân (VNĐ)',
      trendText: '▲ 12% so với tháng trước',
      trendClassName: 'trend-up'
    }
  ];
}

/**
 * Hàm lấy danh sách yêu cầu cần xử lý gấp giả lập.
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
      ipfsCid: 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
      fileName: 'Biên bản nghiệm thu.pdf'
    },
    {
      id: 'REQ-2026-028',
      projectName: 'Nước sạch cho miền Tây',
      organizationName: 'Tổ chức Hành Động Xanh',
      amountText: '320,000,000₫',
      signatureState: '2/3',
      deadlineText: '18:24:40',
      deadlineClassName: 'normal',
      ipfsCid: 'bafybeiczsscdsbs7ffqz55asqdf3smv6klcw3gofszvwlyarci47bgf354',
      fileName: 'Hình ảnh hiện trường.jpg'
    },
    {
      id: 'REQ-2026-025',
      projectName: 'Xe cứu thương cộng đồng',
      organizationName: 'Quỹ Nhân Ái Toàn Dân',
      amountText: '150,000,000₫',
      signatureState: '2/3',
      deadlineText: '02 ngày',
      deadlineClassName: 'ok',
      ipfsCid: 'bafybeia2v2ktdrt7y7wtsg7oobfntmng2rpx6x53wftndx3hck6563snnq',
      fileName: 'Hợp đồng liên kết.pdf'
    }
  ];
}
