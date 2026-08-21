import { type ClientSession } from 'mongoose';
import { createEvidencePhotoRegistryRecords, findEvidencePhotoRegistryBySha256, type EvidencePhotoRegistryRecord } from '../models/evidencePhotoRegistryModel';

/** Lưu registry ảnh qua repository để service không phụ thuộc trực tiếp vào Mongoose. */
export async function createEvidencePhotoRegistryRecordsFromRepository(records: EvidencePhotoRegistryRecord[], session?: ClientSession): Promise<void> {
  return createEvidencePhotoRegistryRecords(records, session);
}

/** Tìm hash ảnh đã tồn tại trước khi thực hiện upload Pinata. */
export async function findEvidencePhotoRegistryBySha256FromRepository(contentSha256: string): Promise<EvidencePhotoRegistryRecord | null> {
  return findEvidencePhotoRegistryBySha256(contentSha256);
}
