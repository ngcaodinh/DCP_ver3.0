/** Kiểu tier mà backend trả về cho một donor trong bảng ranking công bằng. */
export type FairRankingTier = 'Bronze' | 'Silver' | 'Gold';

/** Kiểu sắp xếp được backend hỗ trợ cho bảng donor. */
export type FairRankingSortBy = 'trustAdjusted' | 'original';

/** Nguồn của trust score để FE giải thích đúng trạng thái badge. */
export type FairRankingTrustSource = 'computed' | 'unknown' | 'fallback';

/** Một donor trong response public của Trust-Adjusted QF API. */
export interface FairRankingEntry {
  rank: number;
  originalRank: number;
  donorAddress: string;
  contributionAmount: number;
  trustScore: number;
  trustAdjustedMatch: number;
  tier: FairRankingTier;
  trustSource: FairRankingTrustSource;
}

/** Xếp hạng riêng của ví hiện tại nếu ví có donation trong cửa sổ dữ liệu. */
export type FairRankingPersonalEntry = FairRankingEntry;

/** Các điểm tổng hợp của project trong response ranking. */
export interface FairRankingScores {
  projectTrustAdjustedScore: number;
  originalQfScore: number;
  totalDonors: number;
  totalDonationRecords: number;
  skippedDonors: number;
}

/** Các chỉ số về độ phủ trust score của tập donor. */
export interface FairRankingTrustFactors {
  averageTrustScore: number;
  donorsWithTrustScore: number;
  donorsWithFallback: number;
  donorsWithUnknownStatus: number;
}

/** Metadata pagination và cách sort của request hiện tại. */
export interface FairRankingMetadata {
  projectId: string;
  roundId: string;
  totalItems: number;
  totalPages: number;
  currentPage: number;
  pageSize: number;
  cachedAt: string | null;
  cacheHit: boolean;
  sortBy: FairRankingSortBy;
}

/** Contract đầy đủ của GET /rankings/trust-adjusted. */
export interface FairRankingResponse {
  rankings: FairRankingEntry[];
  myRanking: FairRankingPersonalEntry | null;
  scores: FairRankingScores;
  trustFactors: FairRankingTrustFactors;
  metadata: FairRankingMetadata;
}

/** Project option được truyền từ bảng ranking dự án hiện có xuống tab donor. */
export interface FairRankingProject {
  projectId: string;
  projectName: string;
}
