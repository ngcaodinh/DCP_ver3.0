'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { SBT_IMAGE_MAX_GATEWAYS, SBT_IMAGE_TIMEOUT_MS } from '@/app/constants/impactSbtGallery';
import { isAllowedIpfsGatewayUrl, buildIpfsGatewayUrlList } from '@/app/utils/ipfs';

export interface UseIpfsImageSourceResult {
  src: string | null;
  imageRef: MutableRefObject<HTMLImageElement | null>;
  isExhausted: boolean;
  handleLoad: () => void;
  handleError: () => void;
}

/** Hook quản lý thứ tự gateway, lazy viewport và watchdog cho ảnh IPFS public. */
export function useIpfsImageSource(
  imageCid: string,
  imageGatewayUrl: string | null
): UseIpfsImageSourceResult {
  const [currentGatewayIndex, setCurrentGatewayIndex] = useState(0);
  const [visibleImageKey, setVisibleImageKey] = useState<string | null>(null);
  const imageElementRef = useRef<HTMLImageElement | null>(null);
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const imageLoadedRef = useRef(false);
  const imageKey = `${imageCid}\u0000${imageGatewayUrl ?? ''}`;
  const isCurrentImageVisible = visibleImageKey === imageKey;
  const gatewayUrls = useMemo(() => {
    const trustedBackendUrl = imageGatewayUrl && isAllowedIpfsGatewayUrl(imageGatewayUrl)
      ? imageGatewayUrl
      : null;
    return [...new Set([trustedBackendUrl, ...buildIpfsGatewayUrlList(imageCid)].filter((url): url is string => Boolean(url)))].slice(
      0,
      SBT_IMAGE_MAX_GATEWAYS
    );
  }, [imageCid, imageGatewayUrl]);

  /** Hủy watchdog hiện tại để tránh cập nhật state sau khi ảnh thành công hoặc component unmount. */
  const clearWatchdog = useCallback((): void => {
    if (watchdogRef.current !== null) {
      clearTimeout(watchdogRef.current);
      watchdogRef.current = null;
    }
  }, []);

  useEffect(() => {
    setCurrentGatewayIndex(0);
  }, [imageCid, imageGatewayUrl]);

  /** Reset trạng thái load khi record đổi để ảnh mới không kế thừa trạng thái thành công của ảnh cũ. */
  useEffect(() => {
    imageLoadedRef.current = false;
  }, [imageKey]);

  /** Chỉ arm watchdog khi ảnh thật sự vào viewport; browser cũ sẽ arm ngay để vẫn có fallback. */
  useEffect(() => {
    const imageElement = imageElementRef.current;
    if (!imageElement) return undefined;

    if (typeof IntersectionObserver === 'undefined') {
      setVisibleImageKey(imageKey);
      return undefined;
    }

    let hasIntersected = false;
    const observer = new IntersectionObserver(entries => {
      if (hasIntersected || !entries.some(entry => entry.isIntersecting)) return;

      hasIntersected = true;
      setVisibleImageKey(imageKey);
      observer.disconnect();
    });
    observer.observe(imageElement);

    return () => observer.disconnect();
  }, [imageKey]);

  useEffect(() => {
    const currentUrl = gatewayUrls[currentGatewayIndex];
    if (!currentUrl || !isCurrentImageVisible || imageLoadedRef.current) return undefined;

    // Gateway IPFS có thể không trả onError khi treo; watchdog bảo đảm card luôn chuyển fallback.
    watchdogRef.current = setTimeout(() => {
      watchdogRef.current = null;
      setCurrentGatewayIndex(index => index + 1);
    }, SBT_IMAGE_TIMEOUT_MS);

    return clearWatchdog;
  }, [clearWatchdog, currentGatewayIndex, gatewayUrls, isCurrentImageVisible]);

  /** Đánh dấu ảnh đã tải thành công và dọn watchdog của gateway hiện tại. */
  const handleLoad = useCallback((): void => {
    imageLoadedRef.current = true;
    clearWatchdog();
  }, [clearWatchdog]);

  /** Chuyển sang gateway kế tiếp khi gateway hiện tại trả lỗi. */
  const handleError = useCallback((): void => {
    clearWatchdog();
    setCurrentGatewayIndex(index => index + 1);
  }, [clearWatchdog]);

  const src = gatewayUrls[currentGatewayIndex] ?? null;

  return {
    src,
    imageRef: imageElementRef,
    isExhausted: src === null,
    handleLoad,
    handleError
  };
}
