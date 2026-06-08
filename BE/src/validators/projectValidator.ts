import { z } from 'zod';

const ipfsCidPattern = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|bafy[1-9A-HJ-NP-Za-km-z]{20,})$/;

const projectEvidenceFileSchema = z.object({
  cid: z.string().trim().regex(ipfsCidPattern, 'CID minh chứng không đúng định dạng IPFS.'),
  fileName: z.string().trim().max(255),
  mimeType: z.string().trim().max(100)
});

export const createProjectSchema = z.object({
  name: z.string({ required_error: 'Tên dự án là bắt buộc.' }).trim().min(3).max(120),
  description: z.string({ required_error: 'Mô tả dự án là bắt buộc.' }).trim().min(10).max(2000),
  goalAmount: z.number({ required_error: 'Mục tiêu gây quỹ là bắt buộc.', invalid_type_error: 'Mục tiêu gây quỹ phải là số.' }).positive(),
  deadline: z.string({ required_error: 'Hạn dự án là bắt buộc.' }).datetime('Hạn dự án không đúng định dạng ISO datetime.'),
  evidenceCids: z
    .array(z.string().trim().regex(ipfsCidPattern, 'CID bằng chứng không đúng định dạng IPFS.'))
    .min(3, 'Dự án phải có tối thiểu 3 ảnh bằng chứng trên IPFS.')
    .max(10, 'Dự án chỉ được tối đa 10 ảnh bằng chứng trên IPFS.'),
  evidenceFiles: z.array(projectEvidenceFileSchema).max(10).optional()
});

export const uploadProjectEvidencesSchema = z.object({
  files: z
    .array(
      z.object({
        fileName: z.string({ required_error: 'Tên file là bắt buộc.' }).trim().min(1).max(255),
        mimeType: z.string({ required_error: 'Loại MIME là bắt buộc.' }).trim().min(1).max(100),
        contentBase64: z.string({ required_error: 'Nội dung file base64 là bắt buộc.' }).trim().min(1)
      })
    )
    .min(1, 'Vui lòng tải lên ít nhất 1 file minh chứng.')
    .max(10, 'Bạn chỉ được tải lên tối đa 10 file minh chứng.')
});

export const updateProjectSchema = z.object({
  projectId: z.string({ required_error: 'projectId là bắt buộc.' }).trim().min(1),
  name: z.string({ required_error: 'Tên dự án là bắt buộc.' }).trim().min(3).max(120),
  description: z.string({ required_error: 'Mô tả dự án là bắt buộc.' }).trim().min(10).max(2000),
  goalAmount: z.number({ required_error: 'Mục tiêu gây quỹ là bắt buộc.', invalid_type_error: 'Mục tiêu gây quỹ phải là số.' }).positive(),
  deadline: z.string({ required_error: 'Hạn dự án là bắt buộc.' }).datetime('Hạn dự án không đúng định dạng ISO datetime.'),
  evidenceCids: z
    .array(z.string().trim().regex(ipfsCidPattern, 'CID bằng chứng không đúng định dạng IPFS.'))
    .min(1, 'Dự án phải có ít nhất 1 CID bằng chứng IPFS.')
    .max(10, 'Dự án chỉ được tối đa 10 CID bằng chứng IPFS.'),
  evidenceFiles: z.array(projectEvidenceFileSchema).max(10).optional()
});

export const submitProjectSchema = z.object({
  projectId: z.string({ required_error: 'projectId là bắt buộc.' }).trim().min(1)
});

export const reviewProjectSchema = z
  .object({
    projectId: z.string({ required_error: 'projectId là bắt buộc.' }).trim().min(1),
    action: z.enum(['APPROVE', 'REJECT'], { required_error: 'action là bắt buộc.' }),
    rejectionReason: z.string().trim().max(500).optional()
  })
  .superRefine((data, context) => {
    if (data.action === 'REJECT' && !data.rejectionReason) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['rejectionReason'], message: 'Bạn phải nhập lý do từ chối.' });
    }
  });

export type CreateProjectRequestBody = z.infer<typeof createProjectSchema>;
export type UploadProjectEvidencesRequestBody = z.infer<typeof uploadProjectEvidencesSchema>;
export type UpdateProjectRequestBody = z.infer<typeof updateProjectSchema>;
export type SubmitProjectRequestBody = z.infer<typeof submitProjectSchema>;
export type ReviewProjectRequestBody = z.infer<typeof reviewProjectSchema>;

/** Hàm chuẩn hóa lỗi validate từ Zod. Mục đích: tái sử dụng cho nhiều API project. */
function formatZodValidationResult<T>(parsedResult: z.SafeParseReturnType<unknown, T>) {
  if (!parsedResult.success) {
    return {
      isValid: false,
      errors: parsedResult.error.issues.map((issue: z.ZodIssue) => ({ field: issue.path.join('.') || 'body', message: issue.message }))
    };
  }

  return {
    isValid: true,
    data: parsedResult.data,
    errors: [] as { field: string; message: string }[]
  };
}

/** Hàm parse payload tạo dự án. Mục đích: validate body API tạo dự án. */
export function validateCreateProjectRequestBody(payload: unknown) {
  return formatZodValidationResult(createProjectSchema.safeParse(payload));
}

/** Hàm parse payload upload file minh chứng dự án. Mục đích: validate body API upload evidences. */
export function validateUploadProjectEvidencesRequestBody(payload: unknown) {
  return formatZodValidationResult(uploadProjectEvidencesSchema.safeParse(payload));
}

/** Hàm parse payload cập nhật dự án. Mục đích: validate body API cập nhật thông tin dự án. */
export function validateUpdateProjectRequestBody(payload: unknown) {
  return formatZodValidationResult(updateProjectSchema.safeParse(payload));
}

/** Hàm parse payload submit dự án. Mục đích: validate body API submit approval. */
export function validateSubmitProjectRequestBody(payload: unknown) {
  return formatZodValidationResult(submitProjectSchema.safeParse(payload));
}

/** Hàm parse payload review dự án. Mục đích: validate body API review approve/reject. */
export function validateReviewProjectRequestBody(payload: unknown) {
  return formatZodValidationResult(reviewProjectSchema.safeParse(payload));
}
