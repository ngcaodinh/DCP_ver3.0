/** Số block xác nhận dùng chung cho toàn bộ transaction mint và cập nhật trạng thái SBT. */
export const SBT_MINT_CONFIRMATION_BLOCKS = readSbtMintConfirmationBlocks();

/** Đọc và kiểm tra cấu hình xác nhận blockchain một lần khi process khởi động. */
function readSbtMintConfirmationBlocks(): number {
  const configuredValue = Number.parseInt(process.env.SBT_MINT_CONFIRMATION_BLOCKS ?? '2', 10);
  if (!Number.isInteger(configuredValue) || configuredValue < 1) {
    throw new Error('SBT_MINT_CONFIRMATION_BLOCKS phải >= 1.');
  }
  return configuredValue;
}
