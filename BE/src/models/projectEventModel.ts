import mongoose, { Schema } from 'mongoose';
import { IMMUTABLE_EVENT_TYPES, PROJECT_EVENT_TYPES, type ProjectEventType } from '../constants/projectEventTypes';
import type { ProjectEventRecord } from '../types/project-event.types';

const projectEventSchema = new Schema<ProjectEventRecord>({
  eventId: { type: String, required: true },
  eventType: { type: String, required: true, enum: PROJECT_EVENT_TYPES },
  projectId: { type: String, default: null },
  timestamp: { type: Date, required: true },
  walletAddress: { type: String, default: null },
  amount: { type: Number, default: null },
  correlationId: { type: String, default: null },
  organizationId: { type: String, default: null },
  payload: { type: Schema.Types.Mixed, required: true, default: {} },
  source: { type: String, required: true, enum: ['api', 'worker'] },
  archiveState: { type: String, required: true, enum: ['HOT', 'ARCHIVED'], default: 'HOT' },
  archivedAt: { type: Date, default: null },
  archiveLocator: { type: String, default: null },
  archiveChecksum: { type: String, default: null },
  createdAt: { type: Date, required: true, default: Date.now }
}, { versionKey: false });

// Đây là collection thường dù tên có "timeseries": unique eventId và cập nhật archiveState
// không được MongoDB hỗ trợ trên time-series collection, trong khi cả hai đều là invariant của G4.
projectEventSchema.index({ eventId: 1 }, { unique: true });
projectEventSchema.index({ eventType: 1, timestamp: -1 });
projectEventSchema.index({ projectId: 1, timestamp: -1 });
projectEventSchema.index({ archiveState: 1, timestamp: 1 });

export const ProjectEventModel = mongoose.models.ProjectEvent
  || mongoose.model<ProjectEventRecord>('ProjectEvent', projectEventSchema, 'project_events_timeseries');

/** Ghi một batch event theo ordered=false để retry không làm mất các event hợp lệ khác. */
export async function insertProjectEvents(records: ProjectEventRecord[]): Promise<void> {
  await ProjectEventModel.insertMany(records, { ordered: false });
}

/** Lấy các event HOT đến hạn archive theo timestamp nghiệp vụ, không theo thời điểm flush. */
export async function findHotEventsOlderThan(
  cutoff: Date,
  eventTypes: readonly ProjectEventType[],
  limit: number
): Promise<ProjectEventRecord[]> {
  return ProjectEventModel.find({
    archiveState: 'HOT',
    timestamp: { $lt: cutoff },
    eventType: { $in: eventTypes }
  })
    .sort({ timestamp: 1, eventId: 1 })
    .limit(limit)
    .lean<ProjectEventRecord[]>()
    .exec();
}

/** Lấy event regular đã archive đủ một năm để verify checksum trước khi xoá. */
export async function findArchivedRegularEventsOlderThan(
  cutoff: Date,
  limit: number
): Promise<ProjectEventRecord[]> {
  return ProjectEventModel.find({
    archiveState: 'ARCHIVED',
    timestamp: { $lt: cutoff },
    eventType: { $nin: IMMUTABLE_EVENT_TYPES }
  })
    .sort({ timestamp: 1, eventId: 1 })
    .limit(limit)
    .lean<ProjectEventRecord[]>()
    .exec();
}

/** Chuyển state archive chỉ khi record vẫn còn HOT để tránh ghi đè kết quả worker khác. */
export async function markProjectEventArchived(
  eventId: string,
  archivedAt: Date,
  archiveLocator: string,
  archiveChecksum: string
): Promise<boolean> {
  const result = await ProjectEventModel.updateOne(
    { eventId, archiveState: 'HOT' },
    {
      $set: {
        archiveState: 'ARCHIVED',
        archivedAt,
        archiveLocator,
        archiveChecksum
      }
    }
  ).exec();
  return result.modifiedCount === 1 || result.matchedCount === 1;
}

/** Xoá đúng các event regular đã verify checksum ngay trước đó, không đụng event bất biến. */
export async function deleteArchivedEventsOlderThan(
  cutoff: Date,
  eventIds: string[]
): Promise<number> {
  if (eventIds.length === 0) return 0;

  const result = await ProjectEventModel.deleteMany({
    eventId: { $in: eventIds },
    archiveState: 'ARCHIVED',
    timestamp: { $lt: cutoff },
    eventType: { $nin: IMMUTABLE_EVENT_TYPES }
  }).exec();
  return result.deletedCount;
}
