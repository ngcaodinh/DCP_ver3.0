import { z } from 'zod';
import type { Request, Response, NextFunction } from 'express';

/**
 * Schema cho pagination query params (dùng chung cho DLQ list).
 */
export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(500).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().trim().regex(/^[A-Za-z0-9_-]{1,256}$/).optional(),
  status: z.enum(['OPEN', 'RECOVERED', 'ABANDONED']).optional()
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

/**
 * Schema cho mintRequestId path param (dùng cho retry-job endpoint).
 */
export const mintRequestIdParamSchema = z.object({
  mintRequestId: z.string().trim().min(1, 'mintRequestId là bắt buộc.')
});

export type MintRequestIdParam = z.infer<typeof mintRequestIdParamSchema>;

/**
 * Hàm chuẩn hóa lỗi validate từ Zod.
 * Mục đích: tái sử dụng cho nhiều API endpoint.
 */
function formatZodValidationResult<T>(parsedResult: z.SafeParseReturnType<unknown, T>) {
  if (!parsedResult.success) {
    return {
      isValid: false,
      errors: parsedResult.error.issues.map((issue: z.ZodIssue) => ({
        field: issue.path.join('.') || 'body',
        message: issue.message
      }))
    };
  }
  return {
    isValid: true,
    data: parsedResult.data,
    errors: [] as { field: string; message: string }[]
  };
}

/**
 * Hàm parse pagination query params cho DLQ list.
 */
export function validatePaginationQuery(payload: unknown) {
  return formatZodValidationResult(paginationQuerySchema.safeParse(payload));
}

/**
 * Hàm parse mintRequestId path param cho retry-job.
 */
export function validateMintRequestIdParam(payload: unknown) {
  return formatZodValidationResult(mintRequestIdParamSchema.safeParse(payload));
}

/**
 * Middleware factory: tạo Express middleware validate request payload bằng Zod schema.
 * Mục đích: tái sử dụng cho cả query, params, body. Trả 400 + errors nếu fail.
 *
 * @param schema — Zod schema (vd: paginationQuerySchema)
 * @param source — chỉ định nguồn: 'query' | 'params' | 'body' (mặc định: 'query')
 */
export function createZodValidatorMiddleware<T>(
  schema: z.ZodType<T>,
  source: 'query' | 'params' | 'body' = 'query'
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const payload = req[source];
    const result = formatZodValidationResult(schema.safeParse(payload));
    if (!result.isValid) {
      res.status(400).json({
        error: 'Validation failed.',
        validationErrors: result.errors
      });
      return;
    }
    // Ghi đè giá trị đã validate lên request để handler downstream dùng
    (req as unknown as Record<string, unknown>)[source] = result.data;
    next();
  };
}
