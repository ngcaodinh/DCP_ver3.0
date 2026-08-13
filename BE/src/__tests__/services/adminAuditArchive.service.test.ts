import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  find: vi.fn(),
  updateOne: vi.fn()
}));

vi.mock('../../models/adminAuditLogModel', () => ({
  AdminAuditLogModel: {
    find: mocks.find,
    updateOne: mocks.updateOne
  }
}));

import {
  archiveAdminAuditLogs,
  buildArchiveLocator,
  getCalendarYearCutoff,
  S3CompatibleAuditArchiveStore,
  createConfiguredAuditArchiveStore,
  serializeAuditArchiveRecord,
  sha256,
  type AuditArchiveStore
} from '../../services/adminAuditArchive.service';

const oldDate = new Date('2024-08-11T23:59:59.000Z');
const oldRecord = {
  actionId: 'action/1',
  actorType: 'ADMIN' as const,
  adminId: 'admin-1',
  adminRole: 'admin',
  actionType: 'MANUAL_REJECT' as const,
  targetId: 'request-1',
  targetType: 'DISBURSEMENT_REQUEST' as const,
  reason: 'Thiếu chứng từ',
  ipAddress: '10.0.0.1',
  userAgent: 'agent',
  context: { requestId: 'request-1', rawBody: { token: 'secret' } },
  requiresEscalation: false,
  escalationPolicy: null,
  createdAt: oldDate,
  auditId: 'action/1',
  adminUserId: 'admin-1',
  action: 'MANUAL_REJECT' as const,
  targetRequestId: 'request-1',
  metadata: {}
};

function queryChain(records: unknown[]) {
  return {
    sort: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    lean: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue(records)
  };
}

function storeMock(): AuditArchiveStore {
  return {
    putImmutable: vi.fn().mockResolvedValue(undefined),
    verify: vi.fn().mockResolvedValue(true)
  };
}

