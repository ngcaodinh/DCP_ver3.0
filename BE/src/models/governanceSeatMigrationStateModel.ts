import mongoose, { Schema } from 'mongoose';

export interface GovernanceSeatMigrationState {
  migrationKey: 'governance-seat-slots';
  isLocked: boolean;
  lockedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const governanceSeatMigrationStateSchema = new Schema<GovernanceSeatMigrationState>({
  migrationKey: { type: String, required: true, unique: true, enum: ['governance-seat-slots'] },
  isLocked: { type: Boolean, required: true, default: false },
  lockedAt: { type: Date, default: null },
  completedAt: { type: Date, default: null }
}, { collection: 'governance_seat_migration_states', timestamps: true });

const GovernanceSeatMigrationStateMongoModel = mongoose.models?.GovernanceSeatMigrationState
  || mongoose.model<GovernanceSeatMigrationState>('GovernanceSeatMigrationState', governanceSeatMigrationStateSchema);

/** Đọc maintenance lock để mọi mutation roster cùng dừng trong cửa sổ migration/index build. */
export async function isGovernanceSeatMigrationLocked(): Promise<boolean> {
  const state = await GovernanceSeatMigrationStateMongoModel.findOne({ migrationKey: 'governance-seat-slots' })
    .select('isLocked')
    .lean<Pick<GovernanceSeatMigrationState, 'isLocked'>>()
    .exec();
  return state?.isLocked === true;
}
