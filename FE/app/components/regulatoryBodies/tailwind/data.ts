import { getMetricItemList, getUrgentRequestItemList } from '../regulatoryBodiesData';
import type { AuditLogItem, NavigationItem, SybilUser, TimelineItem, UrgentRequestItem } from './types';

export const navigationItemList: NavigationItem[] = [
  { key: 'dashboard', label: 'Tổng quan', iconPath: 'M2 2h5v5H2zm7 0h5v5H9zm-7 7h5v5H2zm7 0h5v5H9z' },
  { key: 'projectReview', label: 'Duyệt dự án mới', badge: 0, iconPath: 'M3 2h10a1 1 0 011 1v10a1 1 0 01-1 1H3a1 1 0 01-1-1V3a1 1 0 011-1zm2 3h6v1.5H5zm0 3h4v1.5H5zm5.8 1.2l2 2-3.2 3.2H7.5V12.4z' },
  { key: 'disbursement', label: 'Ký duyệt Giải ngân', badge: 3, iconPath: 'M13 2H3a1 1 0 00-1 1v10a1 1 0 001 1h10a1 1 0 001-1V3a1 1 0 00-1-1zM8 11l-4-4 1.4-1.4L8 8.2l4.6-4.6L14 5z' },
  { key: 'kyc', label: 'Duyệt Hồ sơ KYC', badge: 5, iconPath: 'M4 1h8a1 1 0 011 1v12a1 1 0 01-1 1H4a1 1 0 01-1-1V2a1 1 0 011-1zm1 3v1h6V4zm0 3v1h6V7zm0 3v1h4v-1z' },
  { key: 'bankAccountApproval', label: 'Duyệt tài khoản ngân hàng', badge: 0, iconPath: 'M2 6l6-4 6 4v2H2zm1 3h2v4H3zm4 0h2v4H7zm4 0h2v4h-2zM2 14h12v1H2z' },
  { key: 'foundationKyc', label: 'Duyệt pháp nhân đại diện', badge: 0, iconPath: 'M8 1l6 3v3c0 3.5-2.3 6.7-6 8-3.7-1.3-6-4.5-6-8V4l6-3zm-2 7l1.5 1.5L11 6.5' },
  { key: 'report', label: 'Báo cáo Tuân thủ', iconPath: 'M2 2h12v12H2zm2 2v3h3V4zm5 0v2h2V4zm-5 5v3h8V9zm0-2h8V6H4z' },
  { key: 'sybilManagement', label: 'Quản lý Sybil Attack', badge: 2, iconPath: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9zm1.41-8.41L9.41 10.59 7 13l4 4 4-4-2.41-2.41z' }
];

export const auditLogItemList: AuditLogItem[] = [
  { transactionId: '0x91a3f2bc76d0f19b', requestId: 'REQ-2026-031', amountText: '450,000,000₫', statusText: 'Đã ký', actorText: 'Bộ Tài chính', timeText: '14:28:10' },
  { transactionId: '0x83bc9d10af4201e7', requestId: 'REQ-2026-028', amountText: '320,000,000₫', statusText: 'Chờ ký', actorText: 'Tổ chức Hành Động Xanh', timeText: '13:55:47' },
  { transactionId: '0x67aa20ce9b1138d4', requestId: 'REQ-2026-025', amountText: '150,000,000₫', statusText: 'Đã ký', actorText: 'Quỹ Nhân Ái Toàn Dân', timeText: '11:20:31' },
  { transactionId: '0x245be92f91ba7720', requestId: 'REQ-2026-019', amountText: '980,000,000₫', statusText: 'Bị từ chối', actorText: 'Bộ Tài chính', timeText: '09:13:54' }
];

export const timelineItemList: TimelineItem[] = [
  { actionText: 'Ký duyệt yêu cầu', detailText: 'REQ-2026-028 · Nước sạch cho miền Tây', timeText: '2 phút trước', type: 'sign' },
  { actionText: 'Xem hồ sơ KYC', detailText: 'ORG-55 · Quỹ Trẻ Em Việt Xanh', timeText: '15 phút trước', type: 'view' },
  { actionText: 'Từ chối yêu cầu', detailText: 'REQ-2026-019 · Chưa đủ hồ sơ chứng minh', timeText: '37 phút trước', type: 'reject' },
  { actionText: 'Đăng nhập hệ thống', detailText: 'Thiết bị Chrome · Hà Nội', timeText: '42 phút trước', type: 'login' }
];

/** Hàm trả về dữ liệu metric gốc để dùng lại trong UI Tổng quan. */
export function getDashboardMetricItemList() {
  return getMetricItemList();
}

/** Hàm ánh xạ dữ liệu yêu cầu gấp sang kiểu dữ liệu cho bảng Tailwind. */
export function getDashboardUrgentRequestItemList(): UrgentRequestItem[] {
  return getUrgentRequestItemList().map(item => ({
    id: item.id,
    projectName: item.projectName,
    organizationName: item.organizationName,
    amountText: item.amountText,
    signatureState: item.signatureState,
    deadlineText: item.deadlineText,
    deadlineLevel: item.deadlineClassName,
    ipfsCid: item.ipfsCid,
    fileName: item.fileName
  }));
}
/** Mock data cho 5 tiêu chí phát hiện Sybil theo document.md. */
export const sybilRiskCriteriaMockData = [
  { criteriaKey: 'ipCorrelation', labelText: 'Tương quan IP', descriptionText: 'Nhiều ví (>5) quyên góp từ cùng IP trong 1 giờ → +30 điểm risk', maxScore: 30, weight: 0.30 },
  { criteriaKey: 'timePattern', labelText: 'Mẫu thời gian', descriptionText: 'Donations diễn ra cùng lúc (±5 giây) t? Nhiều ví → +25 điểm risk', maxScore: 25, weight: 0.25 },
  { criteriaKey: 'amountPattern', labelText: 'Cấu trúc số tiền', descriptionText: 'Các ví quyên góp số tiền giống hệt nhau → +20 điểm risk', maxScore: 20, weight: 0.20 },
  { criteriaKey: 'deviceFingerprint', labelText: 'Device Fingerprint', descriptionText: 'Nhiều ví dùng chung browser fingerprint → +15 điểm risk', maxScore: 15, weight: 0.15 },
  { criteriaKey: 'socialVerification', labelText: 'Xác minh Social', descriptionText: 'Ví không có Social Login backing → +10 điểm risk', maxScore: 10, weight: 0.10 }
];

/** Mock data cho người dùng bị nghi ngờ Sybil — dùng trong bảng quản lý. */
export const sybilUserMockData = [
  {
    userId: 'USR-001-FR5',
    walletAddress: '0xA1B2C3D4E5F6789012345678901234567890ABCD',
    displayName: 'Anonymous Donor #4421',
    email: 'anon4421@temp-mail.dev',
    role: 'donor',
    isSybil: true,
    riskLevel: 'critical' as const,
    totalRiskScore: 85,
    totalDonations: 12,
    totalDonationAmount: 18000000,
    donationCount: 12,
    firstActivity: '2026-03-15T08:23:00Z',
    lastActivity: '2026-03-22T14:05:00Z',
    ipAddresses: ['103.245.78.91', '103.245.78.92', '103.245.78.93'],
    deviceFingerprint: 'chrome_120_win10_1920x1080',
    riskFactors: [
      { factorName: 'Tương quan IP', factorKey: 'ipCorrelation' as const, score: 30, maxScore: 30, description: '12 ví quyên góp từ cùng IP trong 45 phút' },
      { factorName: 'Mẫu thời gian', factorKey: 'timePattern' as const, score: 25, maxScore: 25, description: '8 giao dịch cùng thời điểm ±3 giây' },
      { factorName: 'Cấu trúc số tiền', factorKey: 'amountPattern' as const, score: 20, maxScore: 20, description: 'Tất cả donation = 1,500,000 VND' },
      { factorName: 'Device Fingerprint', factorKey: 'deviceFingerprint' as const, score: 10, maxScore: 15, description: 'Chung fingerprint với 3 ví khác' }
    ],
    donationHistory: [
      { donationId: 'DN-001-FR5', projectId: 'PRJ-2026-001', projectName: 'Xây trường học Tây Nguyên', amount: 1500000, amountText: '₫1,500,000', timestamp: '2026-03-22T14:05:00Z', txHash: '0x3A9F2C1B4E5D7788A1F2B3C4D5E6F7A8B9C0D1E2', walletAddress: '0xA1B2C3D4E5F6789012345678901234567890ABCD', isAnonymous: true, ipAddress: '103.245.78.91' },
      { donationId: 'DN-002-FR5', projectId: 'PRJ-2026-001', projectName: 'Xây trường học Tây Nguyên', amount: 1500000, amountText: '₫1,500,000', timestamp: '2026-03-22T14:05:03Z', txHash: '0x4B0E3D2C5F6E7891A2B3C4D5E6F7A8B9C0D1E2F3', walletAddress: '0xA1B2C3D4E5F6789012345678901234567890ABCD', isAnonymous: true, ipAddress: '103.245.78.91' },
      { donationId: 'DN-003-FR5', projectId: 'PRJ-2026-002', projectName: 'Nước sạch Hà Tĩnh', amount: 1500000, amountText: '₫1,500,000', timestamp: '2026-03-21T10:33:00Z', txHash: '0x5C1F4E3D6F7E8901A2B3C4D5E6F7A8B9C0D1E2F3A4', walletAddress: '0xA1B2C3D4E5F6789012345678901234567890ABCD', isAnonymous: true, ipAddress: '103.245.78.92' },
      { donationId: 'DN-004-FR5', projectId: 'PRJ-2026-003', projectName: 'Cứu trợ lũ lụt miền Trung', amount: 1500000, amountText: '₫1,500,000', timestamp: '2026-03-20T09:15:00Z', txHash: '0x6D2G5F4E7G8F9012A3B4C5D6E7F8A9B0C1D2E3F4A5', walletAddress: '0xA1B2C3D4E5F6789012345678901234567890ABCD', isAnonymous: true, ipAddress: '103.245.78.93' }
    ],
    createdAt: '2026-03-15T08:23:00Z',
    reviewedAt: '2026-03-22T16:00:00Z',
    reviewedBy: 'Bộ Tài chính',
    reviewNote: 'Đã đánh dấu Sybil. Tất cả 12 donation trùng số tiền và thời gian.'
  },
  {
    userId: 'USR-002-FR5',
    walletAddress: '0xB2C3D4E5F6A789012345678901234567890ABCDEF',
    displayName: 'Wallet Sybil #2',
    email: 'sybil2@proton.sh',
    role: 'donor',
    isSybil: true,
    riskLevel: 'high' as const,
    totalRiskScore: 68,
    totalDonations: 8,
    totalDonationAmount: 12000000,
    donationCount: 8,
    firstActivity: '2026-03-18T11:45:00Z',
    lastActivity: '2026-03-21T16:30:00Z',
    ipAddresses: ['203.113.145.88'],
    deviceFingerprint: 'chrome_121_macOS',
    riskFactors: [
      { factorName: 'Tương quan IP', factorKey: 'ipCorrelation' as const, score: 30, maxScore: 30, description: '8 ví quyên góp từ cùng /24 subnet trong 30 phút' },
      { factorName: 'Mẫu thời gian', factorKey: 'timePattern' as const, score: 20, maxScore: 25, description: '5 giao dịch trong cùng block' },
      { factorName: 'Cấu trúc số tiền', factorKey: 'amountPattern' as const, score: 18, maxScore: 20, description: '7/8 donation = 1,500,000 VND' }
    ],
    donationHistory: [
      { donationId: 'DN-005-FR5', projectId: 'PRJ-2026-001', projectName: 'Xây trường học Tây Nguyên', amount: 1500000, amountText: '₫1,500,000', timestamp: '2026-03-21T16:30:00Z', txHash: '0x7E3H6G5H8I0123B4C5D6E7F8A9B0C1D2E3F4A5B6', walletAddress: '0xB2C3D4E5F6A789012345678901234567890ABCDEF', isAnonymous: false, ipAddress: '203.113.145.88' },
      { donationId: 'DN-006-FR5', projectId: 'PRJ-2026-002', projectName: 'Nước sạch Hà Tĩnh', amount: 2000000, amountText: '₫2,000,000', timestamp: '2026-03-19T14:12:00Z', txHash: '0x8F4I7H6I9J1234C5D6E7F8A9B0C1D2E3F4A5B6C7', walletAddress: '0xB2C3D4E5F6A789012345678901234567890ABCDEF', isAnonymous: false, ipAddress: '203.113.145.88' }
    ],
    createdAt: '2026-03-18T11:45:00Z',
    reviewedAt: null,
    reviewedBy: null,
    reviewNote: null
  },
  {
    userId: 'USR-003-FR5',
    walletAddress: '0xC3D4E5F6A7B890123456789012345678901BCDEF',
    displayName: 'Green Fund Donor',
    email: 'greenfund@example.com',
    role: 'donor',
    isSybil: false,
    riskLevel: 'medium' as const,
    totalRiskScore: 35,
    totalDonations: 3,
    totalDonationAmount: 5000000,
    donationCount: 3,
    firstActivity: '2026-03-10T09:00:00Z',
    lastActivity: '2026-03-20T15:00:00Z',
    ipAddresses: ['202.134.15.77'],
    deviceFingerprint: 'safari_17_macOS',
    riskFactors: [
      { factorName: 'Cấu trúc số tiền', factorKey: 'amountPattern' as const, score: 15, maxScore: 20, description: '2/3 donation cùng số tiền tròn' },
      { factorName: 'Xác minh Social', factorKey: 'socialVerification' as const, score: 10, maxScore: 10, description: 'Không có social login' },
      { factorName: 'Tương quan IP', factorKey: 'ipCorrelation' as const, score: 10, maxScore: 30, description: '2 ví gần địa chỉ IP' }
    ],
    donationHistory: [
      { donationId: 'DN-007-FR5', projectId: 'PRJ-2026-003', projectName: 'Cứu trợ lũ lụt miền Trung', amount: 1000000, amountText: '₫1,000,000', timestamp: '2026-03-20T15:00:00Z', txHash: '0x9G5J8I7J0K2345D6E7F8A9B0C1D2E3F4A5B6C7D8', walletAddress: '0xC3D4E5F6A7B890123456789012345678901BCDEF', isAnonymous: false, ipAddress: '202.134.15.77' },
      { donationId: 'DN-008-FR5', projectId: 'PRJ-2026-004', projectName: 'Mổ mắt miễn phí Hà Giang', amount: 2000000, amountText: '₫2,000,000', timestamp: '2026-03-15T11:30:00Z', txHash: '0xAH6K9J8K1L3456E7F8A9B0C1D2E3F4A5B6C7D8E9', walletAddress: '0xC3D4E5F6A7B890123456789012345678901BCDEF', isAnonymous: false, ipAddress: '202.134.15.77' }
    ],
    createdAt: '2026-03-10T09:00:00Z',
    reviewedAt: null,
    reviewedBy: null,
    reviewNote: null
  },
  {
    userId: 'USR-004-FR5',
    walletAddress: '0xD4E5F6A7B8C901234567890123456789012CDEFG',
    displayName: 'Honest Contributor',
    email: 'contributor@gmail.com',
    role: 'donor',
    isSybil: false,
    riskLevel: 'low' as const,
    totalRiskScore: 5,
    totalDonations: 2,
    totalDonationAmount: 10000000,
    donationCount: 2,
    firstActivity: '2026-03-01T10:00:00Z',
    lastActivity: '2026-03-18T08:30:00Z',
    ipAddresses: ['118.70.45.123'],
    deviceFingerprint: 'chrome_120_win11',
    riskFactors: [
      { factorName: 'Xác minh Social', factorKey: 'socialVerification' as const, score: 5, maxScore: 10, description: 'Google OAuth nhung không xác minh đầy đủ' }
    ],
    donationHistory: [
      { donationId: 'DN-009-FR5', projectId: 'PRJ-2026-001', projectName: 'Xây trường học Tây Nguyên', amount: 5000000, amountText: '₫5,000,000', timestamp: '2026-03-18T08:30:00Z', txHash: '0xBI7L9K8L2M4567F8A9B0C1D2E3F4A5B6C7D8E9F0', walletAddress: '0xD4E5F6A7B8C901234567890123456789012CDEFG', isAnonymous: false, ipAddress: '118.70.45.123' }
    ],
    createdAt: '2026-03-01T10:00:00Z',
    reviewedAt: null,
    reviewedBy: null,
    reviewNote: null
  },
  {
    userId: 'USR-005-FR5',
    walletAddress: '0xE5F6A7B8C9D012345678901234567890123DEFGH',
    displayName: 'Suspicious Multi-Wallet',
    email: 'multiwallet@outlook.com',
    role: 'donor',
    isSybil: false,
    riskLevel: 'high' as const,
    totalRiskScore: 55,
    totalDonations: 6,
    totalDonationAmount: 9000000,
    donationCount: 6,
    firstActivity: '2026-03-12T13:00:00Z',
    lastActivity: '2026-03-21T18:00:00Z',
    ipAddresses: ['210.245.88.110', '210.245.88.111', '210.245.88.112'],
    deviceFingerprint: 'firefox_122_ubuntu',
    riskFactors: [
      { factorName: 'Tương quan IP', factorKey: 'ipCorrelation' as const, score: 25, maxScore: 30, description: '6 ví từ 3 IP liền kề trong cùng subnet' },
      { factorName: 'Mẫu thời gian', factorKey: 'timePattern' as const, score: 15, maxScore: 25, description: '4 donation cùng khung giờ 14:00-15:00' },
      { factorName: 'Cấu trúc số tiền', factorKey: 'amountPattern' as const, score: 15, maxScore: 20, description: '5/6 donation chia hết cho 500,000 VND' }
    ],
    donationHistory: [
      { donationId: 'DN-010-FR5', projectId: 'PRJ-2026-002', projectName: 'Nước sạch Hà Tĩnh', amount: 1500000, amountText: '₫1,500,000', timestamp: '2026-03-21T14:22:00Z', txHash: '0xCJ8M0L9M3N5678G8A9B0C1D2E3F4A5B6C7D8E9F0G1', walletAddress: '0xE5F6A7B8C9D012345678901234567890123DEFGH', isAnonymous: true, ipAddress: '210.245.88.110' },
      { donationId: 'DN-011-FR5', projectId: 'PRJ-2026-001', projectName: 'Xây trường học Tây Nguyên', amount: 2000000, amountText: '₫2,000,000', timestamp: '2026-03-19T14:45:00Z', txHash: '0xDK9N1M0N4O6789H9B0C1D2E3F4A5B6C7D8E9F0G1H2', walletAddress: '0xE5F6A7B8C9D012345678901234567890123DEFGH', isAnonymous: true, ipAddress: '210.245.88.111' }
    ],
    createdAt: '2026-03-12T13:00:00Z',
    reviewedAt: null,
    reviewedBy: null,
    reviewNote: null
  }
];

/** Mock data summary metrics cho Sybil management dashboard. */
export const sybilSummaryMetricsMockData = [
  { labelText: 'Tổng người dùng bị đánh dấu', valueText: '2', toneClassName: 'text-red-700 bg-red-50 border-red-100' },
  { labelText: 'Đang chờ xem xét', valueText: '3', toneClassName: 'text-amber-700 bg-amber-50 border-amber-100' },
  { labelText: 'Tổng quyên góp bị ảnh hưởng', valueText: '29', toneClassName: 'text-cyan-700 bg-cyan-50 border-cyan-100' },
  { labelText: 'Tổng giá trị (VNĐ)', valueText: '₫44M', toneClassName: 'text-slate-700 bg-slate-50 border-slate-100' }
];

/** Hàm lấy danh sách mock user để hiển thị trong bảng Sybil. */
export function getSybilUserList(): SybilUser[] {
  return sybilUserMockData;
}

