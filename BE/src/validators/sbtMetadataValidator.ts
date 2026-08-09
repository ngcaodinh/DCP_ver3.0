import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { SBT_TOKEN_STATUS_NAMES } from '../constants/sbtTokenStatus';
import { sendErrorResponse } from '../utils/apiResponse';

const MAX_SBT_METADATA_PAGE = 500;
const sbtTokenIdSchema = z.coerce.number()
  .int()
  .min(0)
  .refine(Number.isSafeInteger, 'tokenId phải nằm trong giới hạn số an toàn.');

/** Schema validate projectId cho endpoint gallery public. */
export const sbtProjectIdParamSchema = z.object({
  projectId: z.string().trim().min(1, 'projectId là bắt buộc.')
});

/** Schema pagination riêng của gallery, giới hạn tối đa 20 item mỗi request. */
export const sbtMetadataQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(MAX_SBT_METADATA_PAGE).default(1),
  limit: z.coerce.number().int().min(1).max(20).default(20)
});

/** Schema tokenId path param, cho phép tokenId 0 vì counter contract bắt đầu từ 0. */
export const sbtTokenIdParamSchema = z.object({
  tokenId: sbtTokenIdSchema
});

/** Schema body cập nhật trạng thái on-chain và lý do audit bắt buộc. */
export const updateSbtStatusBodySchema = z.object({
  tokenId: sbtTokenIdSchema,
  newStatus: z.enum(SBT_TOKEN_STATUS_NAMES),
  reason: z.string().trim().min(1, 'reason là bắt buộc.').max(200, 'reason tối đa 200 ký tự.')
});

export type SbtProjectIdParam = z.infer<typeof sbtProjectIdParamSchema>;
export type SbtMetadataQuery = z.infer<typeof sbtMetadataQuerySchema>;
export type SbtTokenIdParam = z.infer<typeof sbtTokenIdParamSchema>;
export type UpdateSbtStatusBody = z.infer<typeof updateSbtStatusBodySchema>;

/** Tạo middleware Zod cho metadata API và trả lỗi theo apiResponse envelope thống nhất. */
export function createSbtMetadataValidatorMiddleware<T>(
  schema: z.ZodType<T>,
  source: 'query' | 'params' | 'body'
) {
  return (request: Request, response: Response, next: NextFunction): void => {
    const result = schema.safeParse(request[source]);
    if (!result.success) {
      sendErrorResponse(
        response,
        400,
        'Dữ liệu request không hợp lệ.',
        'VALIDATION_ERROR',
        result.error.issues.map(issue => ({
          field: issue.path.join('.') || source,
          message: issue.message
        }))
      );
      return;
    }

    (request as unknown as Record<string, unknown>)[source] = result.data;
    next();
  };
}
