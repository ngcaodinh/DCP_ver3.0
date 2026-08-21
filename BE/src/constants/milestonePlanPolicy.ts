/** Các mốc giải ngân chỉ dùng để minh bạch kế hoạch, không được đọc bởi luồng giải ngân. */
export const MILESTONE_PLAN_ITEMS = [
  { milestoneIndex: 1, milestoneKey: 'M1_ADVANCE' },
  { milestoneIndex: 2, milestoneKey: 'M2_CONSTRUCTION' },
  { milestoneIndex: 3, milestoneKey: 'M3_HANDOVER' }
] as const;

export const MILESTONE_PLAN_TOTAL_PERCENTAGE = 100;
export const MILESTONE_ONE_MAX_PERCENTAGE = 25;
