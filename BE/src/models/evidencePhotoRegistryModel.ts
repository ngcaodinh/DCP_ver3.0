import mongoose, { type ClientSession, Schema } from 'mongoose';

export type EvidencePhotoModule = 'PROJECT_CHALLENGE' | 'AUDITOR_FIELD_REPORT' | 'LISTING_VERIFICATION' | 'DISBURSEMENT';

export interface EvidencePhotoRegistryRecord {
  contentSha256: string;
  cid: string;
  module: EvidencePhotoModule;
  ownerUserId: string;
  refId: string;
  createdAt: Date;
}

const evidencePhotoRegistrySchema = new Schema<EvidencePhotoRegistryRecord>({
  contentSha256: { type: String, required: true, unique: true },
  cid: { type: String, required: true, unique: true },
  module: { type: String, enum: ['PROJECT_CHALLENGE', 'AUDITOR_FIELD_REPORT', 'LISTING_VERIFICATION', 'DISBURSEMENT'], required: true },
  ownerUserId: { type: String, required: true },
  refId: { type: String, required: true },
  createdAt: { type: Date, required: true }
}, { collection: 'evidence_photo_registry' });

evidencePhotoRegistrySchema.index({ ownerUserId: 1, createdAt: -1 });
evidencePhotoRegistrySchema.index({ refId: 1 });

export const EvidencePhotoRegistryMongoModel = mongoose.models?.EvidencePhotoRegistry
  || mongoose.model<EvidencePhotoRegistryRecord>('EvidencePhotoRegistry', evidencePhotoRegistrySchema);

/** Ghi nhận ảnh đã pin trong cùng transaction với bản ghi nghiệp vụ tham chiếu. */
export async function createEvidencePhotoRegistryRecords(records: EvidencePhotoRegistryRecord[], session?: ClientSession): Promise<void> {
  if (!records.length) return;
  if (session) await EvidencePhotoRegistryMongoModel.insertMany(records, { session });
  else await EvidencePhotoRegistryMongoModel.insertMany(records);
}

/** Kiểm tra ảnh đã từng được dùng trước khi gọi dịch vụ pin tốn kém. */
export async function findEvidencePhotoRegistryBySha256(contentSha256: string): Promise<EvidencePhotoRegistryRecord | null> {
  return EvidencePhotoRegistryMongoModel.findOne({ contentSha256 }).lean<EvidencePhotoRegistryRecord>().exec();
}
