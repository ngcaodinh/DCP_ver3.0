// =============================================================================
// types.ts — D4: Kiểu dữ liệu dùng chung cho trang Transparency Dashboard.
// Mirror chính xác response shape của backend D1 (unified-timeline) và D3 (summary).
// Backend transparency trả raw object (KHÔNG bọc {success, data}) nên các hook
// sẽ cast res về đúng envelope thay vì đọc res.data.
// =============================================================================

/** Loại sự kiện trong dòng tiền. 'UNKNOWN' xuất hiện khi document có giá trị không hợp lệ (BE F12). */
export type TimelineEventType =
  | 'DEPOSIT'
  | 'DONATION'
  | 'DISBURSEMENT'
  | 'MINT'
  | 'UNKNOWN';

/** Trạng thái giao dịch on-chain tương ứng với eventType. */
export type ChainStatus = 'PENDING' | 'CONFIRMED' | 'FAILED' | 'REORGED';

/** Nguồn dữ liệu của một sự kiện timeline. */
export type TimelineSource = 'payos' | 'blockchain' | 'mixed';

/**
 * Một sự kiện trong dòng tiền hợp nhất (nạp VND → mint → quyên góp → giải ngân).
 * Các trường được flatten ở top-level (KHÔNG có field `data` bọc ngoài).
 */
export interface TimelineEvent {
  eventId: string;
  correlationId: string;
  eventType: TimelineEventType;
  timestamp: string;
  amountVnd: number;
  chainStatus: ChainStatus;
  chainTxHash: string | null;
  chainBlockNumber: number | null;
  payosStatus: string | null;
  payosOrderCode: string | null;
  walletAddress: string;
  projectId: string;
  source: TimelineSource;
}

/**
 * Response của GET /api/transparency/unified-timeline.
 * `grouped` đã được backend group sẵn theo correlationId — FE không tự group lại.
 */
export interface UnifiedTimelineResponse {
  timeline: TimelineEvent[];
  nextCursor: string | null;
  cached: boolean;
  grouped: Record<string, TimelineEvent[]>;
  count: number;
  fallbackMode: boolean;
}

/**
 * Response của GET /api/transparency/summary/:projectId.
 * Luôn trả 200; project rỗng → tất cả giá trị số = 0.
 * `donorCount` đếm số ví duy nhất; `transactionCount` đếm số giao dịch.
 */
export interface ProjectSummary {
  projectId: string;
  totalRaised: number;
  totalDisbursed: number;
  remaining: number;
  donorCount: number;
  transactionCount: number;
  disbursementCount: number;
  disbursedAmounts: number[];
  excludedReorgedVnd: number;
  excludedReorgedCount: number;
  overDisbursed: boolean;
  cached: boolean;
  fallbackMode: boolean;
}

/** Mục dự án cho project selector, lấy từ GET /donations/campaigns. */
export interface TransparencyProjectOption {
  projectId: string;
  name: string;
}
