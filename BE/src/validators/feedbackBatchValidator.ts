import { z } from 'zod';

/**
 * Schema cho một dòng feedback trong batch upload.
 * Validation đầy đủ với Zod theo spec F1.
 */
export const beneficiaryFeedbackRowSchema = z.object({
  projectId: z.string({ required_error: 'projectId là bắt buộc.' }).trim().min(1, 'projectId không được để trống.'),
  beneficiaryName: z.string({ required_error: 'beneficiaryName là bắt buộc.' }).trim().min(1, 'beneficiaryName không được để trống.'),
  rating: z.number({ required_error: 'rating là bắt buộc.', invalid_type_error: 'rating phải là số.' })
    .int('rating phải là số nguyên.')
    .min(1, 'Rating must be 1-5')
    .max(5, 'Rating must be 1-5'),
  comment: z.string({ required_error: 'comment là bắt buộc.' })
    .trim()
    .min(1, 'comment không được để trống.')
    .max(5000, 'Comment vượt quá giới hạn 5000 ký tự.'),
  submittedAt: z.string({ required_error: 'submittedAt là bắt buộc.' })
    .datetime('submittedAt phải theo định dạng ISO datetime.'),
  location: z.string().trim().optional()
});

export type BeneficiaryFeedbackRow = z.infer<typeof beneficiaryFeedbackRowSchema>;

/**
 * Schema cho batch feedback upload - JSON array format.
 */
export const batchFeedbackJsonSchema = z.object({
  feedbacks: z.array(beneficiaryFeedbackRowSchema, {
    required_error: 'feedbacks là bắt buộc.',
    invalid_type_error: 'feedbacks phải là mảng.'
  })
    .min(1, 'Phải có ít nhất 1 feedback.')
    .max(1000, 'Batch size exceeds 1000 limit.')
});

export type BatchFeedbackJsonPayload = z.infer<typeof batchFeedbackJsonSchema>;

/**
 * Kết quả validation cho một dòng feedback.
 */
export type FeedbackValidationResult = {
  rowNumber: number;
  isValid: boolean;
  data?: BeneficiaryFeedbackRow;
  errors?: Array<{ field: string; message: string }>;
};

/**
 * Kết quả validation cho toàn bộ batch.
 */
export type BatchValidationResult = {
  validRows: Array<{ rowNumber: number; data: BeneficiaryFeedbackRow }>;
  invalidRows: Array<FeedbackValidationResult>;
  totalRows: number;
};

/**
 * Hàm validate một dòng feedback theo schema.
 * @param row Dòng dữ liệu cần validate
 * @param rowNumber Số thứ tự dòng (1-indexed)
 * @returns Kết quả validation với thông tin lỗi chi tiết
 */
export function validateFeedbackRow(
  row: unknown,
  rowNumber: number
): FeedbackValidationResult {
  const result = beneficiaryFeedbackRowSchema.safeParse(row);

  if (result.success) {
    return {
      rowNumber,
      isValid: true,
      data: result.data
    };
  }

  return {
    rowNumber,
    isValid: false,
    errors: result.error.issues.map((issue) => ({
      field: issue.path.join('.') || 'unknown',
      message: issue.message
    }))
  };
}

/**
 * Hàm validate toàn bộ batch feedback.
 * @param rows Mảng các dòng feedback cần validate
 * @returns Kết quả validation phân tách valid/invalid rows
 */
export function validateBatchFeedback(rows: unknown[]): BatchValidationResult {
  const validRows: Array<{ rowNumber: number; data: BeneficiaryFeedbackRow }> = [];
  const invalidRows: FeedbackValidationResult[] = [];

  for (let i = 0; i < rows.length; i++) {
    const validationResult = validateFeedbackRow(rows[i], i + 1);
    if (validationResult.isValid && validationResult.data) {
      validRows.push({ rowNumber: validationResult.rowNumber, data: validationResult.data });
    } else {
      invalidRows.push(validationResult);
    }
  }

  return {
    validRows,
    invalidRows,
    totalRows: rows.length
  };
}
