/** Các role dành riêng cho luồng quản trị dự án và không tham gia quyền on-chain. */
export const AUDITOR_ROLE = 'auditor';
export const ADMIN_ROLE = 'admin';
export const EXECUTIVE_CHAIR_ROLE = 'executive_chair';
export const EXECUTIVE_MEMBER_ROLE = 'executive_member';
export const EXECUTIVE_VOTER_ROLES = [EXECUTIVE_CHAIR_ROLE, EXECUTIVE_MEMBER_ROLE] as const;

/** Chính sách ghế biểu quyết được snapshot khi mở vụ việc để không đổi luật giữa chừng. */
export const EXECUTIVE_COMMITTEE_POLICY = {
  requiredChairVotes: 1,
  expectedMemberSeats: 4,
  requiredMemberVotes: 2,
  // Alias nội bộ giữ tương thích cho các consumer đã dùng tên ngắn trước đó.
  chairCount: 1,
  memberCount: 4
} as const;
