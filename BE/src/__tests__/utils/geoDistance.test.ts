import { describe, expect, it } from 'vitest';
import { distanceFromPointToPolygonMeters, haversineDistance, isPointInsidePolygon } from '../../utils/geoDistance';

const polygon = [
  { lat: 10, lng: 106 },
  { lat: 10, lng: 106.01 },
  { lat: 10.01, lng: 106.01 },
  { lat: 10.01, lng: 106 }
];

describe('geoDistance', () => {
  it('trả 0 cho điểm nằm trong geofence', () => {
    const point = { lat: 10.005, lng: 106.005 };
    expect(isPointInsidePolygon(point, polygon)).toBe(true);
    expect(distanceFromPointToPolygonMeters(point, polygon)).toBe(0);
  });

  it('đo khoảng cách tới mép thay vì tâm polygon', () => {
    const point = { lat: 10.005, lng: 106.012 };
    expect(isPointInsidePolygon(point, polygon)).toBe(false);
    expect(distanceFromPointToPolygonMeters(point, polygon)).toBeGreaterThan(100);
    expect(distanceFromPointToPolygonMeters(point, polygon)).toBeLessThan(300);
  });

  it('giữ công thức Haversine ổn định cho hai điểm trùng nhau', () => {
    expect(haversineDistance({ lat: 10, lng: 106 }, { lat: 10, lng: 106 })).toBe(0);
  });
});
