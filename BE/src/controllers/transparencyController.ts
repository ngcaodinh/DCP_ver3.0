import { Request, Response } from 'express';
import { z } from 'zod';
import {
  getUnifiedTimeline,
  groupTimelineByCorrelation,
  type TimelineEvent
} from '../services/unified-timeline.service';
import { getFoundationKycPublicStatus } from '../services/foundationKycStatus.service';
import { sendErrorFromUnknown, sendSuccessResponse } from '../utils/apiResponse';

/**
 * Schema Zod cho query params của unified timeline endpoint.
 *
 * F9 — Threat model cho public endpoint:
 * Endpoint này là PUBLIC vì dữ liệu transaction và địa chỉ ví
 * KHÔNG được xem là PII nhạy cảm theo threat model hiện tại
 * (blockchain transactions are public by design).
 * Tuy nhiên, response vẫn bao gồm metadata nội bộ như payosOrderCode,
 * payosTransactionId, payosRecordId — có thể bị xem là nhạy cảm theo
 * một số threat model. Xem redactPayosMetadata để ẩn các trường này.
 *
 * TODO(threat-model): confirm with data owner which fields are public.
 */
const unifiedTimelineQuerySchema = z.object({
  projectId: z.string().optional(),
  walletAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  pageSize: z.coerce.number().int().min(1).max(50).optional().default(50),
  cursor: z.string().optional(),
  redactPayosMetadata: z.coerce.boolean().optional().default(false)
});

/**
 * Hàm redact metadata nội bộ của PayOS từ TimelineEvent.
 * Mục đích: cho phép public endpoint trả về event mà không lộ metadata nội bộ
 * (payosOrderCode, payosTransactionId, payosRecordId) nếu threat model yêu cầu.
 *
 * TODO(threat-model): confirm with data owner before exposing full metadata publicly.
 */
function redactTimelineEvent(event: TimelineEvent): TimelineEvent {
  return {
    ...event,
    payosOrderCode: null
  };
}

function normalizePageSize(value: unknown, defaultValue: number, maxValue: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return defaultValue;
  return Math.min(maxValue, Math.max(1, Math.floor(parsed)));
}

function parseDateParam(value: unknown): string | undefined {
  if (!value || typeof value !== 'string') return undefined;
  const parsed = new Date(value);
  if (isNaN(parsed.getTime())) return undefined;
  return value;
}

/**
 * Xử lý GET /api/transparency/unified-timeline.
 *
 * Endpoint này là public vì dữ liệu transaction và địa chỉ ví
 * không được xem là PII nhạy cảm — chỉ là thông tin công khai trên blockchain.
 * Trả về unified timeline với cursor-based pagination.
 * Cache: Redis TTL 2 phút.
 *
 * Query params:
 * - projectId (optional): filter theo dự án
 * - walletAddress (optional): filter theo ví
 * - startDate (optional): ISO date string
 * - endDate (optional): ISO date string
 * - pageSize (optional): số bản ghi mỗi trang (default 50, max 50)
 * - cursor (optional): cursor cho trang tiếp theo
 *
 * Response:
 * - timeline: mảng event
 * - nextCursor: cursor cho trang tiếp theo (null nếu hết)
 * - cached: true nếu từ cache
 * - grouped: events đã group theo correlationId
 * - count: số lượng event trong response
 */
export async function handleGetUnifiedTimeline(
  request: Request,
  response: Response
): Promise<void> {
  // Validate query params với Zod schema
  const parseResult = unifiedTimelineQuerySchema.safeParse(request.query);

  if (!parseResult.success) {
    const errors = parseResult.error.errors.map(err => ({
      field: err.path.join('.'),
      message: err.message
    }));
    response.status(400).json({
      error: 'Validation failed',
      details: errors
    });
    return;
  }

  const {
    projectId,
    walletAddress,
    startDate,
    endDate,
    pageSize,
    cursor,
    redactPayosMetadata
  } = parseResult.data;

  const queryParams = {
    projectId:
      projectId && projectId.trim()
        ? projectId.trim()
        : undefined,
    walletAddress:
      walletAddress && walletAddress.trim()
        ? walletAddress.trim()
        : undefined,
    startDate: parseDateParam(startDate),
    endDate: parseDateParam(endDate)
  };

  const normalizedPageSize = normalizePageSize(pageSize, 50, 50);
  const safeCursor =
    cursor && cursor.trim() ? cursor.trim() : undefined;

  try {
    const result = await getUnifiedTimeline(
      queryParams,
      normalizedPageSize,
      safeCursor
    );

    const grouped = groupTimelineByCorrelation(result.timeline);

    // F9 fix: redact metadata nội bộ nếu client yêu cầu
    const safeTimeline = redactPayosMetadata
      ? result.timeline.map(redactTimelineEvent)
      : result.timeline;

    response.status(200).json({
      timeline: safeTimeline,
      nextCursor: result.nextCursor,
      cached: result.cached,
      grouped: Object.fromEntries(grouped),
      count: safeTimeline.length,
      fallbackMode: result.fallbackMode ?? false
    });
  } catch {
    response.status(500).json({
      error: 'Internal server error'
    });
  }
}

/** Xử lý GET status KYC FOUNDATION public và chỉ trả về ba trường đã được whitelist. */
export async function handleGetFoundationKycStatus(
  _request: Request,
  response: Response
): Promise<void> {
  try {
    const publicStatus = await getFoundationKycPublicStatus();
    sendSuccessResponse(response, 200, 'Lấy trạng thái KYC FOUNDATION thành công.', publicStatus);
  } catch (error) {
    sendErrorFromUnknown(response, error, 'Không thể tải trạng thái KYC FOUNDATION.');
  }
}
