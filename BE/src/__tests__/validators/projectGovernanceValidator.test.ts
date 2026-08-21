import { describe, expect, it } from 'vitest';
import { fieldReportSchema, milestonePlanSchema, projectChallengeSchema } from '../../validators/projectGovernanceValidator';

/** Tạo plan chuẩn để từng test chỉ thay đổi đúng một luật nghiệp vụ. */
function plan() {
  return [
    { milestoneIndex: 1, milestoneKey: 'M1_ADVANCE', percentage: 25, description: 'Chuẩn bị vật tư và khởi động công trình.' },
    { milestoneIndex: 2, milestoneKey: 'M2_CONSTRUCTION', percentage: 45, description: 'Thi công phần móng, khung và hạng mục chính.' },
    { milestoneIndex: 3, milestoneKey: 'M3_HANDOVER', percentage: 30, description: 'Nghiệm thu hoàn thiện và bàn giao địa phương.' }
  ];
}

describe('project governance validation', () => {
  it('accepts the exactly ordered 25/45/30 milestone plan', () => expect(milestonePlanSchema.safeParse(plan()).success).toBe(true));
  it('rejects a plan without exactly three milestones', () => expect(milestonePlanSchema.safeParse(plan().slice(0, 2)).success).toBe(false));
  it('rejects M1 above 25 percent', () => { const value = plan(); value[0].percentage = 26; value[1].percentage = 44; expect(milestonePlanSchema.safeParse(value).success).toBe(false); });
  it('rejects a total other than 100 percent', () => { const value = plan(); value[2].percentage = 29; expect(milestonePlanSchema.safeParse(value).success).toBe(false); });
  it('rejects reordered milestone identity', () => { const value = plan(); value[1].milestoneKey = 'M3_HANDOVER'; expect(milestonePlanSchema.safeParse(value).success).toBe(false); });
  it('rejects duplicate verified milestones and invalid challenge evidence CID', () => {
    expect(fieldReportSchema.safeParse({ projectId: 'p', note: 'Ghi chú hiện trường đủ dài và chi tiết.', verifiedMilestoneIndexes: [1, 1], photos: [{ fileName: 'a.jpg', mimeType: 'image/jpeg', contentBase64: 'YWJj' }] }).success).toBe(false);
    expect(projectChallengeSchema.safeParse({ projectId: 'p', reason: 'Lý do khiếu nại đủ dài hơn ba mươi ký tự.', evidenceCids: ['not-ipfs'] }).success).toBe(false);
  });
});
