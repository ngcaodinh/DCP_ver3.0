import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  io: null as { to: ReturnType<typeof vi.fn> } | null,
  redis: null as { duplicate: ReturnType<typeof vi.fn> } | null,
  redisReadyListener: null as (() => void) | null,
  subscriber: {
    connect: vi.fn(),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    quit: vi.fn(),
    on: vi.fn()
  },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

vi.mock('../../config/redis', () => ({
  getRedisClientIfReady: vi.fn(() => mocks.redis),
  onRedisReady: vi.fn((listener: () => void) => {
    mocks.redisReadyListener = listener;
    return vi.fn();
  })
}));
vi.mock('../../config/socketServer', () => ({
  getSocketServer: vi.fn(() => mocks.io)
}));
vi.mock('../../config/logger', () => ({
  getLogger: vi.fn(() => mocks.logger)
}));

import {
  initializeEventSocketBridge,
  shutdownEventSocketBridge
} from '../../services/eventSocketBridge.service';

function liveMessage(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    eventId: 'EVT-1',
    eventType: 'DONATION_CONFIRMED',
    projectId: 'project-1',
    timestamp: '2026-08-16T00:00:00.000Z',
    walletAddress: '0xabcdef1234567890abcdef1234567890abcdef12',
    amount: 100,
    correlationId: 'donation:0xtx',
    organizationId: 'org-1',
    payload: { transactionHash: '0xtx', blockNumber: 1, isAnonymous: false },
    ...overrides
  });
}

describe('eventSocketBridge', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.io = { to: vi.fn(() => ({ emit: vi.fn() })) };
    mocks.redis = { duplicate: vi.fn(() => mocks.subscriber) };
    mocks.redisReadyListener = null;
    mocks.subscriber.connect.mockResolvedValue(undefined);
    mocks.subscriber.subscribe.mockResolvedValue(undefined);
    mocks.subscriber.unsubscribe.mockResolvedValue(undefined);
    mocks.subscriber.quit.mockResolvedValue(undefined);
    await shutdownEventSocketBridge();
  });

  it('subscribe live event và emit vào room project với wallet đã che', async () => {
    let handler: ((message: string) => void) | undefined;
    mocks.subscriber.subscribe.mockImplementation(async (_channel: string, callback: (message: string) => void) => {
      handler = callback;
    });
    initializeEventSocketBridge();
    await vi.waitFor(() => expect(mocks.subscriber.subscribe).toHaveBeenCalledTimes(1));

    handler?.(liveMessage());
    const roomEmitter = mocks.io!.to.mock.results[0]?.value as { emit: ReturnType<typeof vi.fn> };
    expect(mocks.io!.to).toHaveBeenCalledWith('events:project-1');
    expect(roomEmitter.emit).toHaveBeenCalledWith('event:new', expect.objectContaining({
      walletAddress: '0xabcd...ef12'
    }));
  });

  it('SYBIL_FLAGGED chỉ emit admin, không emit project room', async () => {
    let handler: ((message: string) => void) | undefined;
    mocks.subscriber.subscribe.mockImplementation(async (_channel: string, callback: (message: string) => void) => {
      handler = callback;
    });
    initializeEventSocketBridge();
    await vi.waitFor(() => expect(mocks.subscriber.subscribe).toHaveBeenCalledTimes(1));

    handler?.(liveMessage({ eventType: 'SYBIL_FLAGGED', projectId: null, payload: { riskScore: null, flagReason: 'manual' } }));
    expect(mocks.io!.to).toHaveBeenCalledWith('admin');
    expect(mocks.io!.to).not.toHaveBeenCalledWith('events:project-1');
  });

  it('io chưa sẵn sàng thì bridge bỏ qua message mà không crash', async () => {
    let handler: ((message: string) => void) | undefined;
    mocks.io = null;
    mocks.subscriber.subscribe.mockImplementation(async (_channel: string, callback: (message: string) => void) => {
      handler = callback;
    });
    initializeEventSocketBridge();
    await vi.waitFor(() => expect(mocks.subscriber.subscribe).toHaveBeenCalledTimes(1));
    expect(() => handler?.(liveMessage())).not.toThrow();
  });

  it('subscribe lại channel sau khi Redis reconnect', async () => {
    const listeners = new Map<string, () => void>();
    mocks.subscriber.on.mockImplementation((event: string, listener: () => void) => {
      listeners.set(event, listener);
      return mocks.subscriber;
    });
    initializeEventSocketBridge();
    await vi.waitFor(() => expect(mocks.subscriber.subscribe).toHaveBeenCalledTimes(1));

    mocks.subscriber.subscribe.mockClear();
    listeners.get('reconnecting')?.();
    listeners.get('ready')?.();

    await vi.waitFor(() => expect(mocks.subscriber.subscribe).toHaveBeenCalledTimes(1));
  });

  it('tự retry khởi tạo khi Redis chưa ready tại thời điểm startup', async () => {
    mocks.redis = null;
    initializeEventSocketBridge();
    expect(mocks.redisReadyListener).toEqual(expect.any(Function));

    mocks.redis = { duplicate: vi.fn(() => mocks.subscriber) };
    mocks.redisReadyListener?.();

    await vi.waitFor(() => expect(mocks.subscriber.subscribe).toHaveBeenCalledTimes(1));
  });
});
