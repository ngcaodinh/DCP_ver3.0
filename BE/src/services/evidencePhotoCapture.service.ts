import crypto from 'crypto';
import { EVIDENCE_CAPTURE_POLICY } from '../constants/evidenceCapturePolicy';
import { type EvidencePhotoModule } from '../models/evidencePhotoRegistryModel';
import { findEvidencePhotoRegistryBySha256FromRepository } from '../repositories/evidencePhotoRegistryRepository';
import { detectFileTypeFromBuffer } from './upload-validation.service';
import { unpinProjectEvidenceCidFromPinataWithRetry, uploadProjectEvidenceFileToPinataWithRetry } from './projectService';
import { ApplicationError } from '../utils/applicationError';
import { getLogger } from '../config/logger';

export interface CapturedEvidencePhotoInput {
  fileName: string;
  mimeType: 'image/jpeg';
  contentBase64: string;
  gps: { latitude: number; longitude: number };
  accuracyMeters: number;
  capturedAtClient: string;
  geolocationTimestamp: string;
  lowAccuracyOverride: boolean;
  overrideUnlockedAfterMs: number | null;
  lowAccuracyReason: string | null;
}

export interface StoredEvidencePhoto extends Omit<CapturedEvidencePhotoInput, 'contentBase64' | 'capturedAtClient'> {
  cid: string;
  contentSha256: string;
  capturedAt: Date;
  capturedAtClient: Date;
  clockSkewSeconds: number;
}

const logger = getLogger();

/** Kiểm tra chuỗi base64 canonical để Node không âm thầm bỏ qua ký tự không hợp lệ. */
function isValidBase64(value: string): boolean {
  return /^[A-Za-z0-9+/]*={0,2}$/.test(value) && value.length % 4 === 0;
}

/** Gỡ các CID vừa upload nhưng chưa được registry tham chiếu để tránh ảnh mồ côi trên Pinata. */
export async function cleanupCapturedEvidencePhotos(
  photos: Array<Pick<StoredEvidencePhoto, 'cid' | 'contentSha256'>>
): Promise<void> {
  const cleanupCandidates = await Promise.all(photos.map(async photo => {
    try {
      // Kiểm tra lại registry trước khi gỡ pin để không xóa CID đã được request khác ghi nhận thành công.
      const existingPhoto = await findEvidencePhotoRegistryBySha256FromRepository(photo.contentSha256);
      return existingPhoto ? null : photo.cid;
    } catch (error) {
      logger.warn('Không thể kiểm tra registry trước khi cleanup ảnh Pinata.', {
        contentSha256: photo.contentSha256,
        errorMessage: error instanceof Error ? error.message : 'Unknown error'
      });
      return null;
    }
  }));

  const uniqueCids = [...new Set(cleanupCandidates.filter((cid): cid is string => Boolean(cid)))];
  const cleanupResults = await Promise.allSettled(uniqueCids.map(cid => unpinProjectEvidenceCidFromPinataWithRetry(cid)));
  cleanupResults.forEach((result, index) => {
    if (result.status === 'rejected') {
      logger.warn('Không thể cleanup ảnh mồ côi trên Pinata.', {
        cid: uniqueCids[index],
        errorMessage: result.reason instanceof Error ? result.reason.message : 'Unknown error'
      });
    }
  });
}

