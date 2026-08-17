import type { FairRankingTier, FairRankingTrustSource } from '@/app/types/fairRanking';

/** Số donor tối đa backend cho phép trả về trong một trang ranking. */
export const FAIR_RANKING_PAGE_SIZE = 20;

/** Thời gian giữ dữ liệu ranking fresh ở React Query. */
export const FAIR_RANKING_STALE_TIME_MS = 30_000;

/** Chu kỳ polling ranking công bằng khi tab đang được hiển thị. */
export const FAIR_RANKING_REFETCH_INTERVAL_MS = 30_000;

/** Giá trị fallback hiển thị khi donor chưa có record trust score. */
export const TRUST_SCORE_FALLBACK_VALUE = 0.5;

/** Ngưỡng để hiển thị card thứ hạng đầy đủ của donor hiện tại. */
export const MY_RANKING_VISIBLE_THRESHOLD = 50;

/** Bộ màu tier computed; source unknown/fallback dùng style trung tính ở component. */
export const TIER_STYLE_MAP: Record<FairRankingTier, string> = {
  Bronze: 'border-amber-200 bg-amber-50 text-amber-700',
  Silver: 'border-slate-300 bg-slate-100 text-slate-700',
  Gold: 'border-[#a8ded6] bg-[#e6f7f4] text-[#0a5c50]'
};

/** Trọng số mirror của hệ thống trust score BE để tooltip không rải rác literal trong JSX. */
export const TRUST_FACTOR_WEIGHT_ROWS = [
  { key: 'kyc', label: 'KYC', percentage: 20 },
  { key: 'donationHistory', label: 'Lịch sử quyên góp', percentage: 30 },
  { key: 'socialVerification', label: 'Xác minh MXH', percentage: 20 },
  { key: 'accountAge', label: 'Tuổi tài khoản', percentage: 15 },
  { key: 'deviceBinding', label: 'Liên kết thiết bị', percentage: 15 }
] as const;

/** Kiểm tra tổng trọng số trước khi hiển thị tooltip trust score. */
export const TRUST_FACTOR_WEIGHT_TOTAL = TRUST_FACTOR_WEIGHT_ROWS.reduce(
  (total, row) => total + row.percentage,
  0
);

/** Nội dung giải thích thêm cho từng nguồn trust score. */
export const TRUST_SOURCE_EXPLANATIONS: Record<FairRankingTrustSource, string> = {
  computed: '',
  unknown: 'Ví này chưa liên kết tài khoản đã xác minh — hệ thống tạm tính ở mức 0.3.',
  fallback: 'Nhà hảo tâm này chưa được chấm điểm — đang dùng điểm mặc định 0.5.'
};
