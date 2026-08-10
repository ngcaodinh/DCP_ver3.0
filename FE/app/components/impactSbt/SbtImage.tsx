'use client';

import { useIpfsImageSource } from '@/app/hooks/useIpfsImageSource';

interface SbtImageProps {
  imageCid: string;
  imageGatewayUrl: string | null;
  alt: string;
}

/** Component trình bày ảnh SBT với source IPFS đã được hook xử lý fallback và watchdog. */
export default function SbtImage({ imageCid, imageGatewayUrl, alt }: SbtImageProps) {
  const { src, imageRef, handleLoad, handleError } = useIpfsImageSource(imageCid, imageGatewayUrl);

  if (!src) {
    return (
      <div
        data-testid="sbt-image-placeholder"
        role="img"
        aria-label="Không thể tải hình ảnh SBT"
        className="flex aspect-square items-center justify-center bg-gradient-to-br from-slate-100 via-cyan-50 to-slate-200 p-6 text-center text-sm font-semibold text-slate-500"
      >
        <span>🖼️ Không thể tải hình ảnh SBT</span>
      </div>
    );
  }

  return (
    /* eslint-disable-next-line @next/next/no-img-element -- Cần dùng source IPFS động và hook onError/onTimeout cho ảnh public. */
    <img
      data-testid="sbt-image"
      ref={imageRef}
      src={src}
      alt={alt}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onLoad={handleLoad}
      onError={handleError}
      className="aspect-square w-full object-cover"
    />
  );
}
