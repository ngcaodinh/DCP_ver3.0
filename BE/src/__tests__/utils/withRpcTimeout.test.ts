import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}));

import { withRpcTimeout } from '../../utils/withRpcTimeout';

describe('withRpcTimeout', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves the provider value and clears the watchdog', async () => {
    vi.useFakeTimers();

    const request = withRpcTimeout(Promise.resolve('ok'), 100);

    await expect(request).resolves.toBe('ok');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('propagates a provider rejection before the timeout', async () => {
    const providerError = new Error('RPC unavailable');

    await expect(withRpcTimeout(Promise.reject(providerError), 100)).rejects.toBe(providerError);
  });

  it('rejects a hanging provider request at the configured timeout', async () => {
    vi.useFakeTimers();
    const request = withRpcTimeout(new Promise<never>(() => undefined), 100);
    const rejection = expect(request).rejects.toMatchObject({ code: 'TIMEOUT' });

    await vi.advanceTimersByTimeAsync(100);

    await rejection;
  });

  it('ignores a provider resolution that arrives after the timeout', async () => {
    vi.useFakeTimers();
    let resolveProvider: ((value: string) => void) | undefined;
    const request = withRpcTimeout(new Promise<string>(resolve => {
      resolveProvider = resolve;
    }), 100);
    const rejection = expect(request).rejects.toMatchObject({ code: 'TIMEOUT' });

    await vi.advanceTimersByTimeAsync(100);
    resolveProvider?.('late-value');

    await rejection;
  });

  it('ignores a provider rejection that arrives after the timeout', async () => {
    vi.useFakeTimers();
    let rejectProvider: ((error: Error) => void) | undefined;
    const request = withRpcTimeout(new Promise<never>((_resolve, reject) => {
      rejectProvider = reject;
    }), 100);
    const rejection = expect(request).rejects.toMatchObject({ code: 'TIMEOUT' });

    await vi.advanceTimersByTimeAsync(100);
    rejectProvider?.(new Error('late-provider-error'));

    await rejection;
  });
});
