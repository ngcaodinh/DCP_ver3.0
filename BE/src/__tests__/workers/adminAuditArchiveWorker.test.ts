import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ archiveAdminAuditLogs: vi.fn() }));

vi.mock('../../services/adminAuditArchive.service', () => ({
  archiveAdminAuditLogs: mocks.archiveAdminAuditLogs,
  createConfiguredAuditArchiveStore: vi.fn()
}));

import {
  runAdminAuditArchiveOnce,
  startAdminAuditArchiveWorker,
  stopAdminAuditArchiveWorker
} from '../../workers/adminAuditArchiveWorker';
import type { AuditArchiveStore } from '../../services/adminAuditArchive.service';

describe('adminAuditArchiveWorker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    delete process.env.AUDIT_ARCHIVE_ENABLED;
  });

  afterEach(() => {
    stopAdminAuditArchiveWorker();
    vi.useRealTimers();
  });

  it('runs one archive cycle and returns operational counters', async () => {
    const result = {
      cutoff: new Date('2025-08-12T00:00:00.000Z'),
      scanned: 3,
      archived: 2,
      skipped: 1,
      failed: 0,
      hasMore: false,
      oldestHotCreatedAt: null,
      backlogAgeMs: null
    };
    mocks.archiveAdminAuditLogs.mockResolvedValue(result);

    await expect(runAdminAuditArchiveOnce({} as never)).resolves.toEqual(result);
    expect(mocks.archiveAdminAuditLogs).toHaveBeenCalledWith({
      store: {},
      maxBatches: 100,
      timeBudgetMs: 30_000
    });
  });

  it('does not start when archive is disabled and prevents duplicate intervals', async () => {
    const store = {} as AuditArchiveStore;
    startAdminAuditArchiveWorker(store);
    expect(mocks.archiveAdminAuditLogs).not.toHaveBeenCalled();

    process.env.AUDIT_ARCHIVE_ENABLED = 'true';
    mocks.archiveAdminAuditLogs.mockResolvedValue({
      cutoff: new Date(),
      scanned: 0,
      archived: 0,
      skipped: 0,
      failed: 0,
      hasMore: false,
      oldestHotCreatedAt: null,
      backlogAgeMs: null
    });
    startAdminAuditArchiveWorker(store);
    startAdminAuditArchiveWorker(store);
    await Promise.resolve();
    expect(mocks.archiveAdminAuditLogs).toHaveBeenCalledTimes(1);
  });

  it('does not overlap scheduled archive cycles while the previous cycle is running', async () => {
    process.env.AUDIT_ARCHIVE_ENABLED = 'true';
    let resolveArchive: ((value: unknown) => void) | undefined;
    mocks.archiveAdminAuditLogs.mockReturnValue(new Promise(resolve => { resolveArchive = resolve; }));
    const store = {} as AuditArchiveStore;

    startAdminAuditArchiveWorker(store);
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(mocks.archiveAdminAuditLogs).toHaveBeenCalledTimes(1);

    resolveArchive?.({
      cutoff: new Date(),
      scanned: 0,
      archived: 0,
      skipped: 0,
      failed: 0,
      hasMore: false,
      oldestHotCreatedAt: null,
      backlogAgeMs: null
    });
    await Promise.resolve();
  });
});
