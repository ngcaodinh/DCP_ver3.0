import mongoose, { Schema } from 'mongoose';

export type SystemErrorLogReadState = {
  id: string;
  adminUserId: string;
  logId: string;
  isRead: boolean;
  readAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

const systemErrorLogReadStateSchema = new Schema<SystemErrorLogReadState>({
  id: { type: String, required: true, unique: true },
  adminUserId: { type: String, required: true, index: true },
  logId: { type: String, required: true, index: true },
  isRead: { type: Boolean, required: true, default: true },
  readAt: { type: Date, default: null },
  createdAt: { type: Date, required: true },
  updatedAt: { type: Date, required: true }
});

systemErrorLogReadStateSchema.index(
  { adminUserId: 1, logId: 1 },
  { unique: true }
);

const SystemErrorLogReadStateModel = mongoose.model<SystemErrorLogReadState>(
  'SystemErrorLogReadState',
  systemErrorLogReadStateSchema
);

/**
 * Hàm lấy trạng thái đã đọc của admin theo danh sách logId.
 * Mục đích: đồng bộ trạng thái đọc/chưa đọc giữa backend và giao diện quản trị.
 */
export async function findSystemErrorReadStatesByAdminUserIdAndLogIdList(
  adminUserId: string,
  logIdList: string[]
): Promise<SystemErrorLogReadState[]> {
  if (!logIdList.length) {
    return [];
  }

  return SystemErrorLogReadStateModel.find({
    adminUserId,
    logId: { $in: logIdList }
  })
    .lean<SystemErrorLogReadState[]>()
    .exec();
}

/**
 * Hàm cập nhật trạng thái đã đọc cho một log lỗi.
 * Mục đích: cho phép admin đánh dấu đã đọc/chưa đọc và lưu trạng thái bền vững trong MongoDB.
 */
export async function upsertSystemErrorReadState(
  adminUserId: string,
  logId: string,
  isRead: boolean
): Promise<SystemErrorLogReadState> {
  const currentDate = new Date();

  const updatedStateDocument = await SystemErrorLogReadStateModel.findOneAndUpdate(
    { adminUserId, logId },
    {
      $set: {
        isRead,
        readAt: isRead ? currentDate : null,
        updatedAt: currentDate
      },
      $setOnInsert: {
        id: crypto.randomUUID(),
        adminUserId,
        logId,
        createdAt: currentDate
      }
    },
    {
      upsert: true,
      returnDocument: 'after'
    }
  ).exec();

  if (!updatedStateDocument) {
    return {
      id: crypto.randomUUID(),
      adminUserId,
      logId,
      isRead,
      readAt: isRead ? currentDate : null,
      createdAt: currentDate,
      updatedAt: currentDate
    };
  }

  return updatedStateDocument.toObject() as SystemErrorLogReadState;
}

