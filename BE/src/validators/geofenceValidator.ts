import { z } from 'zod';
import {
  MAX_GEOFENCE_POLYGON_POINTS,
  MIN_GEOFENCE_POLYGON_POINTS
} from '../constants/geofenceConstants';

/** Bán kính mặc định khi client không truyền trường radiusMeters. */
export const GEOFENCE_DEFAULT_RADIUS_METERS = 500;

/** Giới hạn thấp nhất của bán kính xác minh Haversine. */
export const GEOFENCE_MIN_RADIUS_METERS = 100;

/** Giới hạn cao nhất của bán kính xác minh Haversine. */
export const GEOFENCE_MAX_RADIUS_METERS = 2000;

/** Sai số nhỏ để so sánh hình học trên tọa độ decimal degrees. */
const GEOMETRY_EPSILON = 1e-12;

/** Điểm tọa độ đã được Zod kiểm tra kiểu và biên độ hợp lệ. */
const geofencePointSchema = z.object({
  lat: z.number({ invalid_type_error: 'Vĩ độ phải là số.' })
    .finite('Vĩ độ phải là số hữu hạn.')
    .min(-90, 'Vĩ độ phải nằm trong khoảng -90 đến 90.')
    .max(90, 'Vĩ độ phải nằm trong khoảng -90 đến 90.'),
  lng: z.number({ invalid_type_error: 'Kinh độ phải là số.' })
    .finite('Kinh độ phải là số hữu hạn.')
    .min(-180, 'Kinh độ phải nằm trong khoảng -180 đến 180.')
    .max(180, 'Kinh độ phải nằm trong khoảng -180 đến 180.')
}).strict('Mỗi điểm polygon chỉ được gồm lat và lng.');

/** Schema authoritative cho body API tạo hoặc cập nhật geofence. */
const geofenceRequestSchema = z.object({
  polygon: z.array(geofencePointSchema)
    .min(MIN_GEOFENCE_POLYGON_POINTS, `Polygon phải có ít nhất ${MIN_GEOFENCE_POLYGON_POINTS} điểm.`)
    .max(MAX_GEOFENCE_POLYGON_POINTS, `Polygon chỉ được có tối đa ${MAX_GEOFENCE_POLYGON_POINTS} điểm.`),
  radiusMeters: z.number({ invalid_type_error: 'radiusMeters phải là số.' })
    .finite('radiusMeters phải là số hữu hạn.')
    .min(GEOFENCE_MIN_RADIUS_METERS, `radiusMeters phải từ ${GEOFENCE_MIN_RADIUS_METERS}m.`)
    .max(GEOFENCE_MAX_RADIUS_METERS, `radiusMeters phải không quá ${GEOFENCE_MAX_RADIUS_METERS}m.`)
    .optional()
    .default(GEOFENCE_DEFAULT_RADIUS_METERS)
}).strict('Body geofence chỉ được gồm polygon và radiusMeters.')
  .superRefine((value, context) => {
    if (
      value.polygon.length < MIN_GEOFENCE_POLYGON_POINTS
      || value.polygon.length > MAX_GEOFENCE_POLYGON_POINTS
    ) {
      return;
    }

    if (hasDuplicatePolygonPoints(value.polygon)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['polygon'],
        message: 'Polygon không được chứa điểm trùng lặp.'
      });
      return;
    }

    if (hasSelfIntersection(value.polygon)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['polygon'],
        message: 'Polygon không được tự cắt.'
      });
      return;
    }

    if (isDegeneratePolygon(value.polygon)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['polygon'],
        message: 'Polygon không được suy biến hoặc có diện tích bằng 0.'
      });
    }
  });

/** Payload geofence sau khi qua toàn bộ kiểm tra tại API boundary. */
export type GeofenceRequestBody = z.infer<typeof geofenceRequestSchema>;

/** Chi tiết lỗi theo field để trả về theo API envelope hiện có. */
export interface GeofenceValidationError {
  field: string;
  message: string;
}

/** Kết quả thất bại khi payload geofence không đạt yêu cầu. */
interface InvalidGeofenceValidationResult {
  isValid: false;
  errors: GeofenceValidationError[];
}

/** Kết quả thành công với payload đã được narrow bởi Zod. */
interface ValidGeofenceValidationResult {
  isValid: true;
  data: GeofenceRequestBody;
  errors: [];
}

/** Kiểu kết quả validate body geofence để controller xử lý an toàn. */
export type GeofenceValidationResult = InvalidGeofenceValidationResult | ValidGeofenceValidationResult;

/** Kiểm tra hai điểm có cùng tọa độ tuyệt đối hay không. */
function areSamePoints(firstPoint: GeofenceRequestBody['polygon'][number], secondPoint: GeofenceRequestBody['polygon'][number]): boolean {
  return firstPoint.lat === secondPoint.lat && firstPoint.lng === secondPoint.lng;
}

/** Phát hiện điểm lặp trong polygon, bao gồm điểm đóng trùng điểm đầu. */
function hasDuplicatePolygonPoints(polygon: GeofenceRequestBody['polygon']): boolean {
  return polygon.some((point, pointIndex) => (
    polygon.slice(pointIndex + 1).some(candidatePoint => areSamePoints(point, candidatePoint))
  ));
}

