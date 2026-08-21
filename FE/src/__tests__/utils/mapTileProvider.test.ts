import { describe, expect, it } from 'vitest';
import {
  ADMINISTRATIVE_BOUNDARY_MAX_ZOOM,
  getAdministrativeBoundaryTileUrl,
  getMapTileUrl,
  MAP_MAX_ZOOM,
  MAP_MIN_ZOOM
} from '@/app/utils/mapTileProvider';

describe('mapTileProvider', () => {
  it('dùng URL relative để request tile đi qua Next.js rewrite cùng origin', () => {
    expect(getMapTileUrl()).toBe('/api/tiles/{z}/{x}/{y}.png');
    expect(getAdministrativeBoundaryTileUrl()).toBe('/api/tiles/administrative/{z}/{x}/{y}.png');
  });

  it('giữ zoom trong phạm vi tile proxy hỗ trợ', () => {
    expect(MAP_MIN_ZOOM).toBe(5);
    expect(MAP_MAX_ZOOM).toBe(19);
    expect(ADMINISTRATIVE_BOUNDARY_MAX_ZOOM).toBe(16);
  });
});
