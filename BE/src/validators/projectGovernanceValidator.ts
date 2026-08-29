import { z } from 'zod';
import { MILESTONE_ONE_MAX_PERCENTAGE, MILESTONE_PLAN_ITEMS, MILESTONE_PLAN_TOTAL_PERCENTAGE } from '../constants/milestonePlanPolicy';
import { capturedEvidencePhotoSchema } from './evidenceCaptureValidator';

/** Kiểm tra đúng ba mốc cố định để UI, API và dữ liệu lưu trữ dùng chung một luật. */
export const milestonePlanSchema = z.array(z.object({
  milestoneIndex: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  milestoneKey: z.enum(['M1_ADVANCE', 'M2_CONSTRUCTION', 'M3_HANDOVER']),
  percentage: z.number().int().min(1).max(100),
  description: z.string().trim().min(10).max(500)
})).length(3).superRefine((items, context) => {
  items.forEach((item, position) => {
    const expected = MILESTONE_PLAN_ITEMS[position];
    if (!expected || item.milestoneIndex !== expected.milestoneIndex || item.milestoneKey !== expected.milestoneKey) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: [position], message: 'Cột mốc phải theo đúng thứ tự M1, M2, M3.' });
    }
  });
  if (items[0] && items[0].percentage > MILESTONE_ONE_MAX_PERCENTAGE) context.addIssue({ code: z.ZodIssueCode.custom, path: [0, 'percentage'], message: 'Cột mốc M1 không được vượt quá 25%.' });
  if (items.reduce((sum, item) => sum + item.percentage, 0) !== MILESTONE_PLAN_TOTAL_PERCENTAGE) context.addIssue({ code: z.ZodIssueCode.custom, path: ['milestonePlan'], message: `Tổng phần trăm phải bằng ${MILESTONE_PLAN_TOTAL_PERCENTAGE}%.` });
});

export const updateMilestonePlanSchema = z.object({ projectId: z.string().trim().min(1), milestonePlan: milestonePlanSchema });
export const projectChallengeSchema = z.object({ projectId: z.string().trim().min(1), reason: z.string().trim().min(30).max(2000), clientSubmittedAt: z.string().datetime(), photos: z.array(capturedEvidencePhotoSchema).max(5).default([]) }).strict();
// Nhánh "đúng sự thật" cố ý không có reason: kết luận xác nhận không mở vụ xét xử nên không cần lập luận.
export const auditorListingVerificationSchema = z.object({
  projectId: z.string().trim().min(1),
  note: z.union([z.string().trim().max(500), z.literal('')]).optional(),
  clientSubmittedAt: z.string().datetime(),
  photos: z.array(capturedEvidencePhotoSchema).min(1).max(5)
}).strict();
const committeeEip712SignatureSchema = z.object({
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
  signingRequestId: z.string().uuid()
});
export const arbitrationVoteSchema = z.object({ arbitrationId: z.string().trim().min(1), decision: z.enum(['UPHOLD_PROJECT', 'REJECT_PROJECT']), reason: z.string().trim().min(10).max(500), markedAbusive: z.boolean().default(false), donationLockRiskAcknowledged: z.boolean().default(false), eip712Signature: committeeEip712SignatureSchema.optional() }).strict();
export const arbitrationSigningPayloadSchema = z.object({ arbitrationId: z.string().trim().min(1), decision: z.enum(['UPHOLD_PROJECT', 'REJECT_PROJECT']), reason: z.string().trim().min(10).max(500) }).strict();
export const arbitrationOnChainDecisionRecoverySchema = z.object({ reason: z.string().trim().min(20).max(500) }).strict();
export const retryActivationSchema = z.object({ projectId: z.string().trim().min(1) });
export const fieldReportSchema = z.object({
  projectId: z.string().trim().min(1),
  note: z.string().trim().min(20).max(2000),
  verifiedMilestoneIndexes: z.array(z.union([z.literal(1), z.literal(2), z.literal(3)])).min(1).max(3).refine(items => new Set(items).size === items.length, 'Không được chọn trùng cột mốc.'),
  clientSubmittedAt: z.string().datetime(),
  photos: z.array(capturedEvidencePhotoSchema).min(1).max(5)
}).strict();

/** Chuẩn hóa lỗi Zod thành chi tiết field quen thuộc của API hiện tại. */
export function validateProjectGovernancePayload<T>(schema: z.ZodType<T>, payload: unknown): { isValid: boolean; data?: T; errors: Array<{ field: string; message: string }> } {
  const parsed = schema.safeParse(payload);
  return parsed.success ? { isValid: true, data: parsed.data, errors: [] } : { isValid: false, errors: parsed.error.issues.map(issue => ({ field: issue.path.join('.'), message: issue.message })) };
}
