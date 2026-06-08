import { Response } from 'express';
import { getLogger } from '../config/logger';
import { AuthenticatedRequest } from '../middleware/authenticationMiddleware';
import { recalculateRankingSnapshot } from '../services/rankingService';
import { getRankingFromIncrementalMetrics } from '../services/rankingIncrementalService';
import { buildRankingCacheKey, getRankingResponseCache, invalidateRankingCache, setRankingResponseCache } from '../services/rankingCacheService';
import { sendErrorFromUnknown, sendErrorResponse, sendSuccessResponse } from '../utils/apiResponse';

const logger = getLogger();

/** Hàm parse số nguyên dương từ query. Mục đích: dùng chung cho validate input API ranking. */
function parsePositiveInteger(value: unknown): number | null {
  const parsedValue = Number(value);
  if (!Number.isFinite(parsedValue) || !Number.isInteger(parsedValue) || parsedValue <= 0) {
    return null;
  }
  return parsedValue;
}

/** Hàm xử lý request cập nhật lại bảng xếp hạng. Mục đích: cho phép admin trigger UC4.1 theo nhu cầu vận hành, đồng thời xóa cache cũ. */
export async function handleRecalculateRankingSnapshot(request: AuthenticatedRequest, response: Response): Promise<void> {
  if (!request.authenticatedUser) {
    sendErrorResponse(response, 401, 'Bạn chưa đăng nhập hoặc phiên đăng nhập không hợp lệ.', 'UNAUTHENTICATED');
    return;
  }

  const requestedWindowHours = parsePositiveInteger(request.body?.windowHours) ?? 720;

  try {
    const rankingSnapshot = await recalculateRankingSnapshot(requestedWindowHours);

    // Ghi chú logic phức tạp: sau khi recalculate xong, xóa toàn bộ cache ranking để GET /rankings trả dữ liệu mới.
    // Nếu Redis lỗi, vẫn tiếp tục trả response thành công — fallback in-memory cache sẽ tự dọn.
    await invalidateRankingCache();

    sendSuccessResponse(response, 200, 'Cập nhật bảng xếp hạng QF thành công.', rankingSnapshot);
  } catch (error) {
    logger.error('Cập nhật bảng xếp hạng QF thất bại.', { errorMessage: (error as Error).message });
    sendErrorFromUnknown(response, error, 'Không thể cập nhật bảng xếp hạng QF.');
  }
}

/** Hàm xử lý request lấy bảng xếp hạng hiện tại (v1: incremental metrics). Mục đích: trả dữ liệu ranking có phân trang và sắp xếp cho frontend, có Redis cache. Sử dụng incremental metrics O(P) thay vì snapshot-based O(D). */
export async function handleGetCurrentRankingSnapshot(request: AuthenticatedRequest, response: Response): Promise<void> {
  const pageNumber = parsePositiveInteger(request.query.page) ?? 1;
  const limitCount = parsePositiveInteger(request.query.limit) ?? 10;
  const sortBy = String(request.query.sortBy || 'totalFundingScore');
  const sortDirection = String(request.query.sortDirection || 'desc');

  const allowedSortByList = ['rankPosition', 'totalFundingScore', 'totalRaisedAmount', 'uniqueDonorCount'];
  if (!allowedSortByList.includes(sortBy)) {
    sendErrorResponse(response, 400, 'Tham số sortBy không hợp lệ.', 'VALIDATION_ERROR');
    return;
  }
  if (!['asc', 'desc'].includes(sortDirection)) {
    sendErrorResponse(response, 400, 'Tham số sortDirection không hợp lệ.', 'VALIDATION_ERROR');
    return;
  }

  const cacheKey = buildRankingCacheKey(`page=${pageNumber}&limit=${limitCount}&sortBy=${sortBy}&sortDirection=${sortDirection}`);

  try {
    // Ưu tiên đọc từ cache trước
    const cachedJsonPayload = await getRankingResponseCache(cacheKey);
    if (cachedJsonPayload) {
      const cachedPayload = JSON.parse(cachedJsonPayload);
      sendSuccessResponse(response, 200, 'Lấy bảng xếp hạng QF thành công (từ cache).', cachedPayload);
      return;
    }

    // Đọc từ incremental metrics — O(P) thay vì O(D) với D = số donations
    const rankingItems = await getRankingFromIncrementalMetrics();

    // Sắp xếp theo sortBy/sortDirection. getRankingFromIncrementalMetrics đã sort theo totalFundingScore desc mặc định.
    let sortedItems = [...rankingItems];
    if (sortBy !== 'totalFundingScore') {
      sortedItems.sort((a, b) => {
        const aValue = a[sortBy as keyof typeof a] as number;
        const bValue = b[sortBy as keyof typeof b] as number;
        return sortDirection === 'asc' ? aValue - bValue : bValue - aValue;
      });
      sortedItems.forEach((item, index) => { item.rankPosition = index + 1; });
    }

    const totalItems = sortedItems.length;
    const totalPages = Math.ceil(totalItems / limitCount);
    const startIndex = (pageNumber - 1) * limitCount;
    const endIndex = startIndex + limitCount;
    const paginatedItems = sortedItems.slice(startIndex, endIndex);

    const rankingResult = {
      snapshot: {
        source: 'incremental-metrics',
        calculatedAt: new Date().toISOString(),
        method: 'O(P) incremental update'
      },
      items: paginatedItems,
      metadata: {
        totalItems,
        totalPages,
        currentPage: pageNumber,
        pageSize: limitCount
      }
    };

    await setRankingResponseCache(cacheKey, JSON.stringify(rankingResult));
    sendSuccessResponse(response, 200, 'Lấy bảng xếp hạng QF thành công.', rankingResult);
  } catch (error) {
    logger.error('Lấy bảng xếp hạng QF thất bại.', { errorMessage: (error as Error).message });
    sendErrorFromUnknown(response, error, 'Không thể lấy bảng xếp hạng QF.');
  }
}

