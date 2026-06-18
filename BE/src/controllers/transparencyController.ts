import { Request, Response } from 'express';
import { z } from 'zod';
import { getUnifiedTimeline, groupTimelineByCorrelation } from '../services/unified-timeline.service';

/**
 * Schema Zod cho query params cua unified timeline endpoint.
 * Endpoint nay la public vi du lieu transaction va dia chi vi
 * khong duoc xem la PII nhay cam (chi la thong tin cong khai tren blockchain).
 */
const unifiedTimelineQuerySchema = z.object({
  projectId: z.string().optional(),
  walletAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  pageSize: z.coerce.number().int().min(1).max(50).optional().default(50),
  cursor: z.string().optional()
});

type UnifiedTimelineQueryInput = z.infer<typeof unifiedTimelineQuerySchema>;

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
 * Endpoint nay la public vi du lieu transaction va dia chi vi
 * khong duoc xem la PII nhay cam — chi la thong tin cong khai tren blockchain.
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
  // Validate query params voi Zod schema
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
    cursor
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

    response.status(200).json({
      timeline: result.timeline,
      nextCursor: result.nextCursor,
      cached: result.cached,
      grouped: Object.fromEntries(grouped),
      count: result.timeline.length,
      fallbackMode: result.fallbackMode ?? false
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    response.status(500).json({
      error: 'Internal server error'
    });
  }
}
