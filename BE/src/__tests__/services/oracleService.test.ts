import { describe, expect, it, vi, beforeEach } from 'vitest';
import { extractExifGps, haversineDistance, verifyEvidenceImage } from '../../services/oracleService';
import type { GpsCoordinate } from '../../models/projectGeofenceModel';

// Mock DB models để test không cần MongoDB
vi.mock('../../models/projectGeofenceModel', () => ({
  findGeofenceByProjectId: vi.fn(),
  MIN_GEOFENCE_POLYGON_POINTS: 3,
  MAX_GEOFENCE_POLYGON_POINTS: 100,
  computeCentroid: vi.fn((polygon: GpsCoordinate[]) => {
    const lat = polygon.reduce((s, p) => s + p.lat, 0) / polygon.length;
    const lng = polygon.reduce((s, p) => s + p.lng, 0) / polygon.length;
    return { lat, lng };
  }),
  upsertProjectGeofence: vi.fn()
}));

vi.mock('../../models/oracleVerificationResultModel', () => ({
  createOracleVerificationResult: vi.fn().mockResolvedValue({}),
  linkOverrideRequestToVerification: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('../../models/oracleOverrideRequestModel', () => ({
  createOracleOverrideRequest: vi.fn().mockResolvedValue({ overrideRequestId: 'mock-override-id' }),
  deleteOracleOverrideRequestById: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('../../models/authModel', () => ({
  // [B2-fix #5] oracleService đã đổi sang findActiveCommissioners (lọc isSybil=false)
  findActiveCommissioners: vi.fn().mockResolvedValue([])
}));

vi.mock('../../events/oracleEvents', () => ({
  oracleEvents: { emit: vi.fn() }
}));

vi.mock('../../services/notificationService', () => ({
  createUserNotification: vi.fn().mockResolvedValue(null)
}));

vi.mock('../../config/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}));

// Mock exif-parser — cần đứng trước import service vì vi.mock được hoist
vi.mock('exif-parser', () => ({
  create: vi.fn()
}));

import { create as mockExifCreate } from 'exif-parser';
import { findGeofenceByProjectId } from '../../models/projectGeofenceModel';
import { oracleEvents } from '../../events/oracleEvents';
import { createOracleVerificationResult, linkOverrideRequestToVerification } from '../../models/oracleVerificationResultModel';
import { createOracleOverrideRequest } from '../../models/oracleOverrideRequestModel';

// ============================================================================
// extractExifGps
// ============================================================================
describe('extractExifGps', () => {
  beforeEach(() => {
    vi.mocked(mockExifCreate).mockReset();
  });

  it('trả về null khi buffer không có EXIF', () => {
    vi.mocked(mockExifCreate).mockReturnValue({
      enableSimpleValues: vi.fn().mockReturnThis(),
      parse: vi.fn().mockImplementation(() => { throw new Error('No Exif segment found in JPEG'); })
    } as unknown as ReturnType<typeof mockExifCreate>);

    expect(extractExifGps(Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]))).toBeNull();
  });

  it('trả về null khi buffer là non-image', () => {
    vi.mocked(mockExifCreate).mockReturnValue({
      enableSimpleValues: vi.fn().mockReturnThis(),
      parse: vi.fn().mockImplementation(() => { throw new Error('not a JPEG'); })
    } as unknown as ReturnType<typeof mockExifCreate>);

    expect(extractExifGps(Buffer.from('not an image'))).toBeNull();
  });

  it('trả về null khi EXIF không có GPS tags', () => {
    vi.mocked(mockExifCreate).mockReturnValue({
      enableSimpleValues: vi.fn().mockReturnThis(),
      parse: vi.fn().mockReturnValue({ tags: { Make: 'Samsung' } })
    } as unknown as ReturnType<typeof mockExifCreate>);

    expect(extractExifGps(Buffer.alloc(64))).toBeNull();
  });

  it('trích xuất GPS thành công khi có GPSLatitude và GPSLongitude', () => {
    vi.mocked(mockExifCreate).mockReturnValue({
      enableSimpleValues: vi.fn().mockReturnThis(),
      parse: vi.fn().mockReturnValue({
        tags: { GPSLatitude: 10.7769, GPSLongitude: 106.7009, GPSLatitudeRef: 'N', GPSLongitudeRef: 'E' }
      })
    } as unknown as ReturnType<typeof mockExifCreate>);

    expect(extractExifGps(Buffer.alloc(64))).toEqual({ lat: 10.7769, lng: 106.7009 });
  });

  it('xử lý sign-flip GPSLatitudeRef=S → lat âm (Nam bán cầu)', () => {
    vi.mocked(mockExifCreate).mockReturnValue({
      enableSimpleValues: vi.fn().mockReturnThis(),
      parse: vi.fn().mockReturnValue({
        tags: { GPSLatitude: 33.8688, GPSLongitude: 151.2093, GPSLatitudeRef: 'S', GPSLongitudeRef: 'E' }
      })
    } as unknown as ReturnType<typeof mockExifCreate>);

    const result = extractExifGps(Buffer.alloc(64));
    expect(result).not.toBeNull();
    expect(result!.lat).toBeLessThan(0);
    expect(result!.lat).toBeCloseTo(-33.8688, 4);
    expect(result!.lng).toBeCloseTo(151.2093, 4);
  });

  it('xử lý sign-flip GPSLongitudeRef=W → lng âm (Tây bán cầu)', () => {
    vi.mocked(mockExifCreate).mockReturnValue({
      enableSimpleValues: vi.fn().mockReturnThis(),
      parse: vi.fn().mockReturnValue({
        tags: { GPSLatitude: 40.7128, GPSLongitude: 74.0060, GPSLatitudeRef: 'N', GPSLongitudeRef: 'W' }
      })
    } as unknown as ReturnType<typeof mockExifCreate>);

    const result = extractExifGps(Buffer.alloc(64));
    expect(result).not.toBeNull();
    expect(result!.lng).toBeLessThan(0);
    expect(result!.lng).toBeCloseTo(-74.0060, 4);
  });

  it('trả về null khi GPS ngoài phạm vi hợp lệ (lat > 90)', () => {
    vi.mocked(mockExifCreate).mockReturnValue({
      enableSimpleValues: vi.fn().mockReturnThis(),
      parse: vi.fn().mockReturnValue({
        tags: { GPSLatitude: 95, GPSLongitude: 106.7, GPSLatitudeRef: 'N', GPSLongitudeRef: 'E' }
      })
    } as unknown as ReturnType<typeof mockExifCreate>);

    expect(extractExifGps(Buffer.alloc(64))).toBeNull();
  });
});

// ============================================================================
// haversineDistance
// ============================================================================
describe('haversineDistance', () => {
  it('trả về 0 khi 2 điểm trùng nhau', () => {
    const point: GpsCoordinate = { lat: 10.7769, lng: 106.7009 };
    expect(haversineDistance(point, point)).toBe(0);
  });

  it('tính khoảng cách HCM → Hà Nội ~1137km (sai số < 1%)', () => {
    const hcm: GpsCoordinate = { lat: 10.8231, lng: 106.6297 };
    const hanoi: GpsCoordinate = { lat: 21.0285, lng: 105.8542 };
    const km = haversineDistance(hcm, hanoi) / 1000;
    expect(km).toBeGreaterThan(1120);
    expect(km).toBeLessThan(1150);
  });

  it('tính khoảng cách 1km, sai số < 10m', () => {
    const origin: GpsCoordinate = { lat: 21.0285, lng: 105.8542 };
    const north1km: GpsCoordinate = { lat: 21.0375, lng: 105.8542 };
    const d = haversineDistance(origin, north1km);
    expect(d).toBeGreaterThan(990);
    expect(d).toBeLessThan(1010);
  });

  it('tính khoảng cách 500m, sai số < 10m (kiểm tra độ chính xác Haversine)', () => {
    const center: GpsCoordinate = { lat: 10.7769, lng: 106.7009 };
    // 0.0045 độ vĩ × 111,320 m/deg ≈ 500.9m → kỳ vọng 490–510m
    const nearby: GpsCoordinate = { lat: 10.7814, lng: 106.7009 };
    const d = haversineDistance(center, nearby);
    expect(d).toBeGreaterThan(490);
    expect(d).toBeLessThan(510);
  });

  it('xử lý tọa độ âm (Nam bán cầu)', () => {
    const sydney: GpsCoordinate = { lat: -33.8688, lng: 151.2093 };
    const nearby: GpsCoordinate = { lat: -33.8600, lng: 151.2093 };
    const d = haversineDistance(sydney, nearby);
    expect(d).toBeGreaterThan(0);
    expect(d).toBeLessThan(2000);
  });
});

// ============================================================================
// verifyEvidenceImage
// ============================================================================
describe('verifyEvidenceImage', () => {
  const mockProjectId = 'proj-123';
  const mockOrgId = 'org-456';
  const mockCid = 'QmTest123';

  const mockGeofenceWith500m = {
    projectId: mockProjectId,
    polygon: [{ lat: 10.77, lng: 106.70 }, { lat: 10.78, lng: 106.70 }, { lat: 10.78, lng: 106.71 }],
    centroid: { lat: 10.775, lng: 106.703 },
    radiusMeters: 500,
    createdAt: new Date(),
    updatedAt: new Date()
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --- no geofence ---

  it('trả về NO_GEOFENCE khi project chưa có geofence (ảnh không có GPS)', async () => {
    vi.mocked(findGeofenceByProjectId).mockResolvedValue(null);
    vi.mocked(mockExifCreate).mockReturnValue({
      enableSimpleValues: vi.fn().mockReturnThis(),
      parse: vi.fn().mockImplementation(() => { throw new Error('No EXIF'); })
    } as unknown as ReturnType<typeof mockExifCreate>);

    const result = await verifyEvidenceImage(Buffer.alloc(64), mockProjectId, mockOrgId, mockCid);

    expect(result.isValid).toBeNull();
    expect(result.reason).toBe('NO_GEOFENCE');
    expect(result.verificationId).toBeTruthy();
    expect(result.overrideRequestId).toBeTruthy();
  });

  it('trả về NO_GEOFENCE khi project chưa có geofence, nhưng vẫn trích xuất GPS từ ảnh', async () => {
    // [B2] Khi project chưa có geofence, ảnh có GPS hợp lệ → vẫn phân biệt được với GPS_EXIF_MISSING
    vi.mocked(findGeofenceByProjectId).mockResolvedValue(null);
    vi.mocked(mockExifCreate).mockReturnValue({
      enableSimpleValues: vi.fn().mockReturnThis(),
      parse: vi.fn().mockReturnValue({
        tags: { GPSLatitude: 10.775, GPSLongitude: 106.703, GPSLatitudeRef: 'N', GPSLongitudeRef: 'E' }
      })
    } as unknown as ReturnType<typeof mockExifCreate>);

    const result = await verifyEvidenceImage(Buffer.alloc(64), mockProjectId, mockOrgId, mockCid);

    expect(result.isValid).toBeNull();
    expect(result.reason).toBe('NO_GEOFENCE');

    // createOracleVerificationResult phải được gọi với gpsFromImage != null
    const verificationCall = vi.mocked(createOracleVerificationResult).mock.calls[0]?.[0];
    expect(verificationCall?.gpsFromImage).toEqual({ lat: 10.775, lng: 106.703 });
    expect(verificationCall?.status).toBe('NO_GEOFENCE');

    // override phải dùng reason NO_GEOFENCE, không phải GPS_EXIF_MISSING
    const overrideCall = vi.mocked(createOracleOverrideRequest).mock.calls[0]?.[0];
    expect(overrideCall?.reason).toBe('NO_GEOFENCE');
  });

  // --- no GPS in EXIF ---

  it('trả về GPS_EXIF_MISSING khi ảnh không có EXIF GPS (geofence tồn tại)', async () => {
    vi.mocked(findGeofenceByProjectId).mockResolvedValue(mockGeofenceWith500m);
    vi.mocked(mockExifCreate).mockReturnValue({
      enableSimpleValues: vi.fn().mockReturnThis(),
      parse: vi.fn().mockReturnValue({ tags: {} })
    } as unknown as ReturnType<typeof mockExifCreate>);

    const result = await verifyEvidenceImage(Buffer.alloc(64), mockProjectId, mockOrgId, mockCid);

    expect(result.isValid).toBeNull();
    expect(result.reason).toBe('GPS_EXIF_MISSING');
    expect(result.distance).toBeNull();
    expect(result.overrideRequestId).toBeTruthy();

    // [B3] NO_GPS vẫn phải persist geofenceSnapshot bất biến (polygon/centroid/radius đã clamp)
    // để Admin review đúng vùng lịch sử — không được rơi mất khi đi qua handleNoGps.
    const verificationCall = vi.mocked(createOracleVerificationResult).mock.calls[0]?.[0];
    expect(verificationCall?.status).toBe('NO_GPS');
    expect(verificationCall?.geofenceSnapshot).toEqual({
      polygon: mockGeofenceWith500m.polygon,
      centroid: mockGeofenceWith500m.centroid,
      radiusMeters: 500
    });
  });

  // --- in radius ---

  it('trả về isValid=true khi GPS trong phạm vi geofence', async () => {
    vi.mocked(findGeofenceByProjectId).mockResolvedValue(mockGeofenceWith500m);
    vi.mocked(mockExifCreate).mockReturnValue({
      enableSimpleValues: vi.fn().mockReturnThis(),
      parse: vi.fn().mockReturnValue({
        tags: { GPSLatitude: 10.7759, GPSLongitude: 106.703, GPSLatitudeRef: 'N', GPSLongitudeRef: 'E' }
      })
    } as unknown as ReturnType<typeof mockExifCreate>);

    const result = await verifyEvidenceImage(Buffer.alloc(64), mockProjectId, mockOrgId, mockCid);

    expect(result.isValid).toBe(true);
    expect(result.reason).toBeNull();
    expect(result.overrideRequestId).toBeNull();
    expect(result.distance!).toBeLessThan(500);
    // valid path: linkOverrideRequestToVerification không được gọi
    expect(vi.mocked(linkOverrideRequestToVerification)).not.toHaveBeenCalled();
  });

  // --- out of radius ---

  it('trả về isValid=false khi GPS ngoài phạm vi geofence', async () => {
    vi.mocked(findGeofenceByProjectId).mockResolvedValue({
      ...mockGeofenceWith500m,
      radiusMeters: 100
    });
    vi.mocked(mockExifCreate).mockReturnValue({
      enableSimpleValues: vi.fn().mockReturnThis(),
      parse: vi.fn().mockReturnValue({
        tags: { GPSLatitude: 10.800, GPSLongitude: 106.703, GPSLatitudeRef: 'N', GPSLongitudeRef: 'E' }
      })
    } as unknown as ReturnType<typeof mockExifCreate>);

    const result = await verifyEvidenceImage(Buffer.alloc(64), mockProjectId, mockOrgId, mockCid);

    expect(result.isValid).toBe(false);
    expect(result.reason).toBe('Out of geofence');
    expect(result.overrideRequestId).toBeTruthy();
    expect(result.distance!).toBeGreaterThan(100);
    // verification-first: linkOverrideRequestToVerification phải được gọi
    expect(vi.mocked(linkOverrideRequestToVerification)).toHaveBeenCalledWith(
      result.verificationId,
      result.overrideRequestId
    );

    // [B3] INVALID (OUT_OF_GEOFENCE) là case chính tạo override + review bản đồ — snapshot bất biến
    // phải được persist với radius đã clamp (100m), tránh regression âm thầm ở use case chính.
    const verificationCall = vi.mocked(createOracleVerificationResult).mock.calls[0]?.[0];
    expect(verificationCall?.status).toBe('INVALID');
    expect(verificationCall?.geofenceSnapshot).toEqual({
      polygon: mockGeofenceWith500m.polygon,
      centroid: mockGeofenceWith500m.centroid,
      radiusMeters: 100
    });
  });

  // --- geofence snapshot bất biến (B3) ---

  it('[B3] lưu geofenceSnapshot (polygon, centroid, radius đã clamp) khi verify VALID', async () => {
    vi.mocked(findGeofenceByProjectId).mockResolvedValue(mockGeofenceWith500m);
    vi.mocked(mockExifCreate).mockReturnValue({
      enableSimpleValues: vi.fn().mockReturnThis(),
      parse: vi.fn().mockReturnValue({
        tags: { GPSLatitude: 10.7759, GPSLongitude: 106.703, GPSLatitudeRef: 'N', GPSLongitudeRef: 'E' }
      })
    } as unknown as ReturnType<typeof mockExifCreate>);

    await verifyEvidenceImage(Buffer.alloc(64), mockProjectId, mockOrgId, mockCid);

    const verificationCall = vi.mocked(createOracleVerificationResult).mock.calls[0]?.[0];
    expect(verificationCall?.geofenceSnapshot).toEqual({
      polygon: mockGeofenceWith500m.polygon,
      centroid: mockGeofenceWith500m.centroid,
      radiusMeters: 500
    });
  });

  it('[B3] geofenceSnapshot bất biến — sửa geofence sau verify không làm đổi snapshot đã lưu', async () => {
    // Verify lần đầu với polygon/radius gốc
    const originalGeofence = {
      ...mockGeofenceWith500m,
      polygon: mockGeofenceWith500m.polygon.map((point) => ({ ...point })),
      centroid: { ...mockGeofenceWith500m.centroid }
    };
    const expectedOriginalSnapshot = {
      polygon: originalGeofence.polygon.map((point) => ({ ...point })),
      centroid: { ...originalGeofence.centroid },
      radiusMeters: 500
    };
    vi.mocked(findGeofenceByProjectId).mockResolvedValue(originalGeofence);
    vi.mocked(mockExifCreate).mockReturnValue({
      enableSimpleValues: vi.fn().mockReturnThis(),
      parse: vi.fn().mockReturnValue({
        tags: { GPSLatitude: 10.7759, GPSLongitude: 106.703, GPSLatitudeRef: 'N', GPSLongitudeRef: 'E' }
      })
    } as unknown as ReturnType<typeof mockExifCreate>);

    await verifyEvidenceImage(Buffer.alloc(64), mockProjectId, mockOrgId, mockCid);
    const firstSnapshot = vi.mocked(createOracleVerificationResult).mock.calls[0]?.[0]?.geofenceSnapshot;
    originalGeofence.polygon[0]!.lat = 99;
    originalGeofence.centroid.lat = 99;

    // Organization sửa geofence (polygon + radius khác) rồi verify ảnh mới
    const mutatedGeofence = {
      ...mockGeofenceWith500m,
      polygon: [{ lat: 20.0, lng: 100.0 }, { lat: 20.1, lng: 100.0 }, { lat: 20.1, lng: 100.1 }],
      centroid: { lat: 20.05, lng: 100.05 },
      radiusMeters: 1500
    };
    vi.mocked(findGeofenceByProjectId).mockResolvedValue(mutatedGeofence);
    await verifyEvidenceImage(Buffer.alloc(64), mockProjectId, mockOrgId, 'QmSecondCid');

    // Snapshot lần đầu vẫn giữ nguyên polygon/centroid/radius gốc, không bị mutate
    expect(firstSnapshot).toEqual(expectedOriginalSnapshot);
    // Snapshot lần hai phản ánh geofence mới
    const secondSnapshot = vi.mocked(createOracleVerificationResult).mock.calls[1]?.[0]?.geofenceSnapshot;
    expect(secondSnapshot?.radiusMeters).toBe(1500);
    expect(secondSnapshot?.centroid).toEqual({ lat: 20.05, lng: 100.05 });
  });

  it('[B3] geofenceSnapshot dùng radius đã clamp, không dùng giá trị DB thô', async () => {
    vi.mocked(findGeofenceByProjectId).mockResolvedValue({
      ...mockGeofenceWith500m,
      centroid: { lat: 10.775, lng: 106.703 },
      radiusMeters: 9999 // vượt cap 2000
    });
    vi.mocked(mockExifCreate).mockReturnValue({
      enableSimpleValues: vi.fn().mockReturnThis(),
      parse: vi.fn().mockReturnValue({
        tags: { GPSLatitude: 10.7759, GPSLongitude: 106.703, GPSLatitudeRef: 'N', GPSLongitudeRef: 'E' }
      })
    } as unknown as ReturnType<typeof mockExifCreate>);

    await verifyEvidenceImage(Buffer.alloc(64), mockProjectId, mockOrgId, mockCid);

    const verificationCall = vi.mocked(createOracleVerificationResult).mock.calls[0]?.[0];
    // Radius trong snapshot phải là 2000 (đã cap), không phải 9999
    expect(verificationCall?.geofenceSnapshot?.radiusMeters).toBe(2000);
  });

  it('[B3-performance] từ chối geofence polygon quá lớn trước khi copy snapshot', async () => {
    vi.mocked(findGeofenceByProjectId).mockResolvedValue({
      ...mockGeofenceWith500m,
      polygon: Array.from({ length: 101 }, (_, index) => ({
        lat: 10 + index * 0.0001,
        lng: 106 + index * 0.0001
      }))
    });

    await expect(verifyEvidenceImage(Buffer.alloc(64), mockProjectId, mockOrgId, mockCid))
      .rejects.toThrow('100');
    expect(createOracleVerificationResult).not.toHaveBeenCalled();
  });

  it('[B3] geofenceSnapshot = null khi project chưa có geofence (NO_GEOFENCE)', async () => {
    vi.mocked(findGeofenceByProjectId).mockResolvedValue(null);
    vi.mocked(mockExifCreate).mockReturnValue({
      enableSimpleValues: vi.fn().mockReturnThis(),
      parse: vi.fn().mockImplementation(() => { throw new Error('No EXIF'); })
    } as unknown as ReturnType<typeof mockExifCreate>);

    await verifyEvidenceImage(Buffer.alloc(64), mockProjectId, mockOrgId, mockCid);

    const verificationCall = vi.mocked(createOracleVerificationResult).mock.calls[0]?.[0];
    expect(verificationCall?.status).toBe('NO_GEOFENCE');
    expect(verificationCall?.geofenceSnapshot).toBeNull();
  });

  // --- radius clamping ---

  it('cap radiusMeters về 2000m khi DB có giá trị lớn hơn', async () => {
    vi.mocked(findGeofenceByProjectId).mockResolvedValue({
      ...mockGeofenceWith500m,
      centroid: { lat: 10.775, lng: 106.703 },
      radiusMeters: 9999 // vượt cap
    });
    // GPS cách centroid ~1800m — trong 2000m (cap) nhưng ngoài nếu không cap
    vi.mocked(mockExifCreate).mockReturnValue({
      enableSimpleValues: vi.fn().mockReturnThis(),
      parse: vi.fn().mockReturnValue({
        tags: { GPSLatitude: 10.7912, GPSLongitude: 106.703, GPSLatitudeRef: 'N', GPSLongitudeRef: 'E' }
      })
    } as unknown as ReturnType<typeof mockExifCreate>);

    const result = await verifyEvidenceImage(Buffer.alloc(64), mockProjectId, mockOrgId, mockCid);
    expect(result.isValid).toBe(true); // 1800m < 2000m cap → VALID
  });

  it('floor radiusMeters lên 100m khi DB có giá trị nhỏ hơn', async () => {
    vi.mocked(findGeofenceByProjectId).mockResolvedValue({
      ...mockGeofenceWith500m,
      centroid: { lat: 10.775, lng: 106.703 },
      radiusMeters: 1 // dưới floor — phải được floor lên 100m
    });
    // GPS cách centroid ~50m — trong 100m (floor) nhưng ngoài nếu dùng 1m
    vi.mocked(mockExifCreate).mockReturnValue({
      enableSimpleValues: vi.fn().mockReturnThis(),
      parse: vi.fn().mockReturnValue({
        tags: { GPSLatitude: 10.7755, GPSLongitude: 106.703, GPSLatitudeRef: 'N', GPSLongitudeRef: 'E' }
      })
    } as unknown as ReturnType<typeof mockExifCreate>);

    const result = await verifyEvidenceImage(Buffer.alloc(64), mockProjectId, mockOrgId, mockCid);
    expect(result.isValid).toBe(true); // ~55m < 100m floor → VALID
  });

  // --- events emitted ---

  it('emit oracle.verified và override.requested khi GPS ngoài phạm vi', async () => {
    vi.mocked(findGeofenceByProjectId).mockResolvedValue({ ...mockGeofenceWith500m, radiusMeters: 100 });
    vi.mocked(mockExifCreate).mockReturnValue({
      enableSimpleValues: vi.fn().mockReturnThis(),
      parse: vi.fn().mockReturnValue({
        tags: { GPSLatitude: 10.800, GPSLongitude: 106.703, GPSLatitudeRef: 'N', GPSLongitudeRef: 'E' }
      })
    } as unknown as ReturnType<typeof mockExifCreate>);

    await verifyEvidenceImage(Buffer.alloc(64), mockProjectId, mockOrgId, mockCid);

    expect(vi.mocked(oracleEvents.emit)).toHaveBeenCalledWith('oracle.verified', expect.objectContaining({ isValid: false }));
    expect(vi.mocked(oracleEvents.emit)).toHaveBeenCalledWith('override.requested', expect.objectContaining({ reason: 'OUT_OF_GEOFENCE' }));
  });

  // --- helper: per-project radius ---

  it('radiusMeters per-project được tuân thủ (1000m)', () => {
    const center: GpsCoordinate = { lat: 10.7769, lng: 106.7009 };
    const edge900m: GpsCoordinate = { lat: 10.7850, lng: 106.7009 };
    const edge1100m: GpsCoordinate = { lat: 10.7868, lng: 106.7009 };
    expect(haversineDistance(center, edge900m)).toBeLessThan(1000);
    expect(haversineDistance(center, edge1100m)).toBeGreaterThan(1000);
  });
});