/**
 * Hàm xử lý request lấy bảng xếp hạng từ incremental metrics (v2).
 * Mục đích: thay thế snapshot-based approach bằng incremental update để giảm bottleneck.
 * So với v1:
 *   - Không query toàn bộ donations mỗi lần recalculate
 *   - O(P) thay vì O(D) với D = số donations
 *   - Score được tính từ running totals, không cần đọc donations
 *
 * Ghi chú: v2 trả về cùng cấu trúc với v1 để frontend không cần thay đổi.
 */
export async function handleGetRankingV2(request: AuthenticatedRequest, response: Response): Promise<void> {
  const pageNumber = parsePositiveInteger(request.query.page) ?? 1;
  const limitCount = parsePositiveInteger(request.query.limit) ?? 10;
  const sortBy = String(request.query.sortBy || 'totalFundingScore');
  const sortDirection = String(request.query.sortDirection || 'desc');

  const allowedSortByList = ['rankPosition', 'totalFundingScore', 'totalRaisedAmount', 'uniqueDonorCount'];
  if (!allowedSortByList.includes(sortBy)) {
    sendErrorResponse(response, 400, 'Tham số sortBy không hợp lệ.', 'VALIDATION_ERROR');
    return;
  }
  if (!['asc', 'desc'].includes(sortDirection)) {
    sendErrorResponse(response, 400, 'Tham số sortDirection không hợp lệ.', 'VALIDATION_ERROR');
    return;
  }

  const cacheKey = buildRankingCacheKey(`v2:page=${pageNumber}&limit=${limitCount}&sortBy=${sortBy}&sortDirection=${sortDirection}`);

  try {
    // Ưu tiên đọc từ cache trước
    const cachedJsonPayload = await getRankingResponseCache(cacheKey);
    if (cachedJsonPayload) {
      const cachedPayload = JSON.parse(cachedJsonPayload);
      sendSuccessResponse(response, 200, 'Lấy bảng xếp hạng QF v2 thành công (từ cache).', cachedPayload);
      return;
    }

    // Đọc từ incremental metrics
    const rankingItems = await getRankingFromIncrementalMetrics();

    // Ghi chú logic phức tạp: sắp xếp theo sortBy/sortDirection sau khi lấy từ metrics.
    // getRankingFromIncrementalMetrics đã sort theo totalFundingScore desc mặc định.
    let sortedItems = [...rankingItems];
    if (sortBy !== 'totalFundingScore') {
      sortedItems.sort((a, b) => {
        const aValue = a[sortBy as keyof typeof a] as number;
        const bValue = b[sortBy as keyof typeof b] as number;
        return sortDirection === 'asc' ? aValue - bValue : bValue - aValue;
      });
      // Re-assign rankPosition sau khi sort
      sortedItems.forEach((item, index) => { item.rankPosition = index + 1; });
    }

    const totalItems = sortedItems.length;
    const totalPages = Math.ceil(totalItems / limitCount);
    const startIndex = (pageNumber - 1) * limitCount;
    const endIndex = startIndex + limitCount;
    const paginatedItems = sortedItems.slice(startIndex, endIndex);

    const rankingResult = {
      snapshot: {
        source: 'incremental-metrics',
        calculatedAt: new Date().toISOString(),
        method: 'O(P) incremental update'
      },
      items: paginatedItems,
      metadata: {
        totalItems,
        totalPages,
        currentPage: pageNumber,
        pageSize: limitCount
      }
    };

    await setRankingResponseCache(cacheKey, JSON.stringify(rankingResult));
    sendSuccessResponse(response, 200, 'Lấy bảng xếp hạng QF v2 thành công.', rankingResult);
  } catch (error) {
    logger.error('Lấy bảng xếp hạng QF v2 thất bại.', { errorMessage: (error as Error).message });
    sendErrorFromUnknown(response, error, 'Không thể lấy bảng xếp hạng QF v2.');
  }
}
