import mongoose, { Schema } from 'mongoose';

/**
 * Tọa độ GPS (decimal degrees).
 */
export type GpsCoordinate = {
  lat: number;
  lng: number;
};

/**
 * Ranh giới địa lý của dự án từ thiện.
 * Oracle dùng radiusMeters (Haversine) để kiểm tra ảnh minh chứng có chụp đúng địa điểm không.
 * polygon là danh sách điểm tạo thành vùng — centroid của polygon được dùng làm điểm tham chiếu Haversine.
 */
export type ProjectGeofenceRecord = {
  projectId: string;
  polygon: GpsCoordinate[];             // Vùng ranh giới dự án (ít nhất 3 điểm)
  centroid: GpsCoordinate;              // Trung tâm polygon, tính tự động khi save
  radiusMeters: number;                 // Bán kính chấp nhận (default 500, giới hạn 100-2000)
  createdAt: Date;
  updatedAt: Date;
};

const gpsCoordinateSchema = new Schema<GpsCoordinate>(
  { lat: { type: Number, required: true }, lng: { type: Number, required: true } },
  { _id: false }
);

const projectGeofenceSchema = new Schema<ProjectGeofenceRecord>(
  {
    projectId: { type: String, required: true, unique: true },
    polygon: {
      type: [gpsCoordinateSchema],
      required: true,
      validate: {
        validator: (v: GpsCoordinate[]) => v.length >= 3,
        message: 'Polygon phải có ít nhất 3 điểm.'
      }
    },
    centroid: { type: gpsCoordinateSchema, required: true },
    radiusMeters: {
      type: Number,
      required: true,
      default: 500,
      min: [100, 'Bán kính tối thiểu 100m'],
      max: [2000, 'Bán kính tối đa 2000m']
    }
  },
  { timestamps: true }
);

const ProjectGeofenceMongoModel = mongoose.model<ProjectGeofenceRecord>(
  'ProjectGeofence',
  projectGeofenceSchema,
  'project_geofences'
);

/** Lấy geofence của một dự án. */
export async function findGeofenceByProjectId(
  projectId: string
): Promise<ProjectGeofenceRecord | null> {
  return ProjectGeofenceMongoModel.findOne({ projectId }).lean().exec();
}

/** Tạo mới hoặc cập nhật geofence cho dự án (upsert). */
export async function upsertProjectGeofence(
  projectId: string,
  polygon: GpsCoordinate[],
  radiusMeters: number
): Promise<ProjectGeofenceRecord> {
  const centroid = computeCentroid(polygon);
  const doc = await ProjectGeofenceMongoModel.findOneAndUpdate(
    { projectId },
    { $set: { polygon, centroid, radiusMeters } },
    { upsert: true, new: true }
  ).lean().exec();
  if (!doc) throw new Error(`Upsert geofence thất bại cho projectId=${projectId}`);
  return doc;
}

/**
 * Tính centroid của polygon (trung bình cộng lat/lng).
 * Đủ chính xác cho polygon nhỏ (<5km) — không cần spherical centroid.
 */
export function computeCentroid(polygon: GpsCoordinate[]): GpsCoordinate {
  const n = polygon.length;
  const lat = polygon.reduce((sum, p) => sum + p.lat, 0) / n;
  const lng = polygon.reduce((sum, p) => sum + p.lng, 0) / n;
  return { lat, lng };
}
