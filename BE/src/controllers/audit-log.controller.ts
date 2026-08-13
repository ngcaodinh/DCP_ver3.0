import type { Response } from 'express';
import type { AuthenticatedRequest } from '../middleware/authenticationMiddleware';
import { listAdminAuditLogs } from '../services/audit-log.service';
import { auditLogListQuerySchema } from '../validators/audit-log.validator';
import { sendErrorFromUnknown, sendErrorResponse, sendSuccessResponse } from '../utils/apiResponse';

/** Trả danh sách audit canonical với filter/pagination đã validate tại boundary. */
export async function handleListAdminAuditLogs(
  request: AuthenticatedRequest,
  response: Response
): Promise<void> {
  const parsedQuery = auditLogListQuerySchema.safeParse(request.query);
  if (!parsedQuery.success) {
    sendErrorResponse(response, 400, 'Query audit log không hợp lệ.', 'VALIDATION_ERROR');
    return;
  }

  try {
    const result = await listAdminAuditLogs(parsedQuery.data);
    sendSuccessResponse(response, 200, 'Lấy audit log thành công.', result);
  } catch (error) {
    sendErrorFromUnknown(response, error, 'Không thể lấy audit log.');
  }
}
