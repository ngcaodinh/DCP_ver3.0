import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/app/components/oracle/GeofenceMapLazy', () => ({
  GeofenceMapLazy: ({ projectId, snapshot }: { projectId: string; snapshot: unknown }) => (
    <div data-testid="mock-geofence-map" data-project-id={projectId} data-snapshot={JSON.stringify(snapshot)} />
  )
}));

import SbtLocationMap, { parseGpsPoint } from '@/app/components/impactSbt/SbtLocationMap';

describe('SbtLocationMap', () => {
  it('truyền synthetic snapshot đúng GPS để map không kích hoạt API cần auth', () => {
    render(
      <SbtLocationMap
        gpsCoordinates="10.8231,106.6297"
        fallbackProjectId="5"
        tokenId={12}
      />
    );

    const map = screen.getByTestId('mock-geofence-map');
    expect(map).toHaveAttribute('data-project-id', '5');
    expect(JSON.parse(map.getAttribute('data-snapshot') ?? '')).toEqual({
      polygon: [],
      centroid: { lat: 10.8231, lng: 106.6297 },
      radiusMeters: 0
    });
  });

  it.each(['', 'abc,def', '91,200', '10.8'])('ẩn map với GPS không hợp lệ: %s', gpsCoordinates => {
    render(<SbtLocationMap gpsCoordinates={gpsCoordinates} fallbackProjectId="5" tokenId={12} />);

    expect(screen.queryByTestId('mock-geofence-map')).not.toBeInTheDocument();
    expect(screen.getByText('Không có dữ liệu vị trí')).toBeInTheDocument();
  });

  it('parseGpsPoint trả null cho input có nhiều hơn một dấu phẩy', () => {
    expect(parseGpsPoint('10.8,106.6,extra')).toBeNull();
  });

  it.each([
    ['90,180', { lat: 90, lng: 180 }],
    ['-90,-180', { lat: -90, lng: -180 }]
  ])('chấp nhận tọa độ đúng tại biên địa lý: %s', (gpsCoordinates, expectedPoint) => {
    expect(parseGpsPoint(gpsCoordinates)).toEqual(expectedPoint);
  });
});
