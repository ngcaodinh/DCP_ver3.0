import { z } from 'zod';

/**
 * Schema cho request body của POST /api/oracle/sbt-trigger.
 * Mục đích: validate payload từ Oracle service khi trigger mint SBT.
 *
 * Ràng buộc:
 * - verificationId: unique ID từ oracle verification results
 * - projectIdNumeric: uint256 tương ứng projectId trên contract
 * - beneficiaryAddress: EVM address hợp lệ (sẽ normalize về lowercase)
 * - Các trường GPS/imageCid/tokenUri phải là chuỗi không rỗng
 */
export const sbtTriggerBodySchema = z.object({
  verificationId: z.string().trim().min(1, 'verificationId là bắt buộc.'),
  projectId: z.string().trim().min(1, 'projectId là bắt buộc.'),
  organizationId: z.string().trim().min(1, 'organizationId là bắt buộc.'),
  beneficiaryAddress: z.string()
    .trim()
    .min(1, 'beneficiaryAddress là bắt buộc.')
    .regex(/^0x[a-fA-F0-9]{40}$/, 'beneficiaryAddress phải là địa chỉ EVM hợp lệ (0x + 40 hex).'),
  projectIdNumeric: z.number().int().nonnegative('projectIdNumeric phải là số nguyên không âm.'),
  milestone: z.number().int().nonnegative('milestone phải là số nguyên không âm.').default(0),
  beneficiaryCount: z.number().int().nonnegative('beneficiaryCount phải là số nguyên không âm.').default(0),
  gpsCoordinates: z.string().default(''),
  imageCid: z.string().trim().min(1, 'imageCid là bắt buộc.'),
  tokenUri: z.string().trim().min(1, 'tokenUri là bắt buộc.')
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