describe('adminAuditArchive.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.find.mockReturnValue(queryChain([oldRecord]));
    mocks.updateOne.mockReturnValue({ exec: vi.fn().mockResolvedValue({ matchedCount: 1, modifiedCount: 1 }) });
  });

  it('archives only selected HOT records, verifies checksum and never deletes', async () => {
    const store = storeMock();
    const now = new Date('2026-08-12T00:00:00.000Z');
    const result = await archiveAdminAuditLogs({ now, batchSize: 50, store });

    expect(result).toMatchObject({ scanned: 1, archived: 1, failed: 0 });
    expect(mocks.find).toHaveBeenCalledWith({ archiveState: 'HOT', createdAt: { $lt: new Date('2025-08-12T00:00:00.000Z') } });
    expect(mocks.find.mock.results[0].value.select).toHaveBeenCalledWith(expect.stringContaining('actionId'));
    expect(store.putImmutable).toHaveBeenCalledWith('admin-audit-logs/2024/08/action%2F1.json', expect.any(Buffer), expect.any(String));
    expect(store.verify).toHaveBeenCalledTimes(1);
    expect(mocks.updateOne).toHaveBeenCalledWith(
      { actionId: 'action/1', archiveState: 'HOT' },
      { $set: expect.objectContaining({ archiveState: 'ARCHIVED', archivedAt: now }) }
    );
  });

  it('keeps record HOT when remote checksum verification fails', async () => {
    const store = storeMock();
    vi.mocked(store.verify).mockResolvedValue(false);

    const result = await archiveAdminAuditLogs({ store });

    expect(result).toMatchObject({ scanned: 1, archived: 0, failed: 1 });
    expect(mocks.updateOne).not.toHaveBeenCalled();
  });

  it('drains more than one batch when a run has a bounded batch budget', async () => {
    const store = storeMock();
    mocks.find
      .mockReset()
      .mockReturnValueOnce(queryChain([oldRecord]))
      .mockReturnValueOnce(queryChain([]));

    const result = await archiveAdminAuditLogs({
      now: new Date('2026-08-12T00:00:00.000Z'),
      batchSize: 1,
      maxBatches: 5,
      timeBudgetMs: 10_000,
      store
    });

    expect(mocks.find).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ scanned: 1, archived: 1, hasMore: false });
    expect(result.oldestHotCreatedAt).toBeNull();
    expect(result.backlogAgeMs).toBeNull();
  });

  it('reports remaining HOT backlog when the run reaches its batch budget', async () => {
    const store = storeMock();
    const now = new Date('2026-08-12T00:00:00.000Z');
    const result = await archiveAdminAuditLogs({
      now,
      batchSize: 1,
      maxBatches: 1,
      store
    });

    expect(result).toMatchObject({ scanned: 1, archived: 1, hasMore: true });
    expect(result.oldestHotCreatedAt).toEqual(oldDate);
    expect(result.backlogAgeMs).toBeGreaterThan(0);
  });

  it('uses calendar-year cutoff and serializes only allowlisted fields', () => {
    const now = new Date('2024-02-29T10:00:00.000Z');
    expect(getCalendarYearCutoff(now)).toEqual(new Date('2023-03-01T10:00:00.000Z'));
    expect(buildArchiveLocator('a/b', oldDate)).toBe('admin-audit-logs/2024/08/a%2Fb.json');

    const payload = serializeAuditArchiveRecord(oldRecord);
    const parsed = JSON.parse(payload.toString('utf8')) as Record<string, unknown>;
    expect(parsed.context).toEqual({ requestId: 'request-1' });
    expect(parsed).not.toHaveProperty('rawBody');
    expect(sha256(payload)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('uses immutable HTTP upload and verifies the remote checksum', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 404, headers: new Headers() })
      .mockResolvedValueOnce({ ok: true, status: 200, headers: new Headers() })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'x-amz-checksum-sha256': 'a'.repeat(64) })
      });
    vi.stubGlobal('fetch', fetchMock);
    const store = new S3CompatibleAuditArchiveStore(
      'https://private-archive.example/bucket',
      'archive-token',
      ['private-archive.example']
    );

    await store.putImmutable('admin-audit-logs/2024/08/action.json', Buffer.from('payload'), 'a'.repeat(64));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1]).toEqual(expect.objectContaining({
      method: 'PUT',
      headers: expect.objectContaining({
        authorization: 'Bearer archive-token',
        'if-none-match': '*',
        'x-amz-checksum-sha256': 'a'.repeat(64)
      })
    }));
    await expect(store.verify('admin-audit-logs/2024/08/action.json', 'a'.repeat(64))).resolves.toBe(true);
    vi.unstubAllGlobals();
  });

  it('fails closed when archive endpoint has no bearer credential', () => {
    vi.stubEnv('AUDIT_ARCHIVE_S3_ENDPOINT', 'https://private-archive.example/bucket');
    vi.stubEnv('AUDIT_ARCHIVE_S3_BEARER_TOKEN', '');
    vi.stubEnv('AUDIT_ARCHIVE_S3_ALLOWED_HOSTS', 'private-archive.example');
    expect(createConfiguredAuditArchiveStore()).toBeNull();
    expect(() => new S3CompatibleAuditArchiveStore(
      'https://private-archive.example/bucket',
      undefined,
      ['private-archive.example']
    )).toThrow();
    vi.unstubAllEnvs();
  });

  it('rejects HTTP endpoints and hosts outside the exact allowlist', () => {
    expect(() => new S3CompatibleAuditArchiveStore(
      'http://private-archive.example/bucket',
      'archive-token',
      ['private-archive.example']
    )).toThrow(/HTTPS/);
    expect(() => new S3CompatibleAuditArchiveStore(
      'https://untrusted.example/bucket',
      'archive-token',
      ['private-archive.example']
    )).toThrow(/allowlist/);
  });
});
