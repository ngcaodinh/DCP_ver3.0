import { describe, expect, it } from 'vitest';
import { computeCentroid } from '../../models/projectGeofenceModel';

describe('computeCentroid', () => {
  it('tính centroid từ polygon tại server, không nhận giá trị do client cung cấp', () => {
    const centroid = computeCentroid([
      { lat: 10.76, lng: 106.68 },
      { lat: 10.77, lng: 106.69 },
      { lat: 10.76, lng: 106.70 }
    ]);

    expect(centroid).toEqual({
      lat: (10.76 + 10.77 + 10.76) / 3,
      lng: (106.68 + 106.69 + 106.70) / 3
    });
  });
});
