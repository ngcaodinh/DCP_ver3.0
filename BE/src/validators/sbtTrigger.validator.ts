import { z } from 'zod';

/**
 * Schema cho request body của POST /api/oracle/sbt-trigger.
 * Mục đích: validate payload từ Oracle service khi trigger mint SBT.
 *
 * Ràng buộc:
 * - verificationId: unique ID từ oracle verification results
 * - Không nhận beneficiary/GPS/token URI từ request; các giá trị mint phải được derive từ DB.
 */
export const sbtTriggerBodySchema = z.object({
  verificationId: z.string().trim().min(1, 'verificationId là bắt buộc.')
});

export type SbtTriggerBody = z.infer<typeof sbtTriggerBodySchema>;

/**
 * Hàm chuẩn hóa lỗi validate từ Zod cho sbt-trigger body.
 * Mục đích: tái sử dụng format lỗi nhất quán với các validator khác.
 */
export function formatSbtTriggerValidationResult<T>(
  parsedResult: z.SafeParseReturnType<unknown, T>
) {
  if (!parsedResult.success) {
    return {
      isValid: false as const,
      errors: parsedResult.error.issues.map((issue: z.ZodIssue) => ({
        field: issue.path.join('.') || 'body',
        message: issue.message
      }))
    };
  }
  return {
    isValid: true as const,
    data: parsedResult.data,
    errors: [] as { field: string; message: string }[]
  };
}

/**
 * Hàm validate request body cho sbt-trigger endpoint.
 */
export function validateSbtTriggerBody(payload: unknown) {
  return formatSbtTriggerValidationResult(sbtTriggerBodySchema.safeParse(payload));
}
