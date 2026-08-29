import { describe, expect, it } from 'vitest';
import { determineGeofenceDeviationLevel } from '../../constants/geofenceDeviationPolicy';

describe('determineGeofenceDeviationLevel', () => {
  it.each([
    [{ isInsideGeofence: true, distanceMeters: 0, accuracyMeters: 5 }, 'INSIDE'],
    [{ isInsideGeofence: false, distanceMeters: 40, accuracyMeters: 60 }, 'WITHIN_ACCURACY'],
    [{ isInsideGeofence: false, distanceMeters: 200, accuracyMeters: 10 }, 'DEVIATED'],
    [{ isInsideGeofence: false, distanceMeters: 800, accuracyMeters: 10 }, 'CRITICAL'],
    [{ isInsideGeofence: false, distanceMeters: 150, accuracyMeters: 2_000 }, 'DEVIATED'],
    [{ isInsideGeofence: false, distanceMeters: 1_900, accuracyMeters: 2_000, isLowAccuracyOverride: true }, 'CRITICAL'],
    [{ isInsideGeofence: true, distanceMeters: 0, accuracyMeters: 2_000, isLowAccuracyOverride: true }, 'DEVIATED'],
    [{ isInsideGeofence: null, distanceMeters: null, accuracyMeters: 0 }, 'NO_GEOFENCE'],
    [{ isInsideGeofence: false, distanceMeters: 60, accuracyMeters: 60 }, 'WITHIN_ACCURACY'],
    [{ isInsideGeofence: false, distanceMeters: 500, accuracyMeters: 10 }, 'DEVIATED']
  ] as const)('phân loại %# thành %s', (input, expected) => {
    expect(determineGeofenceDeviationLevel(input)).toBe(expected);
  });
});
