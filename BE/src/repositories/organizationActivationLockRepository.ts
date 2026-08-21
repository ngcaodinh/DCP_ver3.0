import { claimOrganizationActivationLock, releaseOrganizationActivationLock } from '../models/organizationActivationLockModel';

/** Giành khóa activation theo tổ chức ở repository để service không phụ thuộc chi tiết Mongoose. */
export async function claimOrganizationActivationLockFromRepository(organizationId: string, projectId: string, expiresAt: Date): Promise<boolean> {
  return claimOrganizationActivationLock(organizationId, projectId, expiresAt);
}

/** Nhả khóa activation theo tổ chức sau khi workflow blockchain đã hoàn tất hoặc thất bại. */
export async function releaseOrganizationActivationLockFromRepository(organizationId: string, projectId: string): Promise<void> {
  await releaseOrganizationActivationLock(organizationId, projectId);
}
