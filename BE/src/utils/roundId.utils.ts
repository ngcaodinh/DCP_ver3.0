/**
 * Tiện ích parse roundId thành time window cho QF ranking API.
 * Hỗ trợ 4 cú pháp: undefined/empty → default window, "all" → no filter,
 * "YYYY-MM" → specific month, opaque string → cache namespace only.
 */
import { getLogger } from '../config/logger';

const logger = getLogger();

/** Số ngày mặc định cho default window. Có thể override qua env var QF_DEFAULT_WINDOW_DAYS. */
const DEFAULT_WINDOW_DAYS = parseInt(process.env.QF_DEFAULT_WINDOW_DAYS || '30', 10);

/** Regex kiểm tra format YYYY-MM. */
const YEAR_MONTH_REGEX = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * Hàm parse roundId thành time window.
 * Mục đích: cho phép FE filter donations theo thời gian qua roundId parameter.
 *
 * @param roundId - Giá trị roundId từ query param.
 * @returns Object chứa startAt/endAt hoặc null nếu không có time filter.
 *
 * Các cú pháp được hỗ trợ:
 * - undefined/rỗng → lấy DEFAULT_WINDOW_DAYS ngày gần nhất (startAt = now - 30 days, endAt = now)
 * - "all" → return null (no time filter)
 * - "YYYY-MM" → startAt = ngày 1 tháng đó, endAt = ngày cuối tháng đó
 * - opaque string (UUID/v.v.) → return null (chỉ dùng làm cache namespace)
 */
export function parseRoundIdToTimeWindow(
  roundId?: string
): { startAt: Date; endAt: Date } | null {
  if (!roundId || roundId.trim() === '') {
    const endAt = new Date();
    const startAt = new Date(endAt.getTime() - DEFAULT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    logger.info('RoundId default window parsed', {
      startAt: startAt.toISOString(),
      endAt: endAt.toISOString(),
      windowDays: DEFAULT_WINDOW_DAYS
    });
    return { startAt, endAt };
  }

  const trimmedRoundId = roundId.trim().toLowerCase();

  if (trimmedRoundId === 'all') {
    return null;
  }

  if (YEAR_MONTH_REGEX.test(roundId)) {
    return parseYearMonth(roundId);
  }

  return null;
}

/**
 * Hàm parse "YYYY-MM" string thành time window.
 * Mục đích: tính chính xác ngày bắt đầu và kết thúc của một tháng.
 */
function parseYearMonth(yearMonth: string): { startAt: Date; endAt: Date } | null {
  const [yearStr, monthStr] = yearMonth.split('-');
  const year = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10);

  if (isNaN(year) || isNaN(month) || month < 1 || month > 12) {
    logger.warn('Invalid year-month format', { yearMonth });
    return null;
  }

  const startAt = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
  const lastDay = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));

  logger.info('RoundId YYYY-MM parsed', {
    yearMonth,
    startAt: startAt.toISOString(),
    endAt: lastDay.toISOString()
  });

  return { startAt: startAt, endAt: lastDay };
}

/**
 * Hàm chuẩn hóa roundId thành cache key segment.
 * Mục đích: tạo cache key nhất quán cho Redis/in-memory cache.
 *
 * @param roundId - Giá trị roundId từ query param.
 * @returns "default" | "all" | giá trị gốc (opaque string hoặc YYYY-MM).
 */
export function normalizeRoundIdForCacheKey(roundId?: string): string {
  if (!roundId || roundId.trim() === '') {
    return 'default';
  }

  const trimmed = roundId.trim().toLowerCase();

  if (trimmed === 'all') {
    return 'all';
  }

  if (YEAR_MONTH_REGEX.test(roundId)) {
    return roundId;
  }

  return roundId;
}
