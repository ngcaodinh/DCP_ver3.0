import '@testing-library/jest-dom';
import { vi } from 'vitest';

// Suppress jsdom warning: "Not implemented: HTMLCanvasElement's getContext() method"
HTMLCanvasElement.prototype.getContext = vi.fn(
  (contextId: '2d' | 'webgl' | 'webgl2' | 'bitmaprenderer', options?: unknown) => {
    return null;
  },
) as unknown as typeof HTMLCanvasElement.prototype.getContext;