/** Tính hai lần diện tích có dấu của polygon để nhận diện polygon suy biến. */
function calculateDoubleSignedArea(polygon: GeofenceRequestBody['polygon']): number {
  return polygon.reduce((area, point, pointIndex) => {
    const nextPoint = polygon[(pointIndex + 1) % polygon.length];
    return area + point.lng * nextPoint.lat - nextPoint.lng * point.lat;
  }, 0);
}

/** Kiểm tra polygon có diện tích thực tế bằng 0 hoặc các cạnh thẳng hàng hay không. */
function isDegeneratePolygon(polygon: GeofenceRequestBody['polygon']): boolean {
  return Math.abs(calculateDoubleSignedArea(polygon)) <= GEOMETRY_EPSILON;
}

/** Tính hướng quay của ba điểm phục vụ kiểm tra giao cắt hai đoạn thẳng. */
function calculateOrientation(
  firstPoint: GeofenceRequestBody['polygon'][number],
  secondPoint: GeofenceRequestBody['polygon'][number],
  thirdPoint: GeofenceRequestBody['polygon'][number]
): number {
  return (secondPoint.lng - firstPoint.lng) * (thirdPoint.lat - firstPoint.lat)
    - (secondPoint.lat - firstPoint.lat) * (thirdPoint.lng - firstPoint.lng);
}

/** Kiểm tra điểm thẳng hàng có nằm trên đoạn thẳng hữu hạn hay không. */
function isPointOnSegment(
  segmentStart: GeofenceRequestBody['polygon'][number],
  segmentEnd: GeofenceRequestBody['polygon'][number],
  point: GeofenceRequestBody['polygon'][number]
): boolean {
  return Math.abs(calculateOrientation(segmentStart, segmentEnd, point)) <= GEOMETRY_EPSILON
    && point.lat <= Math.max(segmentStart.lat, segmentEnd.lat) + GEOMETRY_EPSILON
    && point.lat >= Math.min(segmentStart.lat, segmentEnd.lat) - GEOMETRY_EPSILON
    && point.lng <= Math.max(segmentStart.lng, segmentEnd.lng) + GEOMETRY_EPSILON
    && point.lng >= Math.min(segmentStart.lng, segmentEnd.lng) - GEOMETRY_EPSILON;
}

/** Kiểm tra hai đoạn thẳng không kề nhau có giao nhau hoặc chạm nhau hay không. */
function doSegmentsIntersect(
  firstStart: GeofenceRequestBody['polygon'][number],
  firstEnd: GeofenceRequestBody['polygon'][number],
  secondStart: GeofenceRequestBody['polygon'][number],
  secondEnd: GeofenceRequestBody['polygon'][number]
): boolean {
  const firstStartOrientation = calculateOrientation(firstStart, firstEnd, secondStart);
  const firstEndOrientation = calculateOrientation(firstStart, firstEnd, secondEnd);
  const secondStartOrientation = calculateOrientation(secondStart, secondEnd, firstStart);
  const secondEndOrientation = calculateOrientation(secondStart, secondEnd, firstEnd);
  const hasProperIntersection = (
    ((firstStartOrientation > GEOMETRY_EPSILON && firstEndOrientation < -GEOMETRY_EPSILON)
      || (firstStartOrientation < -GEOMETRY_EPSILON && firstEndOrientation > GEOMETRY_EPSILON))
    && ((secondStartOrientation > GEOMETRY_EPSILON && secondEndOrientation < -GEOMETRY_EPSILON)
      || (secondStartOrientation < -GEOMETRY_EPSILON && secondEndOrientation > GEOMETRY_EPSILON))
  );

  return hasProperIntersection
    || isPointOnSegment(firstStart, firstEnd, secondStart)
    || isPointOnSegment(firstStart, firstEnd, secondEnd)
    || isPointOnSegment(secondStart, secondEnd, firstStart)
    || isPointOnSegment(secondStart, secondEnd, firstEnd);
}

/** Kiểm tra hai cạnh có chung đỉnh hợp lệ trong cùng một polygon hay không. */
function areAdjacentSegments(firstIndex: number, secondIndex: number, pointCount: number): boolean {
  return firstIndex === secondIndex
    || (firstIndex + 1) % pointCount === secondIndex
    || (secondIndex + 1) % pointCount === firstIndex;
}

/** Phát hiện các cạnh không kề nhau giao cắt, kể cả trường hợp chạm cạnh. */
function hasSelfIntersection(polygon: GeofenceRequestBody['polygon']): boolean {
  return polygon.some((point, firstIndex) => {
    const firstEnd = polygon[(firstIndex + 1) % polygon.length];

    return polygon.some((secondPoint, secondIndex) => {
      if (secondIndex <= firstIndex || areAdjacentSegments(firstIndex, secondIndex, polygon.length)) {
        return false;
      }

      const secondEnd = polygon[(secondIndex + 1) % polygon.length];
      return doSegmentsIntersect(point, firstEnd, secondPoint, secondEnd);
    });
  });
}

/** Parse unknown payload và chuẩn hóa lỗi Zod thành details theo field của API. */
export function validateGeofenceRequestBody(payload: unknown): GeofenceValidationResult {
  const validationResult = geofenceRequestSchema.safeParse(payload);
  if (!validationResult.success) {
    return {
      isValid: false,
      errors: validationResult.error.issues.map(issue => ({
        field: issue.path.join('.') || 'body',
        message: issue.message
      }))
    };
  }

  return { isValid: true, data: validationResult.data, errors: [] };
}
