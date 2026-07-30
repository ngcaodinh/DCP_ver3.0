import { describe, expect, it } from 'vitest';
import {
  GEOFENCE_DEFAULT_RADIUS_METERS,
  validateGeofenceRequestBody
} from '../../validators/geofenceValidator';

/** Tạo polygon tam giác hợp lệ để tái sử dụng trong các case validator. */
function buildValidPolygon() {
  return [
    { lat: 10.76, lng: 106.68 },
    { lat: 10.77, lng: 106.69 },
    { lat: 10.76, lng: 106.70 }
  ];
}

/** Tạo polygon đều hợp lệ để kiểm tra chính xác giới hạn số đỉnh. */
function buildRegularPolygon(pointCount: number) {
  return Array.from({ length: pointCount }, (_, index) => {
    const angle = (2 * Math.PI * index) / pointCount;
    return {
      lat: 10.76 + Math.sin(angle) * 0.01,
      lng: 106.68 + Math.cos(angle) * 0.01
    };
  });
}

describe('validateGeofenceRequestBody', () => {
  it('chấp nhận tam giác hợp lệ và chỉ default radius khi trường bị thiếu', () => {
    const validationResult = validateGeofenceRequestBody({ polygon: buildValidPolygon() });

    expect(validationResult.isValid).toBe(true);
    if (validationResult.isValid) {
      expect(validationResult.data.radiusMeters).toBe(GEOFENCE_DEFAULT_RADIUS_METERS);
    }
  });

  it.each([100, 2000])('chấp nhận radiusMeters ở biên hợp lệ: %i', radiusMeters => {
    const validationResult = validateGeofenceRequestBody({
      polygon: buildValidPolygon(),
      radiusMeters
    });

    expect(validationResult.isValid).toBe(true);
  });

  it.each([3, 100])('chấp nhận polygon ở giới hạn số đỉnh: %i', pointCount => {
    expect(validateGeofenceRequestBody({ polygon: buildRegularPolygon(pointCount) }).isValid).toBe(true);
  });

  it.each([2, 101])('từ chối polygon ngoài giới hạn số đỉnh: %i', pointCount => {
    const validationResult = validateGeofenceRequestBody({ polygon: buildRegularPolygon(pointCount) });

    expect(validationResult.isValid).toBe(false);
    if (!validationResult.isValid) {
      expect(validationResult.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ field: 'polygon' })
      ]));
    }
  });

  it('chấp nhận tọa độ ở đúng biên độ địa lý', () => {
    expect(validateGeofenceRequestBody({
      polygon: [
        { lat: -90, lng: -180 },
        { lat: -89, lng: -179 },
        { lat: -89, lng: -180 }
      ]
    }).isValid).toBe(true);
  });

  it.each([
    ['polygon bow-tie', [
      { lat: 0, lng: 0 }, { lat: 1, lng: 1 }, { lat: 0, lng: 1 }, { lat: 1, lng: 0 }
    ]],
    ['điểm trùng lặp', [
      { lat: 0, lng: 0 }, { lat: 1, lng: 0 }, { lat: 0, lng: 0 }
    ]],
    ['polygon thẳng hàng', [
      { lat: 0, lng: 0 }, { lat: 1, lng: 1 }, { lat: 2, lng: 2 }
    ]]
  ])('từ chối %s', (_caseName, polygon) => {
    const validationResult = validateGeofenceRequestBody({ polygon });

    expect(validationResult.isValid).toBe(false);
    if (!validationResult.isValid) {
      expect(validationResult.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ field: 'polygon' })
      ]));
    }
  });

  it.each([
    ['payload null', null],
    ['thiếu lat', { polygon: [{ lng: 106.68 }, { lat: 10.77, lng: 106.69 }, { lat: 10.76, lng: 106.70 }] }],
    ['thiếu lng', { polygon: [{ lat: 10.76 }, { lat: 10.77, lng: 106.69 }, { lat: 10.76, lng: 106.70 }] }],
    ['số dạng string', { polygon: [{ lat: '10.76', lng: 106.68 }, { lat: 10.77, lng: 106.69 }, { lat: 10.76, lng: 106.70 }] }],
    ['vĩ độ NaN', { polygon: [{ lat: Number.NaN, lng: 106.68 }, { lat: 10.77, lng: 106.69 }, { lat: 10.76, lng: 106.70 }] }],
    ['vĩ độ không hữu hạn', { polygon: [{ lat: Infinity, lng: 106.68 }, { lat: 10.77, lng: 106.69 }, { lat: 10.76, lng: 106.70 }] }],
    ['kinh độ không hữu hạn', { polygon: [{ lat: 10.76, lng: -Infinity }, { lat: 10.77, lng: 106.69 }, { lat: 10.76, lng: 106.70 }] }],
    ['vĩ độ vượt biên', { polygon: [{ lat: 90.001, lng: 106.68 }, { lat: 10.77, lng: 106.69 }, { lat: 10.76, lng: 106.70 }] }],
    ['kinh độ vượt biên', { polygon: [{ lat: 10.76, lng: 180.001 }, { lat: 10.77, lng: 106.69 }, { lat: 10.76, lng: 106.70 }] }],
    ['thuộc tính thừa trong điểm', { polygon: [{ lat: 10.76, lng: 106.68, elevation: 5 }, { lat: 10.77, lng: 106.69 }, { lat: 10.76, lng: 106.70 }] }],
    ['centroid do client gửi', { polygon: buildValidPolygon(), centroid: { lat: 10.76, lng: 106.68 } }]
  ])('từ chối %s', (_caseName, payload) => {
    expect(validateGeofenceRequestBody(payload).isValid).toBe(false);
  });

  it.each([99, 2001, Number.NaN, Infinity, null, '500'])('từ chối radiusMeters không hợp lệ: %s', radiusMeters => {
    expect(validateGeofenceRequestBody({ polygon: buildValidPolygon(), radiusMeters }).isValid).toBe(false);
  });
});
