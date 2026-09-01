'use client';

import Link from 'next/link';
import type { ReactElement } from 'react';
import {
  PROJECT_IMPACT_NFT_PREVIEW_COUNT,
  PROJECT_IMPACT_NFT_SKELETON_COUNT
} from '@/app/constants/impactSbtGallery';
import { useImpactSbtGallery } from '@/app/hooks/useImpactSbtGallery';
import SbtCard from './SbtCard';
import SbtCardSkeleton from './SbtCardSkeleton';

interface ProjectImpactNftSectionProps {
  projectId: string;
}

/** Hiển thị các bằng chứng Impact SBT của dự án ngay trên trang chi tiết dự án. */
export default function ProjectImpactNftSection({ projectId }: ProjectImpactNftSectionProps): ReactElement {
  const galleryQuery = useImpactSbtGallery(projectId, 1);
  const entries = galleryQuery.data?.entries ?? [];
  const total = galleryQuery.data?.pagination?.total ?? entries.length;
  const previewEntries = entries.slice(0, PROJECT_IMPACT_NFT_PREVIEW_COUNT);
  // React Query có thể giữ dữ liệu dự án trước trong lúc tải dự án mới; không hiển thị bằng chứng sai dự án.
  const isGalleryLoading = galleryQuery.isLoading || galleryQuery.isPlaceholderData;

  return (
    <section className="project-detail-section mb-6" data-testid="project-impact-nft-section">
      <h2 className="project-detail-section-title">Bằng chứng tác động on-chain</h2>

      {isGalleryLoading ? (
        <div data-testid="project-impact-nft-skeletons" className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: PROJECT_IMPACT_NFT_SKELETON_COUNT }, (_, index) => (
            <SbtCardSkeleton key={index} />
          ))}
        </div>
      ) : galleryQuery.isError ? (
        <div className="rounded-xl border border-red-200 bg-red-50 p-6 text-center">
          <p className="text-sm font-semibold text-red-700">
            {galleryQuery.error?.message || 'Không thể tải bằng chứng on-chain của dự án.'}
          </p>
          <button
            type="button"
            onClick={() => void galleryQuery.refetch()}
            className="mt-3 rounded-md border border-red-300 bg-white px-4 py-2 text-sm font-semibold text-red-700 transition hover:bg-red-100"
          >
            Thử lại
          </button>
        </div>
      ) : entries.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-6 text-center">
          <p className="text-sm font-semibold text-slate-700">
            Dự án này chưa có mốc nào được xác minh on-chain.
          </p>
          <p className="mt-2 text-sm text-slate-500">
            Bằng chứng sẽ hiển thị tại đây khi có xác minh thực địa.
          </p>
        </div>
      ) : (
        <>
          <div data-testid="project-impact-nft-grid" className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {previewEntries.map((entry, index) => (
              <SbtCard key={`${entry.projectId}-${entry.onChainTokenId ?? `pending-${index}`}`} entry={entry} />
            ))}
          </div>
          {total > PROJECT_IMPACT_NFT_PREVIEW_COUNT && (
            <Link
              href={`/impact-gallery?projectId=${encodeURIComponent(projectId)}`}
              className="mt-4 inline-block text-sm font-semibold text-[#0e7c6b] underline"
            >
              Xem tất cả trên Impact Gallery
            </Link>
          )}
        </>
      )}
    </section>
  );
}
