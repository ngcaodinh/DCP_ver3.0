import mongoose from 'mongoose';
import { afterEach, describe, expect, it, vi } from 'vitest';

type PendingPublicationIndexMigration = {
  INDEX_KEY: Record<string, number>;
  INDEX_NAME: string;
  ensureProjectPendingPublicationIndex: () => Promise<{ collection: string; index: string; key: Record<string, number> }>;
};

const migration = require('../../../scripts/migrateProjectPendingPublicationIndex.js') as PendingPublicationIndexMigration;

describe('migrateProjectPendingPublicationIndex', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('tạo idempotent index đúng key dùng bởi cursor pending-publication', async () => {
    const collection = {
      createIndex: vi.fn().mockResolvedValue(migration.INDEX_NAME),
      indexes: vi.fn().mockResolvedValue([{ name: migration.INDEX_NAME, key: migration.INDEX_KEY }])
    };
    vi.spyOn(mongoose.connection, 'collection').mockReturnValue(collection as never);

    await expect(migration.ensureProjectPendingPublicationIndex()).resolves.toEqual({
      collection: 'projects', index: migration.INDEX_NAME, key: migration.INDEX_KEY
    });
    expect(collection.createIndex).toHaveBeenCalledWith({ status: 1, activationEligibleAt: 1, projectId: 1 });
  });

  it('dừng rollout khi Mongo không trả index có key chính xác', async () => {
    vi.spyOn(mongoose.connection, 'collection').mockReturnValue({
      createIndex: vi.fn().mockResolvedValue(migration.INDEX_NAME),
      indexes: vi.fn().mockResolvedValue([{ name: migration.INDEX_NAME, key: { status: 1, projectId: 1 } }])
    } as never);

    await expect(migration.ensureProjectPendingPublicationIndex()).rejects.toThrow(migration.INDEX_NAME);
  });
});
