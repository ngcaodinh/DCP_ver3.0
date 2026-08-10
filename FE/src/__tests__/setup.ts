import '@testing-library/jest-dom';
import { vi } from 'vitest';

// Suppress jsdom warning: "Not implemented: HTMLCanvasElement's getContext() method"
HTMLCanvasElement.prototype.getContext = vi.fn(
  (contextId: '2d' | 'webgl' | 'webgl2' | 'bitmaprenderer', options?: unknown) => {
    return null;
  },
) as unknown as typeof HTMLCanvasElement.prototype.getContext;

/** Dựng IntersectionObserver tối thiểu để test mặc định chạy cùng đường production có hỗ trợ lazy viewport. */
if (typeof IntersectionObserver === 'undefined') {
  class DefaultIntersectionObserver {
    public readonly root = null;
    public readonly rootMargin = '0px';
    public readonly thresholds: number[] = [];

    public constructor(_callback: IntersectionObserverCallback, _options?: IntersectionObserverInit) {}

    public observe(_target: Element): void {}

    public unobserve(_target: Element): void {}

    public disconnect(): void {}

    public takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }

  Object.defineProperty(globalThis, 'IntersectionObserver', {
    configurable: true,
    writable: true,
    value: DefaultIntersectionObserver
  });
}
