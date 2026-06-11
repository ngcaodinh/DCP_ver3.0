import { Request, Response } from 'express';
import { getUnifiedTimeline, groupTimelineByCorrelation } from '../services/unified-timeline.service';

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
 * Xu ly GET /api/transparency/unified-timeline.
 *
 * Tra ve unified timeline voi cursor-based pagination.
 * Cache: Redis TTL 2 phut.
 *
 * Query params:
 * - projectId (optional): filter theo du an
 * - walletAddress (optional): filter theo vi
 * - startDate (optional): ISO date string
 * - endDate (optional): ISO date string
 * - pageSize (optional): so ban ghi moi trang (default 50, max 50)
 * - cursor (optional): cursor cho trang tiep theo
 *
 * Response:
 * - timeline: mang event
 * - nextCursor: cursor cho trang tiep theo (null neu het)
 * - cached: true neu tu cache
 * - grouped: events da group theo correlationId
 * - count: so luong event trong response
 */
export async function handleGetUnifiedTimeline(
  request: Request,
  response: Response
): Promise<void> {
  const {
    projectId,
    walletAddress,
    startDate,
    endDate,
    pageSize,
    cursor
  } = request.query;

  const queryParams = {
    projectId:
      typeof projectId === 'string' && projectId.trim()
        ? projectId.trim()
        : undefined,
    walletAddress:
      typeof walletAddress === 'string' && walletAddress.trim()
        ? walletAddress.trim()
        : undefined,
    startDate: parseDateParam(startDate),
    endDate: parseDateParam(endDate)
  };

  const normalizedPageSize = normalizePageSize(pageSize, 50, 50);
  const safeCursor =
    typeof cursor === 'string' && cursor.trim() ? cursor.trim() : undefined;

  const result = await getUnifiedTimeline(
    queryParams,
    normalizedPageSize,
    safeCursor
  );

  const grouped = groupTimelineByCorrelation(result.timeline);

  response.status(200).json({
    timeline: result.timeline,
    nextCursor: result.nextCursor,
    cached: result.cached,
    grouped: Object.fromEntries(grouped),
    count: result.timeline.length
  });
}
