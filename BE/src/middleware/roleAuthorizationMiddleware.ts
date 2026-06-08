import { NextFunction, Response } from 'express';
import { AuthenticatedRequest } from './authenticationMiddleware';
import { sendErrorResponse } from '../utils/apiResponse';

/**
 * Hàm tạo middleware kiểm tra vai trò người dùng.
 * Mục đích: chỉ cho phép các role hợp lệ gọi API được bảo vệ.
 */
export function createRoleAuthorizationMiddleware(allowedRoles: string[]) {
  return (request: AuthenticatedRequest, response: Response, next: NextFunction): void => {
    const authenticatedUser = request.authenticatedUser;

    if (!authenticatedUser) {
      sendErrorResponse(response, 401, 'Bạn chưa đăng nhập hoặc phiên đăng nhập không hợp lệ.', 'UNAUTHENTICATED');
      return;
    }

    if (!allowedRoles.includes(authenticatedUser.role)) {
      sendErrorResponse(response, 403, 'Bạn không có quyền thực hiện hành động này.', 'FORBIDDEN');
      return;
    }

    next();
  };
}

