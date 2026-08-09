/** Tên trạng thái SBT on-chain, ánh xạ một-một với enum TokenStatus của ImpactSBT. */
export const SBT_TOKEN_STATUS_NAMES = ['ACTIVE', 'FROZEN', 'REVOKED', 'BURNED'] as const;

export type SbtTokenStatusName = (typeof SBT_TOKEN_STATUS_NAMES)[number];

/** Ánh xạ tên trạng thái sang uint8 tại ranh giới gọi smart contract. */
export const SBT_TOKEN_STATUS_TO_UINT8: Record<SbtTokenStatusName, number> = {
  ACTIVE: 0,
  FROZEN: 1,
  REVOKED: 2,
  BURNED: 3
};

/** Chuyển uint8 từ contract về tên trạng thái; trả null nếu contract trả enum chưa được backend biết. */
export function toSbtTokenStatusName(value: number): SbtTokenStatusName | null {
  return SBT_TOKEN_STATUS_NAMES[value] ?? null;
}

/** Các trạng thái terminal không cho phép chuyển tiếp trên ImpactSBT. */
export const SBT_TERMINAL_STATUSES = ['REVOKED', 'BURNED'] as const;

/** Các trạng thái không được hiển thị trong gallery công khai. */
export const SBT_HIDDEN_FROM_GALLERY_STATUSES = ['REVOKED', 'BURNED'] as const;
