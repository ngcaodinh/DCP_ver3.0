import type { Request, Response } from 'express';
import { sendErrorFromUnknown, sendSuccessResponse } from '../utils/apiResponse';
import { getPublicCommitteeDecisions, getPublicCommitteeGovernanceEvents } from '../services/publicCommitteeGovernance.service';

/** Chuẩn hóa limit public để endpoint luôn có lượng công việc bị chặn trên mỗi request. */
function parsePublicLimit(value: unknown): number {
  const limitCount = Number(value || 20);
  return Number.isInteger(limitCount) && limitCount >= 1 && limitCount <= 50 ? limitCount : 20;
}

/** Giải mã cursor event public và bỏ qua input bất hợp lệ thay vì đưa filter mơ hồ vào Mongo. */
function parseEventCursor(value: unknown): { blockNumber: number; logIndex: number } | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as { blockNumber?: unknown; logIndex?: unknown };
    const blockNumber = Number(decoded.blockNumber);
    const logIndex = Number(decoded.logIndex);
    return Number.isSafeInteger(blockNumber) && blockNumber >= 0 && Number.isSafeInteger(logIndex) && logIndex >= 0
      ? { blockNumber, logIndex }
      : null;
  } catch {
    return null;
  }
}

/** Giải mã cursor quyết định public theo thời điểm relay để phân trang ổn định khi có nhiều decision cùng lúc. */
function parseDecisionCursor(value: unknown): { recordedAt: Date; committeeVoteId: string; decisionKind: 'DISBURSEMENT' | 'ARBITRATION' } | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as { recordedAt?: unknown; committeeVoteId?: unknown; decisionKind?: unknown };
    const recordedAt = new Date(String(decoded.recordedAt || ''));
    return !Number.isNaN(recordedAt.getTime()) && typeof decoded.committeeVoteId === 'string' && decoded.committeeVoteId
      ? {
        recordedAt,
        committeeVoteId: decoded.committeeVoteId,
        // Cursor cũ chỉ có giải ngân; giữ tương thích để không làm đứt phân trang đang diễn ra.
        decisionKind: decoded.decisionKind === 'ARBITRATION' ? 'ARBITRATION' : 'DISBURSEMENT'
      }
      : null;
  } catch {
    return null;
  }
}

/** Trả read model sự kiện ghế và quyết định đã project để trình duyệt không gọi RPC trực tiếp. */
export async function handleGetPublicCommitteeGovernanceEvents(request: Request, response: Response): Promise<void> {
  try {
    const page = await getPublicCommitteeGovernanceEvents(parseEventCursor(request.query.cursor), parsePublicLimit(request.query.limit));
    sendSuccessResponse(response, 200, 'Đã lấy nhật ký quản trị công khai.', {
      items: page.items,
      nextCursor: page.nextCursor ? Buffer.from(JSON.stringify(page.nextCursor)).toString('base64url') : null
    });
  } catch (error) {
    sendErrorFromUnknown(response, error, 'Không thể lấy nhật ký quản trị công khai.');
  }
}

/** Trả quyết định giải ngân cùng bộ chữ ký đã xác minh để công chúng tải về và tự đối soát. */
export async function handleGetPublicCommitteeDecisions(request: Request, response: Response): Promise<void> {
  try {
    const page = await getPublicCommitteeDecisions(parseDecisionCursor(request.query.cursor), parsePublicLimit(request.query.limit));
    sendSuccessResponse(response, 200, 'Đã lấy quyết định Ủy ban công khai.', {
      items: page.items,
      nextCursor: page.nextCursor ? Buffer.from(JSON.stringify({ ...page.nextCursor, recordedAt: page.nextCursor.recordedAt.toISOString() })).toString('base64url') : null
    });
  } catch (error) {
    sendErrorFromUnknown(response, error, 'Không thể lấy quyết định Ủy ban công khai.');
  }
}
