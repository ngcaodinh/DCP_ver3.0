'use client';

import Link from 'next/link';
import SbtImage from './SbtImage';
import type { ImpactSbtGalleryEntry } from '@/app/types/impactSbt';

interface SbtCardProps {
  entry: ImpactSbtGalleryEntry;
}

/** Card hiển thị một Impact SBT và chỉ tạo link detail khi tokenId đã có trên chain. */
export default function SbtCard({ entry }: SbtCardProps) {
  const projectDisplayName = entry.projectName ?? entry.projectId;
  const card = (
    <article
      data-testid="sbt-card"
      className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm transition-[transform,box-shadow] duration-200 hover:scale-[1.02] hover:shadow-lg hover:shadow-cyan-500/20 motion-reduce:transform-none motion-reduce:transition-none"
    >
      <SbtImage
        imageCid={entry.imageCid}
        imageGatewayUrl={entry.imageGatewayUrl}
        alt={`Impact SBT của ${projectDisplayName}`}
      />
      <div className="space-y-3 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold text-slate-900">{projectDisplayName}</h2>
            <p className="mt-1 truncate font-mono text-xs text-slate-500">{entry.projectId}</p>
          </div>
          {entry.onChainTokenStatus === 'FROZEN' && (
            <span className="shrink-0 rounded-full border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] font-semibold text-amber-700">
              Đang tạm khoá
            </span>
          )}
        </div>
        <dl className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <dt className="text-xs text-slate-500">Milestone</dt>
            <dd className="mt-1 font-mono font-semibold text-slate-800">{entry.milestone}</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">Người thụ hưởng</dt>
            <dd className="mt-1 font-mono font-semibold text-slate-800">{entry.beneficiaryCount}</dd>
          </div>
        </dl>
      </div>
    </article>
  );

  if (entry.onChainTokenId === null) {
    return card;
  }

  return (
    <Link href={`/impact-gallery/${entry.onChainTokenId}`} className="block">
      {card}
    </Link>
  );
}
