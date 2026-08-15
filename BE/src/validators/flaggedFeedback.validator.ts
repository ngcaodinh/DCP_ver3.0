import { z } from 'zod';

const optionalQueryString = z.preprocess(
  (value: unknown) => Array.isArray(value) ? value[0] : value,
  z.string().trim().min(1).optional()
);

/** Validator cho query list feedback admin, giới hạn mọi filter trước khi truy vấn MongoDB. */
export const flaggedFeedbackListQuerySchema = z.object({
  page: z.preprocess(
    (value: unknown) => Array.isArray(value) ? value[0] : value,
    z.coerce.number().int().min(1).max(10_000).default(1)
  ),
  limit: z.preprocess(
    (value: unknown) => Array.isArray(value) ? value[0] : value,
    z.coerce.number().int().min(1).max(100).default(20)
  ),
  deletionState: z.preprocess(
    (value: unknown) => Array.isArray(value) ? value[0] : value,
    z.enum(['active', 'deleted']).default('active')
  ),
  projectId: optionalQueryString
    .refine(value => value === undefined || value.length <= 64, 'projectId vượt quá giới hạn.')
    .refine(value => value === undefined || /^[A-Za-z0-9_-]+$/.test(value), 'projectId không hợp lệ.'),
  minRiskScore: z.preprocess(
    (value: unknown) => Array.isArray(value) ? value[0] : value,
    z.coerce.number().int().min(0).max(10).optional()
  ),
  source: z.preprocess(
    (value: unknown) => Array.isArray(value) ? value[0] : value,
    z.enum(['batch', 'public']).optional()
  )
});

export type FlaggedFeedbackListQuery = z.infer<typeof flaggedFeedbackListQuerySchema>;

/** Chuẩn hóa reason giống moderation service trước khi kiểm tra biên ký tự. */
function normalizeReason(value: unknown): unknown {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : value;
}

/** Validator dùng chung cho delete và restore với chính sách reason 10–1000 ký tự. */
export const feedbackDeleteBodySchema = z.object({
  reason: z.preprocess(
    normalizeReason,
    z.string().min(10).max(1000)
  )
});
