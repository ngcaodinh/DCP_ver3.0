import { z } from 'zod';

/** Chuẩn hóa query string đơn hoặc mảng về giá trị đầu tiên trước khi validate. */
function firstQueryValue(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}

const optionalQueryString = z.preprocess(
  firstQueryValue,
  z.string().trim().min(1).optional()
);

/** Validator cho bộ lọc feedback của chính tổ chức, giới hạn chặt trước khi truy vấn MongoDB. */
export const organizationFeedbackListQuerySchema = z.object({
  page: z.preprocess(
    firstQueryValue,
    z.coerce.number().int().min(1).max(10_000).default(1)
  ),
  limit: z.preprocess(
    firstQueryValue,
    z.coerce.number().int().min(1).max(100).default(20)
  ),
  projectId: optionalQueryString
    .refine(value => value === undefined || value.length <= 64, 'projectId vượt quá giới hạn.')
    .refine(value => value === undefined || /^[A-Za-z0-9_-]+$/.test(value), 'projectId không hợp lệ.'),
  source: z.preprocess(
    firstQueryValue,
    z.enum(['batch', 'public']).optional()
  ),
  moderationState: z.preprocess(
    firstQueryValue,
    z.enum(['all', 'visible', 'pending']).default('all')
  )
});

export type OrganizationFeedbackListQuery = z.infer<typeof organizationFeedbackListQuerySchema>;
