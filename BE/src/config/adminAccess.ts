import { getAddress, isAddress } from 'ethers';

/** Đọc allowlist ví admin từ môi trường để có thể xoay khóa mà không phải sửa mã nguồn. */
export function getAdminLoginWalletAddresses(): string[] {
  const configuredAddresses = (process.env.ADMIN_LOGIN_WALLET_ADDRESSES || '')
    .split(',')
    .map(address => address.trim())
    .filter(Boolean);
  if (!configuredAddresses.length) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Thiếu ADMIN_LOGIN_WALLET_ADDRESSES ở môi trường production.');
    }
    return [];
  }
  const invalidAddress = configuredAddresses.find(address => !isAddress(address));
  if (invalidAddress) throw new Error('ADMIN_LOGIN_WALLET_ADDRESSES chứa địa chỉ EVM không hợp lệ.');
  return [...new Set(configuredAddresses.map(address => getAddress(address).toLowerCase()))];
}

/** Lấy ví admin đầu tiên tại thời điểm gọi để tránh đọc cấu hình sớm khi module vừa được nạp. */
export function getPrimaryAdminLoginWalletAddress(): string {
  return getAdminLoginWalletAddresses()[0] || '';
}

/** Kiểm tra cấu hình allowlist ở thời điểm khởi động để production fail-closed trước khi nhận request. */
export function validateAdminLoginWalletConfiguration(): void {
  void getAdminLoginWalletAddresses();
}

/** So sánh ví admin theo dạng canonical để không tạo bypass bởi khác biệt chữ hoa/chữ thường. */
export function isAuthorizedAdminLoginWallet(walletAddress: string | null | undefined): boolean {
  return typeof walletAddress === 'string'
    && isAddress(walletAddress)
    && getAdminLoginWalletAddresses().includes(getAddress(walletAddress).toLowerCase());
}
