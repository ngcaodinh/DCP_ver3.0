import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findHot: vi.fn(),
  findArchived: vi.fn(),
  markArchived: vi.fn(),
  deleteArchived: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  store: {
    putImmutable: vi.fn(),
    verify: vi.fn()
  }
}));

vi.mock('../../models/projectEventModel', () => ({
  findHotEventsOlderThan: mocks.findHot,
  findArchivedRegularEventsOlderThan: mocks.findArchived,
  markProjectEventArchived: mocks.markArchived,
  deleteArchivedEventsOlderThan: mocks.deleteArchived
}));
vi.mock('../../services/adminAuditArchive.service', () => ({
  createConfiguredAuditArchiveStore: vi.fn(() => null),
  getCalendarYearCutoff: (now: Date) => {
    const cutoff = new Date(now);
    cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 1);
    return cutoff;
  },
  sha256: vi.fn(() => 'checksum')
}));
vi.mock('../../config/logger', () => ({
  getLogger: vi.fn(() => mocks.logger)
}));

import {
  archiveProjectEvents,
  buildProjectEventArchiveLocator,
  purgeArchivedRegularEvents
} from '../../services/event-archive.service';

const now = new Date('2026-08-16T00:00:00.000Z');

function record(overrides: Record<string, unknown> = {}) {
  return {
    eventId: 'EVT-1',
    eventType: 'DONATION_CONFIRMED' as const,
    projectId: 'project-1',
    timestamp: new Date('2025-01-01T00:00:00.000Z'),
    walletAddress: '0xabcdef1234567890abcdef1234567890abcdef12',
    amount: 100,
    correlationId: 'donation:1',
    organizationId: 'org-1',
    payload: {},
    source: 'api' as const,
    archiveState: 'HOT' as const,
    archivedAt: null,
    archiveLocator: null,
    archiveChecksum: null,
    createdAt: new Date('2025-01-01T00:00:01.000Z'),
    ...overrides
  };
}

