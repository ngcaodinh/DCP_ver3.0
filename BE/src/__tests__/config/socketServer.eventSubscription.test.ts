import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findProjectByProjectId: vi.fn(),
  findPendingManualReviewQueues: vi.fn(),
  connectionHandler: null as ((socket: unknown) => void) | null
}));

vi.mock('socket.io', () => ({
  Server: class MockSocketIOServer {
    constructor() {}

    use() {}

    on(event: string, handler: (socket: unknown) => void) {
      if (event === 'connection') mocks.connectionHandler = handler;
    }

    close() {}
  }
}));

vi.mock('../../models/projectModel', () => ({
  findProjectByProjectId: mocks.findProjectByProjectId
}));
vi.mock('../../models/manualReviewQueueModel', () => ({
  findPendingManualReviewQueues: mocks.findPendingManualReviewQueues
}));
vi.mock('../../models/disbursementModel', () => ({
  findDisbursementsByRequestIds: vi.fn()
}));

import {
  canSubscribeToProjectEvents,
  createEventSubscribeRateLimiter,
  hasAvailableEventProjectRoomSlot,
  initSocketServer,
  shutdownSocketServer
} from '../../config/socketServer';

describe('socketServer event subscription authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mocks.findProjectByProjectId.mockResolvedValue({ organizationId: 'org-1' });
    mocks.findPendingManualReviewQueues.mockResolvedValue([]);
    mocks.connectionHandler = null;
  });

  afterEach(() => {
    shutdownSocketServer();
    vi.useRealTimers();
  });

  it('cho phép admin và regulatory mà không cần query project', async () => {
    await expect(canSubscribeToProjectEvents('project-1', 'admin', 'admin-1')).resolves.toBe(true);
    await expect(canSubscribeToProjectEvents('project-1', 'regulatory', 'reg-1')).resolves.toBe(true);
    expect(mocks.findProjectByProjectId).not.toHaveBeenCalled();
  });

  it('chỉ cho organization owner subscribe project của chính mình', async () => {
    await expect(canSubscribeToProjectEvents('project-1', 'organizations', 'org-1')).resolves.toBe(true);
    await expect(canSubscribeToProjectEvents('project-1', 'organizations', 'org-2')).resolves.toBe(false);
    expect(mocks.findProjectByProjectId).toHaveBeenCalledTimes(2);
  });

  it('từ chối role không có quyền event project', async () => {
    await expect(canSubscribeToProjectEvents('project-1', 'donor', 'user-1')).resolves.toBe(false);
    expect(mocks.findProjectByProjectId).not.toHaveBeenCalled();
  });

  it('giới hạn cả các lần subscribe bị từ chối và mở lại sau một cửa sổ', () => {
    const limiter = createEventSubscribeRateLimiter();

    for (let attempt = 0; attempt < 30; attempt += 1) {
      expect(limiter()).toBe(true);
    }
    expect(limiter()).toBe(false);

    vi.advanceTimersByTime(60_000);
    expect(limiter()).toBe(true);
  });

  it('tính cả room đang pending để không vượt quota khi subscribe đồng thời', () => {
    const subscribedRooms = new Set(Array.from({ length: 19 }, (_, index) => `events:project-${index}`));
    const pendingRooms = new Set(['events:pending-project']);

    expect(hasAvailableEventProjectRoomSlot(subscribedRooms, pendingRooms)).toBe(false);
    expect(hasAvailableEventProjectRoomSlot(subscribedRooms, new Set())).toBe(true);
  });

  it('wires events:subscribe voi authorization, validation va room join thuc te', async () => {
    const handlers = new Map<string, (payload?: unknown) => void>();
    const socket = {
      data: { userId: 'org-1', role: 'organizations' },
      join: vi.fn().mockResolvedValue(undefined),
      leave: vi.fn().mockResolvedValue(undefined),
      emit: vi.fn(),
      on: vi.fn((event: string, handler: (payload?: unknown) => void) => {
        handlers.set(event, handler);
      })
    };

    initSocketServer({} as never);
    mocks.connectionHandler?.(socket);
    const subscribe = handlers.get('events:subscribe');
    expect(subscribe).toBeDefined();

    subscribe?.('project-1');
    await vi.waitFor(() => expect(socket.emit).toHaveBeenCalledWith(
      'events:subscribe:ok',
      { projectId: 'project-1' }
    ));
    expect(socket.join).toHaveBeenCalledWith('events:project-1');

    mocks.findProjectByProjectId.mockResolvedValueOnce({ organizationId: 'org-2' });
    subscribe?.('project-2');
    await vi.waitFor(() => expect(socket.emit).toHaveBeenCalledWith(
      'events:subscribe:denied',
      { projectId: 'project-2' }
    ));

    subscribe?.('../invalid');
    await vi.waitFor(() => expect(socket.emit).toHaveBeenCalledWith(
      'events:subscribe:denied',
      { projectId: '../invalid' }
    ));
  });
});
