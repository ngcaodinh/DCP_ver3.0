/** Tọa độ một đỉnh polygon geofence theo decimal degrees. */
export interface GeofencePoint {
  lat: number;
  lng: number;
}

/** Số đỉnh tối thiểu để tạo polygon hợp lệ. */
export const MIN_GEOFENCE_POLYGON_POINTS = 3;

/** Số đỉnh tối đa để giữ thao tác và payload ở mức hữu hạn. */
export const MAX_GEOFENCE_POLYGON_POINTS = 100;

/** Diện tích từ mức này trở lên chỉ hiển thị cảnh báo thông tin cho người dùng. */
export const GEOFENCE_AREA_WARNING_KM2 = 100;

/** Sai số nhỏ để so sánh các phép tính hình học theo decimal degrees. */
const GEOMETRY_EPSILON = 1e-12;

/** Kiểm tra hai điểm có cùng tọa độ tuyệt đối hay không. */
function areSamePoints(firstPoint: GeofencePoint, secondPoint: GeofencePoint): boolean {
  return firstPoint.lat === secondPoint.lat && firstPoint.lng === secondPoint.lng;
}

/** Phát hiện điểm xuất hiện lặp lại trong polygon đang vẽ. */
function hasDuplicatePoints(points: GeofencePoint[]): boolean {
  return points.some((point, pointIndex) => (
    points.slice(pointIndex + 1).some(candidatePoint => areSamePoints(point, candidatePoint))
  ));
}

/** Tính hai lần diện tích có dấu theo công thức Shoelace để nhận diện polygon suy biến. */
function calculateDoubleSignedArea(points: GeofencePoint[]): number {
  return points.reduce((area, point, pointIndex) => {
    const nextPoint = points[(pointIndex + 1) % points.length];
    return area + point.lng * nextPoint.lat - nextPoint.lng * point.lat;
  }, 0);
}

/** Tính hướng quay của ba điểm để kiểm tra giao cắt hai đoạn thẳng. */
function calculateOrientation(firstPoint: GeofencePoint, secondPoint: GeofencePoint, thirdPoint: GeofencePoint): number {
  return (secondPoint.lng - firstPoint.lng) * (thirdPoint.lat - firstPoint.lat)
    - (secondPoint.lat - firstPoint.lat) * (thirdPoint.lng - firstPoint.lng);
}

/** Kiểm tra một điểm thẳng hàng có nằm trên đoạn thẳng hữu hạn hay không. */
function isPointOnSegment(segmentStart: GeofencePoint, segmentEnd: GeofencePoint, point: GeofencePoint): boolean {
  return Math.abs(calculateOrientation(segmentStart, segmentEnd, point)) <= GEOMETRY_EPSILON
    && point.lat <= Math.max(segmentStart.lat, segmentEnd.lat) + GEOMETRY_EPSILON
    && point.lat >= Math.min(segmentStart.lat, segmentEnd.lat) - GEOMETRY_EPSILON
    && point.lng <= Math.max(segmentStart.lng, segmentEnd.lng) + GEOMETRY_EPSILON
    && point.lng >= Math.min(segmentStart.lng, segmentEnd.lng) - GEOMETRY_EPSILON;
}

/** Kiểm tra hai đoạn thẳng không kề nhau có giao nhau hoặc chạm nhau hay không. */
function doSegmentsIntersect(
  firstStart: GeofencePoint,
  firstEnd: GeofencePoint,
  secondStart: GeofencePoint,
  secondEnd: GeofencePoint
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

/** Kiểm tra hai cạnh có chung một đỉnh liền kề hợp lệ trong polygon hay không. */
function areAdjacentSegments(firstIndex: number, secondIndex: number, pointCount: number): boolean {
  return firstIndex === secondIndex
    || (firstIndex + 1) % pointCount === secondIndex
    || (secondIndex + 1) % pointCount === firstIndex;
}

/** Phát hiện polygon có các cạnh không kề nhau tự cắt hoặc chạm nhau. */
function hasSelfIntersection(points: GeofencePoint[]): boolean {
  return points.some((point, firstIndex) => {
    const firstEnd = points[(firstIndex + 1) % points.length];

    return points.some((secondPoint, secondIndex) => {
      if (secondIndex <= firstIndex || areAdjacentSegments(firstIndex, secondIndex, points.length)) {
        return false;
      }

      const secondEnd = points[(secondIndex + 1) % points.length];
      return doSegmentsIntersect(point, firstEnd, secondPoint, secondEnd);
    });
  });
}

/** Kiểm tra nhanh một tọa độ có hữu hạn và nằm trong biên độ địa lý hay không. */
function isValidPoint(point: GeofencePoint): boolean {
  return Number.isFinite(point.lat)
    && Number.isFinite(point.lng)
    && point.lat >= -90
    && point.lat <= 90
    && point.lng >= -180
    && point.lng <= 180;
}

/** Trả lỗi UX tiếng Việt nếu polygon không hợp lệ, hoặc null khi có thể lưu. */
export function validateGeofencePolygon(points: GeofencePoint[]): string | null {
  if (points.length < MIN_GEOFENCE_POLYGON_POINTS) {
    return `Polygon phải có ít nhất ${MIN_GEOFENCE_POLYGON_POINTS} điểm.`;
  }
  if (points.length > MAX_GEOFENCE_POLYGON_POINTS) {
    return `Polygon chỉ được có tối đa ${MAX_GEOFENCE_POLYGON_POINTS} điểm.`;
  }
  if (points.some(point => !isValidPoint(point))) {
    return 'Tọa độ polygon không hợp lệ.';
  }
  if (hasDuplicatePoints(points)) {
    return 'Polygon không được chứa điểm trùng lặp.';
  }
  if (hasSelfIntersection(points)) {
    return 'Polygon không được tự cắt.';
  }
  if (Math.abs(calculateDoubleSignedArea(points)) <= GEOMETRY_EPSILON) {
    return 'Polygon không được suy biến hoặc có diện tích bằng 0.';
  }

  return null;
}

/** Tính diện tích xấp xỉ km² để hiển thị thông tin, không dùng cho Oracle verdict. */
export function calculateGeofenceAreaKm2(points: GeofencePoint[]): number {
  if (points.length < MIN_GEOFENCE_POLYGON_POINTS) {
    return 0;
  }

  const areaInDegrees = Math.abs(calculateDoubleSignedArea(points)) / 2;
  const meanLatitude = points.reduce((sum, point) => sum + point.lat, 0) / points.length;
  const kilometersPerDegreeLatitude = 111.32;
  const kilometersPerDegreeLongitude = 111.32 * Math.cos((meanLatitude * Math.PI) / 180);
  return areaInDegrees * kilometersPerDegreeLatitude * kilometersPerDegreeLongitude;
}

/** Tính centroid trung bình của polygon hợp lệ để hiển thị bán kính Haversine trong editor. */
export function calculateGeofenceCentroid(points: GeofencePoint[]): GeofencePoint | null {
  if (points.length < MIN_GEOFENCE_POLYGON_POINTS) {
    return null;
  }

  const lat = points.reduce((sum, point) => sum + point.lat, 0) / points.length;
  const lng = points.reduce((sum, point) => sum + point.lng, 0) / points.length;
  return { lat, lng };
}
