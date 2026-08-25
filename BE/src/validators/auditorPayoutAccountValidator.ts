import { z } from 'zod';
import { getPayosBankCode } from '../config/payosBankCodes';

/** Kiểm tra tên ngân hàng có thể ánh xạ sang mã PayOS trước khi lưu tài khoản nhận tiền. */
function hasSupportedPayosBankCode(bankName: string): boolean {
  return Boolean(getPayosBankCode(bankName));
}

/** Xác thực tài khoản nhận thưởng/rút cọc trước khi dữ liệu nhạy cảm được ghi xuống MongoDB. */
export const auditorPayoutAccountSchema = z.object({
  bankName: z.string().trim().min(2).max(200).refine(
    hasSupportedPayosBankCode,
    'Ngân hàng không được PayOS hỗ trợ.'
  ),
  bankAccountNumber: z.string().trim().regex(/^\d{8,20}$/, 'Số tài khoản chỉ gồm 8-20 chữ số.'),
  accountHolderName: z.string().trim().min(2).max(200).regex(/^[A-Z\s]+$/, 'Tên chủ tài khoản phải viết HOA không dấu.'),
  branchName: z.union([z.string().trim().max(200), z.literal('')]).optional()
});

export type AuditorPayoutAccountInput = z.infer<typeof auditorPayoutAccountSchema>;

/** Suy ra mã PayOS đáng tin cậy ở backend, không chấp nhận bankCode do client tự khai. */
export function resolveAuditorPayoutBankCode(bankName: string): string {
  return getPayosBankCode(bankName);
}
