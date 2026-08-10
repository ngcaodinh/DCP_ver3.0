import type { Metadata } from 'next';
import ImpactNFTGallery from '../components/impactSbt/ImpactNFTGallery';
import { normalizeImpactSbtGalleryPage } from '../constants/impactSbtGallery';

export const metadata: Metadata = {
  title: 'Impact NFT Gallery',
  description:
    'Khám phá Impact SBT ghi nhận các milestone và tác động minh bạch của những dự án cộng đồng trên DCP.',
  alternates: {
    canonical: '/impact-gallery'
  },
  openGraph: {
    title: 'Impact NFT Gallery | DCP',
    description:
      'Khám phá Impact SBT ghi nhận các milestone và tác động minh bạch của những dự án cộng đồng trên DCP.',
    url: '/impact-gallery'
  }
};

interface ImpactGalleryPageProps {
  searchParams?: {
    projectId?: string | string[];
    page?: string | string[];
  };
}

/** Trang server đọc filter từ URL rồi truyền xuống gallery client theo pattern App Router hiện có. */
export default function ImpactGalleryPage({ searchParams }: ImpactGalleryPageProps) {
  const rawProjectId = searchParams?.projectId;
  const initialProjectIdValue = Array.isArray(rawProjectId) ? rawProjectId[0] : rawProjectId;
  const initialProjectId = initialProjectIdValue?.trim() || undefined;
  const rawPage = searchParams?.page;
  const pageValue = Array.isArray(rawPage) ? rawPage[0] : rawPage;
  const initialPage = pageValue === undefined ? undefined : normalizeImpactSbtGalleryPage(pageValue);
  const galleryProps = initialPage === undefined
    ? { initialProjectId }
    : { initialProjectId, initialPage };

  return <ImpactNFTGallery {...galleryProps} />;
}
