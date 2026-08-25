/** Che số tài khoản khi ghi log hoặc snapshot chi trả. */
export function maskBankAccount(accountNumber: string): string {
  if (!accountNumber || accountNumber.length <= 4) {
    return '****';
  }
  const visibleDigits = accountNumber.slice(-4);
  const maskedDigits = '*'.repeat(accountNumber.length - 4);
  return `${maskedDigits}${visibleDigits}`;
}

/** Che tên chủ tài khoản, chỉ giữ lại hai ký tự đầu để hỗ trợ đối soát an toàn. */
export function maskAccountHolderName(name: string): string {
  if (!name || name.length <= 2) {
    return '**';
  }
  return `${name.slice(0, 2)}${'*'.repeat(Math.max(0, name.length - 2))}`;
}
