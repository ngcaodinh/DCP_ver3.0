import mongoose, { Schema } from 'mongoose';

export type OrganizationActivationLockRecord = {
  organizationId: string;
  lockedByProjectId: string;
  expiresAt: Date;
  updatedAt: Date;
};

const organizationActivationLockSchema = new Schema<OrganizationActivationLockRecord>({
  organizationId: { type: String, required: true, unique: true },
  lockedByProjectId: { type: String, required: true },
  expiresAt: { type: Date, required: true },
  updatedAt: { type: Date, required: true }
}, { collection: 'organization_activation_locks' });

organizationActivationLockSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const OrganizationActivationLockMongoModel = mongoose.models?.OrganizationActivationLock
  || mongoose.model<OrganizationActivationLockRecord>('OrganizationActivationLock', organizationActivationLockSchema);

/** Giành khóa theo tổ chức để tuần tự hóa phép đếm và kích hoạt các dự án cùng tổ chức trên nhiều worker. */
export async function claimOrganizationActivationLock(organizationId: string, projectId: string, expiresAt: Date): Promise<boolean> {
  try {
    const lock = await OrganizationActivationLockMongoModel.findOneAndUpdate(
      {
        organizationId,
        $or: [{ expiresAt: { $lte: new Date() } }, { lockedByProjectId: projectId }]
      },
      { $set: { lockedByProjectId: projectId, expiresAt, updatedAt: new Date() } },
      { returnDocument: 'after', upsert: true }
    ).lean<OrganizationActivationLockRecord>().exec();

    return lock?.lockedByProjectId === projectId;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 11000) {
      return false;
    }
    throw error;
  }
}

/** Nhả đúng khóa mà dự án đang sở hữu để worker kế tiếp của tổ chức có thể tiếp tục. */
export async function releaseOrganizationActivationLock(organizationId: string, projectId: string): Promise<void> {
  await OrganizationActivationLockMongoModel.deleteOne({ organizationId, lockedByProjectId: projectId }).exec();
}
