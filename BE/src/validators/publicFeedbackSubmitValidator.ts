import { z } from 'zod';

const PROJECT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Schema dùng chung để bảo vệ projectId khỏi path traversal và dữ liệu ngoài hợp đồng. */
export const publicFeedbackProjectIdSchema = z
  .string({ required_error: 'projectId là bắt buộc.' })
  .trim()
  .min(1, 'projectId không được để trống.')
  .max(64, 'projectId không được dài quá 64 ký tự.')
  .regex(PROJECT_ID_PATTERN, 'projectId chứa ký tự không hợp lệ.');

/** Schema kiểm tra payload form public trước khi chạm vào ticket, Redis hoặc MongoDB. */
export const publicFeedbackSubmitSchema = z.object({
  projectId: publicFeedbackProjectIdSchema,
  rating: z.coerce.number().int('rating phải là số nguyên.').min(1, 'Rating phải từ 1 đến 5.').max(5, 'Rating phải từ 1 đến 5.'),
  comment: z.string({ required_error: 'comment là bắt buộc.' })
    .trim()
    .min(1, 'comment không được để trống.')
    .max(1000, 'comment không được dài quá 1000 ký tự.'),
  anonymousName: z.string().trim().max(100, 'anonymousName không được dài quá 100 ký tự.').optional(),
  submissionTicket: z.string({ required_error: 'submissionTicket là bắt buộc.' }).trim().min(1, 'submissionTicket là bắt buộc.'),
  contactEmail: z.string().trim().max(320, 'contactEmail không hợp lệ.').optional(),
  redirect: z.literal('1').optional()
});

export type PublicFeedbackSubmitPayload = z.infer<typeof publicFeedbackSubmitSchema>;
