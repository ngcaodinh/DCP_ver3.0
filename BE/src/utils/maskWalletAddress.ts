/**
 * Hàm mask địa chỉ ví blockchain để ẩn thông tin nhạy cảm khi broadcast Socket.io.
 * Format: 0x1234...abcd (first 6 + last 4 chars).
 * @param address Địa chỉ ví đầy đủ (0x...)
 * @returns Địa chỉ đã mask, hoặc giá trị gốc nếu quá ngắn (< 10 chars)
 */
export function maskWalletAddress(address: string): string {
  if (!address || address.length < 10) return address;
  return `${address.substring(0, 6)}...${address.substring(address.length - 4)}`;
}
