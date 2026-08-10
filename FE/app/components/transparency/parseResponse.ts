// =============================================================================
// parseResponse.ts — D4: Validate runtime cho response raw của backend transparency.
// Endpoint transparency trả raw object (KHÔNG bọc {success, data}), trước đây hook
// ép kiểu trần (as unknown as T) nên payload méo sẽ lọt xuống UI gây crash/hiển thị sai.
// Các hàm dưới kiểm tra shape tối thiểu tại ranh giới API rồi throw lỗi chuẩn nếu sai.
// KHÔNG dùng Zod (chưa có trong dependency) — validate thủ công, giữ 0 dependency mới.
// =============================================================================

import type { ApiErrorResponse } from '@/app/utils/apiClient';
import type {
  ProjectSummary,
  TimelineEvent,
  UnifiedTimelineResponse
} from './types';

/** Tạo lỗi chuẩn ApiErrorResponse cho trường hợp payload backend sai shape. */
function makeInvalidShapeError(message: string): ApiErrorResponse {
  return {
    success: false,
    message,
    errorCode: 'INVALID_RESPONSE',
    details: []
  };
}

/** Ép an toàn giá trị bất kỳ về number, fallback 0 nếu không phải số hữu hạn. */
function toFiniteNumber(candidateValue: unknown): number {
  return typeof candidateValue === 'number' && Number.isFinite(candidateValue) ? candidateValue : 0;
}

/**
 * Kiểm tra và chuẩn hóa response tổng hợp dòng tiền của một dự án.
 * Chỉ yêu cầu payload là object; các trường số thiếu/sai kiểu được fallback 0
 * (BE có thể trả project rỗng), nhưng payload không phải object thì throw.
 *
 * @param rawResponse Dữ liệu thô trả về từ endpoint summary
 * @returns Đối tượng ProjectSummary đã chuẩn hóa
 */
export function parseProjectSummary(rawResponse: unknown): ProjectSummary {
  if (!rawResponse || typeof rawResponse !== 'object') {
    throw makeInvalidShapeError('Phản hồi tổng hợp dòng tiền không hợp lệ.');
  }

  const source = rawResponse as Record<string, unknown>;
  const disbursedAmounts = Array.isArray(source.disbursedAmounts)
    ? source.disbursedAmounts.map(toFiniteNumber)
    : [];

  return {
    projectId: typeof source.projectId === 'string' ? source.projectId : '',
    totalRaised: toFiniteNumber(source.totalRaised),
    totalDisbursed: toFiniteNumber(source.totalDisbursed),
    remaining: toFiniteNumber(source.remaining),
    donorCount: toFiniteNumber(source.donorCount),
    transactionCount: toFiniteNumber(source.transactionCount),
    disbursementCount: toFiniteNumber(source.disbursementCount),
    disbursedAmounts,
    excludedReorgedVnd: toFiniteNumber(source.excludedReorgedVnd),
    excludedReorgedCount: toFiniteNumber(source.excludedReorgedCount),
    overDisbursed: source.overDisbursed === true,
    cached: source.cached === true,
    fallbackMode: source.fallbackMode === true
  };
}

/**
 * Kiểm tra response dòng tiền hợp nhất một trang.
 * Bắt buộc `timeline` là mảng (nếu không, không thể render/flatten an toàn) → throw khi sai.
 * Các trường phân trang/thống kê được fallback về giá trị an toàn.
 *
 * @param rawResponse Dữ liệu thô trả về từ endpoint unified-timeline
 * @returns Đối tượng UnifiedTimelineResponse đã chuẩn hóa
 */
export function parseUnifiedTimeline(rawResponse: unknown): UnifiedTimelineResponse {
  if (!rawResponse || typeof rawResponse !== 'object') {
    throw makeInvalidShapeError('Phản hồi dòng tiền không hợp lệ.');
  }

  const source = rawResponse as Record<string, unknown>;
  if (!Array.isArray(source.timeline)) {
    throw makeInvalidShapeError('Phản hồi dòng tiền thiếu danh sách sự kiện.');
  }

  const timeline = source.timeline as TimelineEvent[];
  const grouped =
    source.grouped && typeof source.grouped === 'object'
      ? (source.grouped as Record<string, TimelineEvent[]>)
      : {};

  return {
    timeline,
    nextCursor: typeof source.nextCursor === 'string' ? source.nextCursor : null,
    cached: source.cached === true,
    grouped,
    count: toFiniteNumber(source.count),
    fallbackMode: source.fallbackMode === true
  };
}
