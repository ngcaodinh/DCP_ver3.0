import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  galleryMock: vi.fn(() => null)
}));

vi.mock('@/app/components/impactSbt/ImpactNFTGallery', () => ({
  default: mocks.galleryMock
}));

import ImpactGalleryPage, { metadata } from '@/app/impact-gallery/page';

describe('ImpactGalleryPage', () => {
  it('passes projectId from searchParams to the client gallery', () => {
    const page = ImpactGalleryPage({ searchParams: { projectId: 'p-001' } });

    expect(page.props).toEqual(expect.objectContaining({ initialProjectId: 'p-001' }));
  });

  it('passes a valid positive page from searchParams to the client gallery', () => {
    const page = ImpactGalleryPage({ searchParams: { projectId: 'p-001', page: '3' } });

    expect(page.props).toEqual({ initialProjectId: 'p-001', initialPage: 3 });
  });

  it('normalizes page boundary values to the public API contract before rendering the client gallery', () => {
    expect(ImpactGalleryPage({ searchParams: { page: '500' } }).props).toEqual({
      initialProjectId: undefined,
      initialPage: 500
    });
    expect(ImpactGalleryPage({ searchParams: { page: '501' } }).props).toEqual({
      initialProjectId: undefined,
      initialPage: 500
    });
    expect(ImpactGalleryPage({ searchParams: { page: 'NaN' } }).props).toEqual({
      initialProjectId: undefined,
      initialPage: 1
    });
    expect(ImpactGalleryPage({ searchParams: { page: 'Infinity' } }).props).toEqual({
      initialProjectId: undefined,
      initialPage: 1
    });
  });

  it('drops a whitespace-only project filter at the server boundary', () => {
    const page = ImpactGalleryPage({ searchParams: { projectId: '   ' } });

    expect(page.props).toEqual({ initialProjectId: undefined });
  });

  it('keeps URL parsing in the Server Component without importing useSearchParams', () => {
    const pageSource = readFileSync(
      path.resolve(__dirname, '../../../app/impact-gallery/page.tsx'),
      'utf8'
    );

    expect(pageSource).not.toContain('useSearchParams');
  });

  it('exports the gallery canonical metadata', () => {
    expect(metadata.title).toBe('Impact NFT Gallery');
    expect(metadata.alternates?.canonical).toBe('/impact-gallery');
  });
});
