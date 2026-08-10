'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { SBT_GALLERY_SKELETON_COUNT } from '@/app/constants/impactSbtGallery';
import { useImpactSbtGallery } from '@/app/hooks/useImpactSbtGallery';
import SbtCard from './SbtCard';
import SbtCardSkeleton from './SbtCardSkeleton';

interface ImpactNFTGalleryProps {
  initialProjectId?: string;
  initialPage?: number;
}

/** Component điều phối filter, loading, error, empty state và grid Impact NFT Gallery. */
export default function ImpactNFTGallery({ initialProjectId, initialPage }: ImpactNFTGalleryProps) {
  const router = useRouter();
  const initialFilter = initialProjectId?.trim() ?? '';
  const [projectFilter, setProjectFilter] = useState(initialFilter);
  const appliedProjectId = initialFilter || undefined;
  const page = initialPage ?? 1;
  const galleryQuery = useImpactSbtGallery(appliedProjectId, page);
  const entries = galleryQuery.data?.entries ?? [];
  const pagination = galleryQuery.data?.pagination;

  /** Đồng bộ duy nhất ô nhập cục bộ khi URL đổi; filter và page áp dụng được derive trực tiếp từ Server Component props. */
  useEffect(() => {
    setProjectFilter(initialFilter);
  }, [initialFilter]);

  /** Áp dụng filter sau khi submit để tránh gọi router/API theo từng ký tự đang gõ. */
  function handleProjectFilterSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const nextProjectId = projectFilter.trim();
    router.replace(nextProjectId ? `/impact-gallery?projectId=${encodeURIComponent(nextProjectId)}` : '/impact-gallery');
  }

  /** Chuyển trang gallery và giữ nguyên filter project hiện tại trong URL. */
  function handlePageChange(nextPage: number): void {
    if (!pagination || nextPage < 1 || nextPage > pagination.totalPages) {
      return;
    }

    const projectQuery = appliedProjectId ? `&projectId=${encodeURIComponent(appliedProjectId)}` : '';
    router.replace(`/impact-gallery?page=${nextPage}${projectQuery}`);
  }

  return (
    <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-8 space-y-3">
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-cyan-700">On-chain impact</p>
        <h1 className="text-3xl font-bold text-slate-900">Impact NFT Gallery</h1>
        <p className="max-w-2xl text-sm leading-6 text-slate-600">
          Khám phá các Impact SBT ghi nhận những milestone và người thụ hưởng của từng dự án.
        </p>
        <form aria-label="Lọc gallery theo project" onSubmit={handleProjectFilterSubmit} className="max-w-md">
          <label htmlFor="impact-gallery-project-filter" className="mb-1 block text-sm font-medium text-slate-700">
            Lọc theo project ID
          </label>
          <div className="flex gap-2">
            <input
              id="impact-gallery-project-filter"
              value={projectFilter}
              onChange={event => setProjectFilter(event.target.value)}
              placeholder="Ví dụ: p-001"
              type="search"
              className="min-w-0 flex-1 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
            />
            <button
              type="submit"
              className="rounded-md bg-cyan-700 px-4 py-2 text-sm font-semibold text-white transition hover:bg-cyan-800 focus:outline-none focus:ring-2 focus:ring-cyan-300"
            >
              Áp dụng
            </button>
          </div>
        </form>
      </header>

      {galleryQuery.isLoading ? (
        <div data-testid="sbt-gallery-grid" className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: SBT_GALLERY_SKELETON_COUNT }, (_, index) => (
            <SbtCardSkeleton key={index} />
          ))}
        </div>
      ) : galleryQuery.isError ? (
        <section className="rounded-xl border border-red-200 bg-red-50 p-8 text-center">
          <p className="text-sm font-semibold text-red-700">
            {galleryQuery.error?.message || 'Không thể tải gallery SBT.'}
          </p>
          <button
            type="button"
            onClick={() => void galleryQuery.refetch()}
            className="mt-4 rounded-md border border-red-300 bg-white px-4 py-2 text-sm font-semibold text-red-700 transition hover:bg-red-100"
          >
            Thử lại
          </button>
        </section>
      ) : entries.length === 0 ? (
        <section className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-12 text-center">
          <p className="text-base font-semibold text-slate-700">Chưa có SBT nào được mint</p>
          {appliedProjectId && (
            <p className="mt-2 text-sm text-slate-500">Thử xoá bộ lọc project để xem toàn bộ gallery.</p>
          )}
        </section>
      ) : (
        <>
          <div data-testid="sbt-gallery-grid" className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {entries.map((entry, index) => (
              <SbtCard key={`${entry.projectId}-${entry.onChainTokenId ?? `pending-${index}`}`} entry={entry} />
            ))}
          </div>

          {pagination && pagination.totalPages > 1 && (
            <nav aria-label="Phân trang Impact NFT" className="mt-8 flex items-center justify-center gap-3">
              <button
                type="button"
                onClick={() => handlePageChange(page - 1)}
                disabled={page <= 1 || galleryQuery.isFetching}
                className="rounded-md border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Trang trước
              </button>
              <span className="font-mono text-sm text-slate-600">
                {pagination.page} / {pagination.totalPages}
              </span>
              <button
                type="button"
                onClick={() => handlePageChange(page + 1)}
                disabled={page >= pagination.totalPages || galleryQuery.isFetching}
                className="rounded-md border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Trang sau
              </button>
            </nav>
          )}
        </>
      )}
    </main>
  );
}
