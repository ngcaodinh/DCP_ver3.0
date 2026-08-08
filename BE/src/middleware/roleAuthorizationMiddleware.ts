import { NextFunction, Response } from 'express';
import { AuthenticatedRequest } from './authenticationMiddleware';
import { sendErrorResponse } from '../utils/apiResponse';
import { findUserById } from '../models/authModel';

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

/**
 * Tạo middleware kiểm tra role hiện tại và authVersion trước endpoint nhạy cảm.
 * Mục đích: không cho JWT cũ tiếp tục dùng quyền admin sau khi bị demote hoặc revoke.
 */
export function createFreshRoleAuthorizationMiddleware(allowedRoles: string[]) {
  return async (
    request: AuthenticatedRequest,
    response: Response,
    next: NextFunction
  ): Promise<void> => {
    const authenticatedUser = request.authenticatedUser;

    if (!authenticatedUser) {
      sendErrorResponse(response, 401, 'Bạn chưa đăng nhập hoặc phiên đăng nhập không hợp lệ.', 'UNAUTHENTICATED');
      return;
    }

    try {
      const currentUser = await findUserById(authenticatedUser.userId);
      const tokenAuthVersion = authenticatedUser.authVersion ?? 1;
      const currentAuthVersion = currentUser?.authVersion ?? 1;

      if (
        !currentUser
        || currentUser.accountStatus !== 'ACTIVE'
        || tokenAuthVersion !== currentAuthVersion
      ) {
        sendErrorResponse(response, 401, 'Phiên đăng nhập đã bị thu hồi hoặc không còn hợp lệ.', 'UNAUTHENTICATED');
        return;
      }

      if (!allowedRoles.includes(currentUser.role)) {
        sendErrorResponse(response, 403, 'Bạn không có quyền thực hiện hành động này.', 'FORBIDDEN');
        return;
      }

      // Dùng role hiện tại trong DB cho các handler phía sau, không dùng role cũ trong JWT.
      request.authenticatedUser = {
        ...authenticatedUser,
        role: currentUser.role,
        authVersion: currentAuthVersion
      };
      next();
    } catch {
      sendErrorResponse(
        response,
        503,
        'Không thể xác minh quyền truy cập. Vui lòng thử lại sau.',
        'AUTHORIZATION_UNAVAILABLE'
      );
    }
  };
}
