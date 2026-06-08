import { NavigationItem, ProjectItem, StatisticItem, TimelineItem, TransactionRow } from './types';

export const primaryNavigationItems: NavigationItem[] = [
  { icon: '🏠', label: 'Tổng quan', page: 'dashboard' },
  { icon: '📋', label: 'Dự án của tôi', page: 'projects' }
];

export const financeNavigationItems: NavigationItem[] = [
  { icon: '💰', label: 'Giải ngân', page: 'disbursement' }
];

export const systemNavigationItems: NavigationItem[] = [
  { icon: '🔔', label: 'Thông báo', action: 'toggleNotification' },
  { icon: '⚙️', label: 'Cài đặt', page: 'settings' }
];

export const statisticItems: StatisticItem[] = [
  {
    color: 'emerald',
    icon: '💎',
    label: 'Tổng quyên góp nhận',
    value: '125,4M',
    subtitle: '₫ tương đương',
    change: '↑ +12.4% tháng này',
    changeStyle: 'up'
  },
  {
    color: 'blue',
    icon: '📋',
    label: 'Dự án đang hoạt động',
    value: '3 / 5',
    subtitle: 'Còn 2 slot khả dụng',
    change: '↑ +1 dự án mới',
    changeStyle: 'up'
  },
  {
    color: 'amber',
    icon: '⏳',
    label: 'Đang chờ giải ngân',
    value: '42M ₫',
    subtitle: '1 yêu cầu đang xử lý',
    change: '⏳ Chờ chữ ký (2/3)',
    changeStyle: 'warn'
  },
  {
    color: 'gold',
    icon: '🏆',
    label: 'Xếp hạng QF',
    value: '#4 / 28',
    subtitle: 'Trong chiến dịch hiện tại',
    change: '↑ Tăng 2 bậc',
    changeStyle: 'up'
  }
];

export const organizationProjects: ProjectItem[] = [
  {
    emoji: '📚',
    thumbStyle: 'bg-gradient-to-br from-[#CCFBF1] to-[#A5F3FC]',
    statusLabel: '● ACTIVE',
    statusStyle: 'bg-[#DCFCE7] text-[#166534]',
    name: 'Học bổng vùng cao Tây Bắc',
    description: 'Hỗ trợ 200 học sinh dân tộc thiểu số tiếp cận giáo dục chất lượng',
    progressLabel: '72%',
    progressPercent: 72,
    raisedAmount: '36,000,000 ₫',
    goalAmount: '50,000,000 ₫',
    footerMeta: ['👥 128', '📅 18 ngày', '🏅 #2 QF'],
    statusKey: 'active'
  },
  {
    emoji: '💧',
    thumbStyle: 'bg-gradient-to-br from-[#FEF3C7] to-[#FDE68A]',
    statusLabel: '● ACTIVE',
    statusStyle: 'bg-[#DCFCE7] text-[#166534]',
    name: 'Nước sạch vùng núi Hà Giang',
    description: 'Xây dựng hệ thống lọc nước sạch cho 15 bản làng vùng cao không có nước máy',
    progressLabel: '45%',
    progressPercent: 45,
    raisedAmount: '22,500,000 ₫',
    goalAmount: '50,000,000 ₫',
    footerMeta: ['👥 67', '📅 35 ngày', '🏅 #5 QF'],
    statusKey: 'active'
  },
  {
    emoji: '🏥',
    thumbStyle: 'bg-gradient-to-br from-[#E0E7FF] to-[#BFDBFE]',
    statusLabel: '● PENDING',
    statusStyle: 'bg-[#FEF3C7] text-[#92400E]',
    name: 'Hỗ trợ y tế khẩn cấp miền núi',
    description: 'Cung cấp vật tư y tế và khám sức khỏe định kỳ cho 8 xã vùng sâu.',
    progressLabel: 'Đang duyệt',
    progressPercent: 0,
    raisedAmount: '0 ₫',
    goalAmount: '80,000,000 ₫',
    footerMeta: ['👥 0', '📅 Chưa mở', '🏅 Chờ xếp hạng'],
    statusKey: 'pending'
  },
  {
    emoji: '🌱',
    thumbStyle: 'bg-gradient-to-br from-[#DCFCE7] to-[#BBF7D0]',
    statusLabel: '● DONE',
    statusStyle: 'bg-[#E5E7EB] text-[#374151]',
    name: 'Trồng rừng cộng đồng Quảng Nam',
    description: 'Hoàn thành 5.000 cây xanh và hệ thống tưới tại khu vực đồi trọc.',
    progressLabel: '100%',
    progressPercent: 100,
    raisedAmount: '60,000,000 ₫',
    goalAmount: '60,000,000 ₫',
    footerMeta: ['👥 214', '📅 Đã hoàn thành', '🏅 #1 QF'],
    statusKey: 'done'
  }
];

export const dashboardTimelineItems: TimelineItem[] = [
  { dotStyle: 'bg-[#16A34A] shadow-[0_0_0_3px_rgba(22,163,74,0.15)]', content: 'Nhận 1,200,000 ₫ quyên góp — Dự án Học bổng vùng cao từ 0x9f...2a', time: '5 phút' },
  { dotStyle: 'bg-[#2563EB] shadow-[0_0_0_3px_rgba(37,99,235,0.15)]', content: 'Dự án "Nước sạch vùng núi" vừa được Admin phê duyệt và chuyển sang ACTIVE', time: '2 giờ' },
  { dotStyle: 'bg-[#F59E0B] shadow-[0_0_0_3px_rgba(245,158,11,0.15)]', content: 'Yêu cầu giải ngân #DIS-2025-0047 đang chờ chữ ký (2/3) — Cơ quan giám sát chưa ký', time: 'Hôm qua' }
];

export const transparencyTransactionRows: TransactionRow[] = [
  { time: '14:32 20/05', type: '💚 Quyên góp', amount: '500,000 ₫', sender: '0x3a4F...8b2c', hash: 'a1b2c3...↗', status: '✓ Confirmed', typeStyle: 'bg-[#DCFCE7] text-[#166534]', statusStyle: 'bg-[#DCFCE7] text-[#166534]' },
  { time: '09:05 20/05', type: '🔵 Giải ngân', amount: '15,000,000 ₫', sender: 'Smart Contract', hash: 'g7h8i9...↗', status: '⏳ Pending', typeStyle: 'bg-[#DBEAFE] text-[#1E40AF]', statusStyle: 'bg-[#FEF3C7] text-[#92400E]' },
  { time: '18:44 19/05', type: '💜 Nạp tiền', amount: '5,000,000 ₫', sender: '0x5c7D...9a4e', hash: 'j1k2l3...↗', status: '✓ Confirmed', typeStyle: 'bg-[#F3E8FF] text-[#6B21A8]', statusStyle: 'bg-[#DCFCE7] text-[#166534]' }
];
