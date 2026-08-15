import crypto from 'crypto';

/** Các ký tự đầu dòng nguy hiểm khi xuất nội dung feedback sang CSV. */
const FORMULA_PREFIX_CHARS = ['=', '+', '-', '@', '\t', '\r', '\n'];

/** Kiểm tra chuỗi có thể bị Excel diễn giải như công thức CSV hay không. */
function hasFormulaPrefix(value: string): boolean {
  const trimmedValue = value.trimStart();
  return trimmedValue.length > 0 && FORMULA_PREFIX_CHARS.includes(trimmedValue.charAt(0));
}

/** Thêm tiền tố an toàn lúc xuất CSV mà không làm biến đổi nội dung domain đã lưu. */
export function escapeFormulaInjection(value: string): string {
  return hasFormulaPrefix(value) ? ` ${value}` : value;
}

/** Băm tên beneficiary để không lưu PII dạng plaintext trong feedback. */
export function hashBeneficiaryName(beneficiaryName: string): string {
  return crypto.createHash('sha256').update(beneficiaryName).digest('hex');
}
