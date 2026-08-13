import { describe, expect, it, vi } from 'vitest';
import { migrateAdminAuditLogSchema } from '../../scripts/migrateAdminAuditLogSchema';

function collection(documents: Record<string, unknown>[]) {
  return {
    find: vi.fn(() => ({ toArray: vi.fn().mockResolvedValue(documents) })),
    insertOne: vi.fn().mockResolvedValue(undefined),
    updateOne: vi.fn().mockResolvedValue(undefined)
  };
}

function streamingCollection(documents: Record<string, unknown>[]) {
  let index = 0;
  const cursor = {
    sort: vi.fn().mockReturnThis(),
    batchSize: vi.fn().mockReturnThis(),
    hasNext: vi.fn(async () => index < documents.length),
    next: vi.fn(async () => documents[index++]),
    toArray: vi.fn(async () => { throw new Error('unbounded toArray must not be used'); })
  };
  return {
    find: vi.fn(() => cursor),
    insertOne: vi.fn().mockResolvedValue(undefined),
    updateOne: vi.fn().mockResolvedValue(undefined),
    cursor
  };
}

describe('migrateAdminAuditLogSchema', () => {
  it('dry-run không ghi, apply backfill canonical và copy webhook không xóa source', async () => {
    const sourceDocuments = [
      {
        _id: 'legacy-admin',
        auditId: 'audit-1',
        adminUserId: 'admin-1',
        action: 'MANUAL_REJECT',
        targetRequestId: 'request-1',
        metadata: { requestId: 'request-1', rawBody: 'drop-me' },
        reason: 'Không đủ chứng từ'
      },
      {
        _id: 'legacy-webhook',
        auditId: 'webhook-1',
        adminUserId: 'system',
        action: 'WEBHOOK_RECEIVED',
        targetRequestId: 'request-2',
        sourceIp: '10.0.0.8',
        requestBody: { orderCode: 'order-2' },
        signature: 'signature-2',
        timestamp: new Date('2026-08-12T00:00:00.000Z'),
        rawSecret: 'must-not-copy'
      }
    ];
    const drySource = collection(sourceDocuments);
    const dryWebhook = collection([]);
    const dryReport = await migrateAdminAuditLogSchema({ dryRun: true, sourceCollection: drySource, webhookCollection: dryWebhook });
    expect(dryReport).toMatchObject({ scanned: 2, webhookCandidates: 1, webhookCopied: 0, canonicalBackfilled: 1 });
    expect(drySource.updateOne).not.toHaveBeenCalled();
    expect(dryWebhook.insertOne).not.toHaveBeenCalled();
    expect(drySource.find).toHaveBeenCalledWith({}, expect.objectContaining({
      projection: expect.objectContaining({ actionId: 1, requestBody: 1, timestamp: 1 })
    }));

    const applySource = collection(sourceDocuments);
    const applyWebhook = collection([]);
    const applyReport = await migrateAdminAuditLogSchema({ dryRun: false, sourceCollection: applySource, webhookCollection: applyWebhook });
    expect(applyReport).toMatchObject({ webhookCopied: 1, canonicalBackfilled: 1 });
    expect(applySource.updateOne).toHaveBeenCalledWith(
      { _id: 'legacy-admin' },
      { $set: expect.objectContaining({ actionId: 'audit-1', actorType: 'ADMIN', targetType: 'DISBURSEMENT_REQUEST' }) }
    );
    expect(applyWebhook.insertOne).toHaveBeenCalledWith(expect.objectContaining({
      auditId: 'webhook-1',
      action: 'WEBHOOK_PROCESSED',
      sourceCollection: 'admin_audit_logs_legacy'
    }));
    expect(applyWebhook.insertOne.mock.calls[0]?.[0]).not.toHaveProperty('rawSecret');
  });

  it('đọc source bằng cursor theo batch thay vì gom toàn bộ collection vào RAM', async () => {
    const source = streamingCollection([
      {
        _id: 'legacy-admin',
        auditId: 'audit-stream-1',
        adminUserId: 'admin-1',
        action: 'MANUAL_REJECT',
        targetRequestId: 'request-1'
      }
    ]);
    const webhook = collection([]);

    const report = await migrateAdminAuditLogSchema({
      dryRun: true,
      sourceCollection: source,
      webhookCollection: webhook
    });

    expect(report.scanned).toBe(1);
    expect(source.cursor.sort).toHaveBeenCalledWith({ _id: 1 });
    expect(source.cursor.batchSize).toHaveBeenCalledWith(500);
    expect(source.cursor.toArray).not.toHaveBeenCalled();
  });
});
