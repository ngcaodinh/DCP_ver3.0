/** Bản sao hiển thị của BE/src/constants/governanceRoles.ts; chỉ dùng mô tả UI, backend vẫn là nguồn quyết định. */
export const EXECUTIVE_COMMITTEE_POLICY = {
  requiredChairVotes: 1,
  requiredMemberVotes: 2,
  expectedMemberSeats: 4
} as const;

export type ExecutiveDeviationLevel = 'INSIDE' | 'WITHIN_ACCURACY' | 'DEVIATED' | 'CRITICAL' | 'NO_GEOFENCE';

/** Xác định khi nào người biểu quyết phải xác nhận rủi ro GPS trước khi gửi phiếu. */
export function requiresRiskAcknowledgement(deviationLevel: ExecutiveDeviationLevel): boolean {
  return deviationLevel === 'DEVIATED' || deviationLevel === 'CRITICAL';
}
