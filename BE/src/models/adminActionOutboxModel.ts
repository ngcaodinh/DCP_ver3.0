import mongoose, { Schema, type ClientSession } from 'mongoose';

export type AdminActionOutboxEventType =
  | 'MANUAL_APPROVE_TRANSFER'
  | 'MANUAL_REJECT_TRANSFER'
  | 'SBT_MINT_RERUN';
export type AdminActionOutboxStatus = 'PENDING' | 'PROCESSING' | 'DISPATCHED';

export type AdminActionOutboxRecord = {
  eventId: string;
  eventType: AdminActionOutboxEventType;
  payload: Record<string, unknown>;
  status: AdminActionOutboxStatus;
  attempts: number;
  availableAt: Date;
  lockedAt: Date | null;
  dispatchedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

const adminActionOutboxSchema = new Schema<AdminActionOutboxRecord>({
  eventId: { type: String, required: true, unique: true },
  eventType: {
    type: String,
    required: true,
    enum: ['MANUAL_APPROVE_TRANSFER', 'MANUAL_REJECT_TRANSFER', 'SBT_MINT_RERUN'],
    index: true
  },
  payload: { type: Schema.Types.Mixed, required: true },
  status: { type: String, required: true, enum: ['PENDING', 'PROCESSING', 'DISPATCHED'], default: 'PENDING', index: true },
  attempts: { type: Number, required: true, default: 0 },
  availableAt: { type: Date, required: true, index: true },
  lockedAt: { type: Date, default: null },
  dispatchedAt: { type: Date, default: null },
  createdAt: { type: Date, required: true, default: Date.now },
  updatedAt: { type: Date, required: true, default: Date.now }
}, { versionKey: false });

adminActionOutboxSchema.index({ status: 1, availableAt: 1 });

export const AdminActionOutboxModel = mongoose.models.AdminActionOutbox
  || mongoose.model<AdminActionOutboxRecord>('AdminActionOutbox', adminActionOutboxSchema, 'admin_action_outbox');

/** Ghi event dispatch trong cùng transaction với business state/audit. */
export async function createAdminActionOutbox(
  data: Pick<AdminActionOutboxRecord, 'eventId' | 'eventType' | 'payload'>,
  session?: ClientSession
): Promise<AdminActionOutboxRecord> {
  const document = new AdminActionOutboxModel({
    ...data,
    status: 'PENDING',
    attempts: 0,
    availableAt: new Date(),
    lockedAt: null,
    dispatchedAt: null,
    updatedAt: new Date()
  });
  await document.save(session ? { session } : undefined);
  return document.toObject();
}

/** Claim nguyên tử một event để nhiều worker không dispatch trùng. */
export async function claimAdminActionOutbox(
  now: Date,
  staleBefore: Date,
  eventId?: string
): Promise<AdminActionOutboxRecord | null> {
  return AdminActionOutboxModel.findOneAndUpdate(
    {
      ...(eventId ? { eventId } : {}),
      $or: [
        { status: 'PENDING', availableAt: { $lte: now } },
        { status: 'PROCESSING', lockedAt: { $lte: staleBefore } }
      ]
    },
    {
      $set: { status: 'PROCESSING', lockedAt: now, updatedAt: now },
      $inc: { attempts: 1 }
    },
    { sort: { availableAt: 1, createdAt: 1 }, returnDocument: 'after' }
  ).lean<AdminActionOutboxRecord>().exec();
}

export async function markAdminActionOutboxDispatched(
  eventId: string,
  dispatchedAt: Date,
  session?: ClientSession
): Promise<void> {
  const query = AdminActionOutboxModel.updateOne(
    { eventId, status: 'PROCESSING' },
    { $set: { status: 'DISPATCHED', dispatchedAt, lockedAt: null, updatedAt: dispatchedAt } }
  );
  if (session) query.session(session);
  await query.exec();
}

export async function releaseAdminActionOutbox(eventId: string, availableAt: Date): Promise<void> {
  await AdminActionOutboxModel.updateOne(
    { eventId, status: 'PROCESSING' },
    { $set: { status: 'PENDING', availableAt, lockedAt: null, updatedAt: new Date() } }
  ).exec();
}
