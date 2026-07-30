import { describe, expect, it } from 'vitest';
import {
  calculateGeofenceAreaKm2,
  calculateGeofenceCentroid,
  validateGeofencePolygon
} from '@/app/utils/geofenceGeometry';

/** Tạo tam giác hợp lệ để tái sử dụng cho các kiểm tra geometry phía client. */
function buildValidTriangle() {
  return [
    { lat: 10.76, lng: 106.68 },
    { lat: 10.77, lng: 106.69 },
    { lat: 10.76, lng: 106.70 }
  ];
}

/** Tạo polygon đều hợp lệ để kiểm tra giới hạn số đỉnh ở phía UX. */
function buildRegularPolygon(pointCount: number) {
  return Array.from({ length: pointCount }, (_, index) => {
    const angle = (2 * Math.PI * index) / pointCount;
    return {
      lat: 10.76 + Math.sin(angle) * 0.01,
      lng: 106.68 + Math.cos(angle) * 0.01
    };
  });
}

describe('geofenceGeometry', () => {
  it('chấp nhận tam giác hợp lệ và tính được diện tích cùng centroid hiển thị', () => {
    const polygon = buildValidTriangle();

    expect(validateGeofencePolygon(polygon)).toBeNull();
    expect(calculateGeofenceAreaKm2(polygon)).toBeGreaterThan(0);
    expect(calculateGeofenceCentroid(polygon)).toEqual({
      lat: (10.76 + 10.77 + 10.76) / 3,
      lng: (106.68 + 106.69 + 106.70) / 3
    });
  });

  it.each([
    ['polygon tự cắt', [
      { lat: 0, lng: 0 }, { lat: 1, lng: 1 }, { lat: 0, lng: 1 }, { lat: 1, lng: 0 }
    ], 'Polygon không được tự cắt.'],
    ['điểm trùng lặp', [
      { lat: 0, lng: 0 }, { lat: 1, lng: 0 }, { lat: 0, lng: 0 }
    ], 'Polygon không được chứa điểm trùng lặp.'],
    ['polygon suy biến', [
      { lat: 0, lng: 0 }, { lat: 1, lng: 1 }, { lat: 2, lng: 2 }
    ], 'Polygon không được suy biến hoặc có diện tích bằng 0.']
  ])('từ chối %s', (_caseName, polygon, expectedError) => {
    expect(validateGeofencePolygon(polygon)).toBe(expectedError);
  });

  it.each([
    [2, 'Polygon phải có ít nhất 3 điểm.'],
    [101, 'Polygon chỉ được có tối đa 100 điểm.']
  ])('từ chối polygon có %i điểm', (pointCount, expectedError) => {
    expect(validateGeofencePolygon(buildRegularPolygon(pointCount))).toBe(expectedError);
  });

  it.each([3, 100])('chấp nhận polygon có %i điểm ở biên hợp lệ', pointCount => {
    expect(validateGeofencePolygon(buildRegularPolygon(pointCount))).toBeNull();
  });

  it('từ chối tọa độ không hữu hạn và ngoài biên độ địa lý', () => {
    expect(validateGeofencePolygon([
      { lat: Number.NaN, lng: 106.68 },
      { lat: 10.77, lng: 106.69 },
      { lat: 10.76, lng: 106.70 }
    ])).toBe('Tọa độ polygon không hợp lệ.');

    expect(validateGeofencePolygon([
      { lat: 91, lng: 106.68 },
      { lat: 10.77, lng: 106.69 },
      { lat: 10.76, lng: 106.70 }
    ])).toBe('Tọa độ polygon không hợp lệ.');

    expect(validateGeofencePolygon([
      { lat: 10.76, lng: -181 },
      { lat: 10.77, lng: 106.69 },
      { lat: 10.76, lng: 106.70 }
    ])).toBe('Tọa độ polygon không hợp lệ.');
  });
});
