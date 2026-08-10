import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SBT_IMAGE_TIMEOUT_MS } from '@/app/constants/impactSbtGallery';
import SbtImage from '@/app/components/impactSbt/SbtImage';

const VALID_CID = `Qm${'a'.repeat(44)}`;
const PRIMARY_URL = `https://ipfs.io/ipfs/${VALID_CID}`;
const FALLBACK_URL = `https://gateway.pinata.cloud/ipfs/${VALID_CID}`;

function renderImage(imageGatewayUrl: string | null = PRIMARY_URL, imageCid = VALID_CID) {
  return render(
    <SbtImage imageCid={imageCid} imageGatewayUrl={imageGatewayUrl} alt="Impact SBT" />
  );
}

/** Dựng IntersectionObserver giả để kiểm soát chính xác thời điểm ảnh vào viewport trong jsdom. */
function mockIntersectionObserver(): {
  observe: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  trigger: (isIntersecting: boolean) => void;
} {
  let callback: IntersectionObserverCallback | null = null;
  const observe = vi.fn();
  const disconnect = vi.fn();

  vi.stubGlobal('IntersectionObserver', class {
    public constructor(nextCallback: IntersectionObserverCallback) {
      callback = nextCallback;
    }

    public observe = observe;
    public disconnect = disconnect;
  });

  return {
    observe,
    disconnect,
    trigger: (isIntersecting: boolean): void => {
      callback?.([{ isIntersecting } as IntersectionObserverEntry], {} as IntersectionObserver);
    }
  };
}

describe('SbtImage', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('uses the backend gateway first and does not request fallback initially', () => {
    renderImage();

    expect(screen.getByTestId('sbt-image')).toHaveAttribute('src', PRIMARY_URL);
  });

  it('moves to the second gateway after an image error and then renders placeholder', () => {
    renderImage();
    fireEvent.error(screen.getByTestId('sbt-image'));
    expect(screen.getByTestId('sbt-image')).toHaveAttribute('src', FALLBACK_URL);

    fireEvent.error(screen.getByTestId('sbt-image'));
    expect(screen.queryByTestId('sbt-image')).not.toBeInTheDocument();
    expect(screen.getByTestId('sbt-image-placeholder')).toBeInTheDocument();
  });

  it('does not start watchdog while a below-the-fold image has not entered the viewport', () => {
    const observer = mockIntersectionObserver();
    vi.useFakeTimers();
    renderImage();

    act(() => {
      vi.advanceTimersByTime(SBT_IMAGE_TIMEOUT_MS * 3);
    });

    expect(observer.observe).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('sbt-image')).toHaveAttribute('src', PRIMARY_URL);
    expect(screen.queryByTestId('sbt-image-placeholder')).not.toBeInTheDocument();
  });

  it('moves to fallback when the visible gateway watchdog expires', () => {
    const observer = mockIntersectionObserver();
    vi.useFakeTimers();
    renderImage();

    act(() => {
      observer.trigger(true);
    });

    act(() => {
      vi.advanceTimersByTime(SBT_IMAGE_TIMEOUT_MS);
    });

    expect(screen.getByTestId('sbt-image')).toHaveAttribute('src', FALLBACK_URL);
  });

  it('does not arm a watchdog for an image that already loaded before it became visible', () => {
    const observer = mockIntersectionObserver();
    vi.useFakeTimers();
    renderImage();
    fireEvent.load(screen.getByTestId('sbt-image'));

    act(() => {
      observer.trigger(true);
      vi.advanceTimersByTime(SBT_IMAGE_TIMEOUT_MS * 2);
    });

    expect(screen.getByTestId('sbt-image')).toHaveAttribute('src', PRIMARY_URL);
  });

  it('arms the watchdog immediately when IntersectionObserver is unavailable', () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    vi.useFakeTimers();
    renderImage();

    act(() => {
      vi.advanceTimersByTime(SBT_IMAGE_TIMEOUT_MS);
    });

    expect(screen.getByTestId('sbt-image')).toHaveAttribute('src', FALLBACK_URL);
  });

  it('clears watchdog after load and on unmount', () => {
    const observer = mockIntersectionObserver();
    vi.useFakeTimers();
    const { unmount } = renderImage();
    act(() => {
      observer.trigger(true);
    });
    fireEvent.load(screen.getByTestId('sbt-image'));

    act(() => {
      vi.advanceTimersByTime(SBT_IMAGE_TIMEOUT_MS);
    });
    expect(screen.getByTestId('sbt-image')).toHaveAttribute('src', PRIMARY_URL);
    expect(vi.getTimerCount()).toBe(0);

    unmount();
    act(() => {
      vi.advanceTimersByTime(SBT_IMAGE_TIMEOUT_MS);
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses fixed fallback when backend omits gateway but CID remains valid', () => {
    renderImage(null, VALID_CID);

    expect(screen.getByTestId('sbt-image')).toHaveAttribute('src', FALLBACK_URL);
  });

  it('renders placeholder immediately when backend gateway and CID are unusable', () => {
    renderImage(null, 'not-a-cid');

    expect(screen.queryByTestId('sbt-image')).not.toBeInTheDocument();
    expect(screen.getByTestId('sbt-image-placeholder')).toBeInTheDocument();
  });

  it('ignores a non-HTTPS backend gateway and keeps the fixed fallback', () => {
    renderImage('javascript:alert(1)');

    expect(screen.getByTestId('sbt-image')).toHaveAttribute('src', FALLBACK_URL);
    expect(screen.getByTestId('sbt-image')).toHaveAttribute('referrerpolicy', 'no-referrer');
  });

  it('ignores an HTTPS backend gateway outside the fixed host allowlist', () => {
    renderImage(`https://attacker.example/ipfs/${VALID_CID}`);

    expect(screen.getByTestId('sbt-image')).toHaveAttribute('src', FALLBACK_URL);
  });
});
