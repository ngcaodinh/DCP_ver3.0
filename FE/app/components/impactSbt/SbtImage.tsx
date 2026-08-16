'use client';

import { useEffect, useState } from 'react';
import { useIpfsImageSource } from '@/app/hooks/useIpfsImageSource';

interface SbtImageProps {
  imageCid: string;
  imageGatewayUrl: string | null;
  alt: string;
}

/** Component trình bày ảnh SBT với source IPFS đã được hook xử lý fallback và watchdog. */
export default function SbtImage({ imageCid, imageGatewayUrl, alt }: SbtImageProps) {
  const { src, imageRef, handleLoad, handleError } = useIpfsImageSource(imageCid, imageGatewayUrl);
  const [hasLoaded, setHasLoaded] = useState(false);

  /** Reset spinner khi hook chuyển sang gateway khác hoặc record ảnh thay đổi. */
  useEffect(() => {
    setHasLoaded(false);
  }, [src]);

  /** Đánh dấu ảnh đã tải xong rồi ủy quyền dọn watchdog cho hook IPFS. */
  function handleImageLoad(): void {
    setHasLoaded(true);
    handleLoad();
  }

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
    <div className="relative aspect-square overflow-hidden">
      {/* eslint-disable-next-line @next/next/no-img-element -- Cần dùng source IPFS động và hook onError/onTimeout cho ảnh public. */}
      <img
        data-testid="sbt-image"
        ref={imageRef}
        src={src}
        alt={alt}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onLoad={handleImageLoad}
        onError={handleError}
        className="h-full w-full object-cover"
      />
      {!hasLoaded && (
        <div
          data-testid="sbt-image-loading"
          role="status"
          aria-label="Đang tải hình ảnh SBT"
          className="absolute inset-0 flex items-center justify-center bg-slate-900/10"
        >
          <span className="h-10 w-10 animate-spin rounded-full border-4 border-white/60 border-t-cyan-600" />
        </div>
      )}
    </div>
  );
}
