import mongoose, { Schema } from 'mongoose';

export type NotificationType = 'DONATION_RECEIVED' | 'DISBURSEMENT_SIGNED' | 'PROJECT_APPROVED' | 'KYC_EXPIRING' | 'SYSTEM';

export type Notification = {
  notificationId: string;
  userId: string;
  notificationType: NotificationType;
  title: string;
  content: string;
  isRead: boolean;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
};

const notificationSchema = new Schema<Notification>(
  {
    notificationId: { type: String, required: true, unique: true },
    userId: { type: String, required: true, index: true },
    notificationType: { type: String, required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 160 },
    content: { type: String, required: true, trim: true, maxlength: 500 },
    isRead: { type: Boolean, required: true, default: false, index: true },
    metadata: { type: Schema.Types.Mixed, required: true, default: {} }
  },
  { timestamps: true }
);

notificationSchema.index({ userId: 1, isRead: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, createdAt: -1 });

export const NotificationModel = mongoose.models.Notification || mongoose.model<Notification>('Notification', notificationSchema);
