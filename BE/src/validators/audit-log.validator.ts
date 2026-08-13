import { z } from 'zod';
import { ADMIN_AUDIT_ACTIONS } from '../models/adminAuditLogModel';

const optionalQueryString = z.preprocess(
  (value: unknown) => Array.isArray(value) ? value[0] : value,
  z.string().trim().min(1).max(200).optional()
);

const dateQueryString = optionalQueryString.refine(
  (value) => value === undefined || isIsoDateOrDateTime(value),
  'Ngày phải là ISO date hoặc ISO datetime hợp lệ.'
);

/** Validator cho query list audit, giới hạn page/limit trước khi chạm database. */
export const auditLogListQuerySchema = z.object({
  page: z.preprocess((value: unknown) => Array.isArray(value) ? value[0] : value, z.coerce.number().int().min(1).max(10_000).default(1)),
  limit: z.preprocess((value: unknown) => Array.isArray(value) ? value[0] : value, z.coerce.number().int().min(1).max(100).default(20)),
  actionType: optionalQueryString.refine(
    (value) => value === undefined || ADMIN_AUDIT_ACTIONS.includes(value as typeof ADMIN_AUDIT_ACTIONS[number]),
    'actionType không hợp lệ.'
  ),
  adminId: optionalQueryString,
  from: dateQueryString,
  to: dateQueryString
}).superRefine((value, context) => {
  if (value.from && value.to) {
    const from = parseDateInput(value.from, false);
    const to = parseDateInput(value.to, true);
    if (!from || !to || from.getTime() >= to.getTime()) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['to'],
        message: 'from phải nhỏ hơn to.'
      });
    }
  }
});

export type AuditLogListQuery = z.infer<typeof auditLogListQuerySchema>;

/** Chuyển một giá trị query date thành Date để validator dùng cùng policy timezone với service. */
function parseDateInput(value: string, isEnd: boolean): Date | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parsed = new Date(`${value}T00:00:00.000+07:00`);
    if (isEnd) parsed.setTime(parsed.getTime() + 24 * 60 * 60 * 1000);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Chỉ chấp nhận ISO date hoặc ISO datetime có timezone rõ ràng tại boundary API. */
function isIsoDateOrDateTime(value: string): boolean {
  const isDate = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const isDateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value);
  return (isDate || isDateTime) && !Number.isNaN(Date.parse(value));
}
