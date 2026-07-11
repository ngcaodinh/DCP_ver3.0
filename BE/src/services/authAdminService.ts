import { getLogger } from '../config/logger';
import { incrementAuthVersion, updateUser, findUserById } from '../models/authModel';
import { disconnectUserSockets } from '../config/socketServer';
import { getRedisClientIfReady } from '../config/redis';

const logger = getLogger();

/**
 * Thay đổi role của user và invalidate tất cả JWT + socket connections hiện tại.
 * Dùng bởi admin để promote/demote user hoặc revoke quyền.
 * [S-NEW2 fix]
 * 
 * @param userId - ID của user cần thay đổi role
 * @param newRole - Role mới ('admin', 'regulatory', 'donor', 'organization')
 * @param adminUserId - ID của admin thực hiện thao tác (để audit log)
 */
export async function changeUserRole(
  userId: string,
  newRole: string,
  adminUserId: string
): Promise<void> {
  const user = await findUserById(userId);
  if (!user) {
    throw new Error(`User ${userId} not found`);
  }

  const oldRole = user.role;
  if (oldRole === newRole) {
    logger.info('Role không thay đổi, bỏ qua.', { userId, role: newRole });
    return;
  }

  // Bước 1: Tăng authVersion trong DB
  const newAuthVersion = await incrementAuthVersion(userId);
  
  // Bước 2: Clear Redis cache authVersion (nếu có) để middleware socket load giá trị mới
  const redis = getRedisClientIfReady();
  if (redis) {
    try {
      await redis.del(`auth_version:${userId}`);
    } catch (err) {
      logger.warn('Clear Redis authVersion cache thất bại.', {
        userId,
        errorMessage: String(err)
      });
    }
  }

  // Bước 3: Update role trong DB
  user.role = newRole;
  user.authVersion = newAuthVersion;
  await updateUser(user);

  // Bước 4: Disconnect tất cả socket connections hiện tại của user
  disconnectUserSockets(userId);

  logger.info('Thay đổi role user thành công và invalidate sessions.', {
    userId,
    oldRole,
    newRole,
    newAuthVersion,
    adminUserId
  });
}

/**
 * Revoke quyền truy cập của user ngay lập tức.
 * Tương tự changeUserRole nhưng không thay đổi role, chỉ invalidate sessions.
 * [S-NEW2 fix]
 * 
 * @param userId - ID của user cần revoke
 * @param reason - Lý do revoke (để audit log)
 * @param adminUserId - ID của admin thực hiện thao tác
 */
export async function revokeUserAccess(
  userId: string,
  reason: string,
  adminUserId: string
): Promise<void> {
  const user = await findUserById(userId);
  if (!user) {
    throw new Error(`User ${userId} not found`);
  }

  // Bước 1: Tăng authVersion để invalidate tất cả JWT cũ
  const newAuthVersion = await incrementAuthVersion(userId);

  // Bước 2: Clear Redis cache
  const redis = getRedisClientIfReady();
  if (redis) {
    try {
      await redis.del(`auth_version:${userId}`);
    } catch (err) {
      logger.warn('Clear Redis authVersion cache thất bại.', {
        userId,
        errorMessage: String(err)
      });
    }
  }

  // Bước 3: Disconnect tất cả socket connections
  disconnectUserSockets(userId);

  logger.warn('Revoke user access thành công.', {
    userId,
    reason,
    newAuthVersion,
    adminUserId
  });
}