describe('event-archive.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findHot.mockResolvedValue([]);
    mocks.findArchived.mockResolvedValue([]);
    mocks.markArchived.mockResolvedValue(true);
    mocks.deleteArchived.mockResolvedValue(1);
    mocks.store.putImmutable.mockResolvedValue(undefined);
    mocks.store.verify.mockResolvedValue(true);
  });

  it('archive regular event sau 90 ngày bằng locator project-events và verify checksum', async () => {
    mocks.findHot.mockResolvedValueOnce([record()]);

    const result = await archiveProjectEvents({ store: mocks.store, now, batchSize: 10, maxBatches: 2 });

    expect(result.archived).toBe(1);
    expect(mocks.store.putImmutable).toHaveBeenCalledWith(
      expect.stringMatching(/^project-events\/2025\/01\/EVT-1\.json$/),
      expect.any(Buffer),
      'checksum'
    );
    expect(mocks.store.verify).toHaveBeenCalledWith(expect.stringContaining('project-events/'), 'checksum');
    expect(mocks.markArchived).toHaveBeenCalledWith('EVT-1', now, expect.stringContaining('project-events/'), 'checksum');
  });

  it('verify fail giữ event HOT và không mark ARCHIVED', async () => {
    mocks.findHot.mockResolvedValueOnce([record()]);
    mocks.store.verify.mockResolvedValue(false);

    const result = await archiveProjectEvents({ store: mocks.store, now, batchSize: 10, maxBatches: 2 });

    expect(result.failed).toBe(1);
    expect(mocks.markArchived).not.toHaveBeenCalled();
    expect(mocks.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Archive project event thất bại'),
      expect.any(Object)
    );
  });

  it('purge regular archived event chỉ sau verify thành công ngay trước khi xoá', async () => {
    mocks.findArchived.mockResolvedValueOnce([record({
      archiveState: 'ARCHIVED',
      archiveLocator: 'project-events/2025/01/EVT-1.json',
      archiveChecksum: 'checksum'
    })]);

    const result = await purgeArchivedRegularEvents({ store: mocks.store, now, batchSize: 10, maxBatches: 1 });

    expect(result.deleted).toBe(1);
    expect(mocks.store.verify).toHaveBeenCalledWith('project-events/2025/01/EVT-1.json', 'checksum');
    expect(mocks.deleteArchived).toHaveBeenCalledWith(expect.any(Date), ['EVT-1']);
  });

  it('verify false không xoá regular event', async () => {
    mocks.findArchived.mockResolvedValueOnce([record({
      archiveState: 'ARCHIVED',
      archiveLocator: 'project-events/2025/01/EVT-1.json',
      archiveChecksum: 'checksum'
    })]);
    mocks.store.verify.mockResolvedValue(false);

    const result = await purgeArchivedRegularEvents({ store: mocks.store, now, batchSize: 10, maxBatches: 1 });

    expect(result.failed).toBe(1);
    expect(result.deleted).toBe(0);
    expect(mocks.deleteArchived).not.toHaveBeenCalled();
  });

  it('verify song song trong bounded batch và chỉ delete Mongo một lần', async () => {
    mocks.findArchived.mockResolvedValueOnce([
      record({ eventId: 'EVT-1', archiveLocator: 'project-events/2025/01/EVT-1.json', archiveChecksum: 'checksum' }),
      record({ eventId: 'EVT-2', archiveLocator: 'project-events/2025/01/EVT-2.json', archiveChecksum: 'checksum' })
    ]);

    const result = await purgeArchivedRegularEvents({ store: mocks.store, now, batchSize: 10, maxBatches: 1 });

    expect(result.deleted).toBe(1);
    expect(mocks.store.verify).toHaveBeenCalledTimes(2);
    expect(mocks.deleteArchived).toHaveBeenCalledTimes(1);
    expect(mocks.deleteArchived).toHaveBeenCalledWith(expect.any(Date), ['EVT-1', 'EVT-2']);
  });

  it('archive SBT_MINTED theo mốc một calendar year, không áp dụng mốc 90 ngày', async () => {
    const immutableRecord = record({
      eventId: 'EVT-SBT',
      eventType: 'SBT_MINTED',
      timestamp: new Date('2025-07-01T00:00:00.000Z')
    });
    mocks.findHot.mockResolvedValueOnce([]).mockResolvedValueOnce([immutableRecord]);

    const result = await archiveProjectEvents({ store: mocks.store, now, batchSize: 10, maxBatches: 2 });

    expect(result.archived).toBe(1);
    expect(mocks.findHot).toHaveBeenNthCalledWith(
      2,
      expect.any(Date),
      expect.arrayContaining(['SBT_MINTED']),
      10
    );
  });

  it('round-robin regular va immutable de khong starvation immutable backlog', async () => {
    const regularRecord = record({ eventId: 'EVT-REGULAR' });
    const immutableRecord = record({ eventId: 'EVT-SBT', eventType: 'SBT_MINTED' });
    mocks.findHot.mockImplementation(async (_cutoff, eventTypes: readonly string[]) => (
      eventTypes.includes('SBT_MINTED') ? [immutableRecord] : [regularRecord]
    ));

    const result = await archiveProjectEvents({ store: mocks.store, now, batchSize: 1, maxBatches: 2 });

    expect(result.archived).toBe(2);
    expect(mocks.findHot).toHaveBeenCalledTimes(2);
    expect(mocks.findHot).toHaveBeenNthCalledWith(2, expect.any(Date), expect.arrayContaining(['SBT_MINTED']), 1);
  });

  it('không archive SBT_MINTED mới hơn một calendar year', async () => {
    mocks.findHot.mockResolvedValue([]);

    const result = await archiveProjectEvents({ store: mocks.store, now, batchSize: 10, maxBatches: 2 });

    expect(result.archived).toBe(0);
    expect(mocks.markArchived).not.toHaveBeenCalled();
    expect(mocks.findHot).toHaveBeenNthCalledWith(
      2,
      new Date('2025-08-16T00:00:00.000Z'),
      expect.arrayContaining(['SBT_MINTED']),
      10
    );
  });

  it('không purge immutable event kể cả khi query trả nhầm record', async () => {
    mocks.findArchived.mockResolvedValueOnce([record({
      eventId: 'EVT-SBT',
      eventType: 'SBT_MINTED',
      archiveState: 'ARCHIVED',
      archiveLocator: 'project-events/2025/01/EVT-SBT.json',
      archiveChecksum: 'checksum'
    })]);

    const result = await purgeArchivedRegularEvents({ store: mocks.store, now, batchSize: 10, maxBatches: 1 });

    expect(result.deleted).toBe(0);
    expect(mocks.store.verify).not.toHaveBeenCalled();
    expect(mocks.deleteArchived).not.toHaveBeenCalled();
  });

  it('locator không dùng prefix audit', () => {
    expect(buildProjectEventArchiveLocator('EVT-1', new Date('2026-02-03T00:00:00.000Z')))
      .toBe('project-events/2026/02/EVT-1.json');
  });
});
