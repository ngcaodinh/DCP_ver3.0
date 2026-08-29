import type { GpsCoordinate } from '../models/projectGeofenceModel';

/** Tính khoảng cách hai tọa độ bằng Haversine, dùng chung cho Oracle lịch sử và portal Ủy ban. */
export function haversineDistance(a: GpsCoordinate, b: GpsCoordinate): number {
  const earthRadiusMeters = 6_371_000;
  const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;
  const latitudeDelta = toRadians(b.lat - a.lat);
  const longitudeDelta = toRadians(b.lng - a.lng);
  const h = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(toRadians(a.lat)) * Math.cos(toRadians(b.lat)) * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * earthRadiusMeters * Math.asin(Math.sqrt(h));
}

/** Kiểm tra điểm có nằm trong polygon bằng ray-casting trên hệ tọa độ nhỏ của geofence. */
export function isPointInsidePolygon(point: GpsCoordinate, polygon: GpsCoordinate[]): boolean {
  let isInside = false;
  for (let index = 0, previousIndex = polygon.length - 1; index < polygon.length; previousIndex = index, index += 1) {
    const current = polygon[index];
    const previous = polygon[previousIndex];
    if (!current || !previous) continue;
    const crossesLatitude = (current.lat > point.lat) !== (previous.lat > point.lat);
    const intersectionLongitude = ((previous.lng - current.lng) * (point.lat - current.lat))
      / (previous.lat - current.lat) + current.lng;
    if (crossesLatitude && point.lng < intersectionLongitude) isInside = !isInside;
  }
  return isInside;
}

/** Trả điểm gần nhất trên một cạnh theo phép chiếu phẳng cục bộ, rồi đo thật bằng Haversine. */
function nearestPointOnSegment(point: GpsCoordinate, start: GpsCoordinate, end: GpsCoordinate): GpsCoordinate {
  const metersPerLatitudeDegree = 111_320;
  const metersPerLongitudeDegree = metersPerLatitudeDegree * Math.cos((point.lat * Math.PI) / 180);
  const endX = (end.lng - start.lng) * metersPerLongitudeDegree;
  const endY = (end.lat - start.lat) * metersPerLatitudeDegree;
  const pointX = (point.lng - start.lng) * metersPerLongitudeDegree;
  const pointY = (point.lat - start.lat) * metersPerLatitudeDegree;
  const squaredLength = endX * endX + endY * endY;
  const ratio = squaredLength === 0 ? 0 : Math.max(0, Math.min(1, (pointX * endX + pointY * endY) / squaredLength));
  return {
    lat: start.lat + ((end.lat - start.lat) * ratio),
    lng: start.lng + ((end.lng - start.lng) * ratio)
  };
}

/** Tính khoảng cách tới mép polygon, bằng 0 với điểm bên trong. */
export function distanceFromPointToPolygonMeters(point: GpsCoordinate, polygon: GpsCoordinate[]): number {
  if (polygon.length < 3 || isPointInsidePolygon(point, polygon)) return 0;
  let minDistanceMeters = Number.POSITIVE_INFINITY;
  for (let index = 0; index < polygon.length; index += 1) {
    const start = polygon[index];
    const end = polygon[(index + 1) % polygon.length];
    if (!start || !end) continue;
    minDistanceMeters = Math.min(minDistanceMeters, haversineDistance(point, nearestPointOnSegment(point, start, end)));
  }
  return Number.isFinite(minDistanceMeters) ? minDistanceMeters : 0;
}
