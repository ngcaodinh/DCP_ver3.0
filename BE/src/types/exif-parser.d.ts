/**
 * Type declarations cho exif-parser (không có @types/exif-parser trên npm).
 * Chỉ khai báo các fields được dùng trong oracle service.
 */
declare module 'exif-parser' {
  export type ExifGpsData = {
    GPSLatitude?: number;
    GPSLongitude?: number;
    GPSLatitudeRef?: string;  // 'N' | 'S'
    GPSLongitudeRef?: string; // 'E' | 'W'
    GPSAltitude?: number;
    GPSAltitudeRef?: number;
    GPSTimestamp?: number;
    GPSImgDirection?: number;
  };

  export type ExifImageData = {
    Make?: string;
    Model?: string;
    DateTime?: number;
    DateTimeOriginal?: number;
    Orientation?: number;
  };

  export type ExifResult = {
    tags: ExifGpsData & ExifImageData & Record<string, unknown>;
    imageSize?: { width: number; height: number };
  };

  export type ExifParser = {
    parse(): ExifResult;
    enableSimpleValues(enable: boolean): ExifParser;
    enablePointers(enable: boolean): ExifParser;
    enableReturnTags(enable: boolean): ExifParser;
  };

  export function create(buffer: Buffer): ExifParser;
}