/** Kiểm tra, chống trùng và pin ảnh camera mà không phụ thuộc vào nghiệp vụ gọi nó. */
export async function processCapturedEvidencePhotos(input: {
  photos: CapturedEvidencePhotoInput[];
  module: EvidencePhotoModule;
  ownerUserId: string;
  clientSubmittedAt: string;
  serverReceivedAt: Date;
}): Promise<StoredEvidencePhoto[]> {
  const clientSubmittedAt = new Date(input.clientSubmittedAt);
  if (Number.isNaN(clientSubmittedAt.getTime())) throw new ApplicationError('Thời điểm gửi không hợp lệ.', 400, 'VALIDATION_ERROR');
  if (input.photos.length > EVIDENCE_CAPTURE_POLICY.maxPhotos) throw new ApplicationError('Số lượng ảnh vượt giới hạn.', 400, 'VALIDATION_ERROR');

  const clockOffsetMs = input.serverReceivedAt.getTime() - clientSubmittedAt.getTime();
  if (Math.abs(clockOffsetMs) > EVIDENCE_CAPTURE_POLICY.maxClockSkewMs) {
    throw new ApplicationError('Đồng hồ thiết bị đang lệch quá lớn.', 400, 'CLOCK_SKEW_TOO_LARGE');
  }

  const decoded = input.photos.map(photo => {
    if (!isValidBase64(photo.contentBase64)) throw new ApplicationError('Nội dung ảnh không hợp lệ.', 400, 'VALIDATION_ERROR');
    return { photo, buffer: Buffer.from(photo.contentBase64, 'base64') };
  });
  let totalBytes = 0;
  const hashes = new Set<string>();
  const photoHashes: string[] = [];

  for (const item of decoded) {
    const capturedAtClient = new Date(item.photo.capturedAtClient);
    const geolocationTimestamp = new Date(item.photo.geolocationTimestamp);
    const photoAgeMs = clientSubmittedAt.getTime() - capturedAtClient.getTime();
    if (Number.isNaN(photoAgeMs) || photoAgeMs > EVIDENCE_CAPTURE_POLICY.maxPhotoAgeMs || photoAgeMs < -EVIDENCE_CAPTURE_POLICY.maxFuturePhotoAgeMs) {
      throw new ApplicationError('Ảnh chụp đã hết hiệu lực.', 400, 'CAPTURE_EXPIRED');
    }
    if (Number.isNaN(geolocationTimestamp.getTime()) || Math.abs(geolocationTimestamp.getTime() - capturedAtClient.getTime()) > EVIDENCE_CAPTURE_POLICY.maxGeolocationTimestampDeltaMs) {
      throw new ApplicationError('Thời điểm định vị không khớp với ảnh chụp.', 400, 'VALIDATION_ERROR');
    }
    if (item.buffer.length < EVIDENCE_CAPTURE_POLICY.minPhotoBytes) throw new ApplicationError('Nội dung ảnh không hợp lệ.', 400, 'VALIDATION_ERROR');

    totalBytes += item.buffer.length;
    if (item.buffer.length > EVIDENCE_CAPTURE_POLICY.maxPhotoBytes || totalBytes > EVIDENCE_CAPTURE_POLICY.maxTotalBytes) {
      throw new ApplicationError('Kích thước ảnh vượt giới hạn.', 413, 'FILE_TOO_LARGE');
    }
    if (detectFileTypeFromBuffer(item.buffer.subarray(0, 16)).mimeType !== 'image/jpeg') {
      throw new ApplicationError('Chỉ chấp nhận ảnh JPEG chụp từ camera.', 415, 'UNSUPPORTED_MEDIA_TYPE');
    }
    if (item.photo.accuracyMeters > EVIDENCE_CAPTURE_POLICY.maxOverrideAccuracyMeters) {
      throw new ApplicationError('Độ chính xác GPS vượt ngưỡng van thoát cho phép.', 400, 'VALIDATION_ERROR');
    }
    if (!item.photo.lowAccuracyOverride && item.photo.accuracyMeters > EVIDENCE_CAPTURE_POLICY.maxAccuracyMeters) {
      throw new ApplicationError('Độ chính xác GPS chưa đạt ngưỡng.', 400, 'VALIDATION_ERROR');
    }
    const lowAccuracyReason = item.photo.lowAccuracyReason?.trim() || '';
    if (item.photo.lowAccuracyOverride && (lowAccuracyReason.length < 20 || lowAccuracyReason.length > 300)) {
      throw new ApplicationError('Cần nêu lý do chụp qua van thoát từ 20 đến 300 ký tự.', 400, 'LOW_ACCURACY_REASON_REQUIRED');
    }
    if (item.photo.lowAccuracyOverride && (item.photo.overrideUnlockedAfterMs === null || item.photo.overrideUnlockedAfterMs < EVIDENCE_CAPTURE_POLICY.overrideUnlockDelayMs)) {
      throw new ApplicationError('Van thoát độ chính xác chưa đủ thời gian chờ.', 400, 'VALIDATION_ERROR');
    }
    if (!item.photo.lowAccuracyOverride && item.photo.overrideUnlockedAfterMs !== null) {
      throw new ApplicationError('Metadata van thoát không hợp lệ.', 400, 'VALIDATION_ERROR');
    }

    const contentSha256 = crypto.createHash('sha256').update(item.buffer).digest('hex');
    if (hashes.has(contentSha256)) throw new ApplicationError('Ảnh này đã được dùng cho bản ghi khác.', 409, 'DUPLICATE_EVIDENCE_PHOTO');
    hashes.add(contentSha256);
    photoHashes.push(contentSha256);
  }

  const existingPhotos = await Promise.all(photoHashes.map(contentSha256 => findEvidencePhotoRegistryBySha256FromRepository(contentSha256)));
  if (existingPhotos.some(Boolean)) throw new ApplicationError('Ảnh này đã được dùng cho bản ghi khác.', 409, 'DUPLICATE_EVIDENCE_PHOTO');

  const storedPhotos: StoredEvidencePhoto[] = [];
  try {
    for (const [index, item] of decoded.entries()) {
      // Upload tuần tự để luôn biết đầy đủ CID đã tạo nếu một ảnh tiếp theo bị lỗi và cần bù trừ.
      const uploaded = await uploadProjectEvidenceFileToPinataWithRetry({ fileName: item.photo.fileName, mimeType: item.photo.mimeType, contentBase64: item.photo.contentBase64 });
      const capturedAtClient = new Date(item.photo.capturedAtClient);
      const { contentBase64, ...photoMetadata } = item.photo;
      // Cố ý loại bỏ dữ liệu nhị phân thô khỏi metadata trước khi lưu Mongo.
      void contentBase64;
      storedPhotos.push({
        // Không đưa base64 vào metadata lưu Mongo để tránh vừa lộ dữ liệu thô vừa vi phạm schema strict.
        ...photoMetadata,
        cid: uploaded.cid,
        contentSha256: photoHashes[index],
        capturedAt: new Date(capturedAtClient.getTime() + clockOffsetMs),
        capturedAtClient,
        clockSkewSeconds: Math.round(clockOffsetMs / 1000)
      });
    }
    return storedPhotos;
  } catch (error) {
    await cleanupCapturedEvidencePhotos(storedPhotos);
    throw error;
  }
}
