import { z } from 'zod';

const manualReviewRequestIdSchema = z.string().trim().min(1).max(120);

export const manualReviewParamsSchema = z.object({
  id: manualReviewRequestIdSchema
});

export const manualReviewDetailQuerySchema = z.object({
  revealBankAccount: z.enum(['true', 'false']).default('false').transform(value => value === 'true')
});

export const manualReviewPendingQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).transform(value => Math.min(value, 50)).default(50)
});

export const manualReviewRejectBodySchema = z.object({
  reason: z.string().trim().min(10).max(1000)
});

export type ManualReviewPendingQuery = z.infer<typeof manualReviewPendingQuerySchema>;
export type ManualReviewParams = z.infer<typeof manualReviewParamsSchema>;
export type ManualReviewDetailQuery = z.infer<typeof manualReviewDetailQuerySchema>;
export type ManualReviewRejectBody = z.infer<typeof manualReviewRejectBodySchema>;
