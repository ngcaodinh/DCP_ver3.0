import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

type MigrationSpecification = {
  collection: string;
  key: Record<string, number>;
  options: Record<string, unknown>;
};
type CommitteeGovernanceIndexMigration = {
  INDEXES: MigrationSpecification[];
  ensureIndex: (specification: MigrationSpecification) => Promise<{ collection: string; index: string; key: Record<string, number> }>;
  getDefaultIndexName: (key: Record<string, number>) => string;
};

const migration = require('../../../scripts/migrateCommitteeGovernanceIndexes.js') as CommitteeGovernanceIndexMigration;

let mongoServer: MongoMemoryServer;

describe('migrateCommitteeGovernanceIndexes', () => {
  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  it('chỉ dùng tên index mặc định để không xung đột với Mongoose autoIndex', () => {
    expect(migration.INDEXES).toHaveLength(9);
    expect(migration.INDEXES.every(specification => !('name' in specification.options))).toBe(true);
    expect(migration.INDEXES.slice(0, 4)).toMatchObject([
      { collection: 'technical_signer_execution_locks', key: { lockName: 1 }, options: { unique: true } },
      { collection: 'disbursement_committee_votes', key: { requestId: 1 }, options: { unique: true } },
      { collection: 'disbursement_committee_votes', key: { committeeVoteId: 1 }, options: { unique: true } },
      { collection: 'committee_vote_signing_requests', key: { signingRequestId: 1 }, options: { unique: true } }
    ]);
    expect(migration.getDefaultIndexName({ chainId: 1, blockNumber: -1, logIndex: -1 })).toBe('chainId_1_blockNumber_-1_logIndex_-1');
  });

  it('tạo idempotent và xác minh index theo tên mặc định MongoDB sinh ra', async () => {
    const collection = {
      createIndex: vi.fn().mockResolvedValue('requestId_1'),
      indexes: vi.fn().mockResolvedValue([{ name: 'requestId_1', key: { requestId: 1 }, unique: true }])
    };
    vi.spyOn(mongoose.connection, 'collection').mockReturnValue(collection as never);

    await expect(migration.ensureIndex({
      collection: 'disbursement_committee_votes', key: { requestId: 1 }, options: { unique: true }
    })).resolves.toEqual({ collection: 'disbursement_committee_votes', index: 'requestId_1', key: { requestId: 1 } });

    expect(collection.createIndex).toHaveBeenCalledWith({ requestId: 1 }, { unique: true });
  });

  it('dừng migration khi TTL thực tế không khớp cấu hình', async () => {
    const collection = {
      createIndex: vi.fn().mockResolvedValue('deadline_1'),
      indexes: vi.fn().mockResolvedValue([{ name: 'deadline_1', key: { deadline: 1 }, expireAfterSeconds: 60 }])
    };
    vi.spyOn(mongoose.connection, 'collection').mockReturnValue(collection as never);

    await expect(migration.ensureIndex({
      collection: 'committee_vote_signing_requests', key: { deadline: 1 }, options: { expireAfterSeconds: 0 }
    })).rejects.toThrow('expireAfterSeconds không đúng');
  });

  it('chạy lặp lại an toàn khi app đã tạo mọi index với tên mặc định', async () => {
    for (const specification of migration.INDEXES) {
      await mongoose.connection.collection(specification.collection).createIndex(specification.key, specification.options);
    }

    const firstRun = await Promise.all(migration.INDEXES.map(specification => migration.ensureIndex(specification)));
    const secondRun = await Promise.all(migration.INDEXES.map(specification => migration.ensureIndex(specification)));

    expect(firstRun).toHaveLength(9);
    expect(secondRun.map(result => result.index)).toEqual(
      migration.INDEXES.map(specification => migration.getDefaultIndexName(specification.key))
    );
  });

  it('dung migration neu index mac dinh khong xuat hien sau create', async () => {
    const collection = {
      createIndex: vi.fn().mockResolvedValue('requestId_1'),
      indexes: vi.fn().mockResolvedValue([])
    };
    vi.spyOn(mongoose.connection, 'collection').mockReturnValue(collection as never);

    await expect(migration.ensureIndex({
      collection: 'disbursement_committee_votes', key: { requestId: 1 }, options: { unique: true }
    })).rejects.toThrow(/requestId_1/);
  });

  it('dung migration neu index mac dinh co key pattern sai', async () => {
    const collection = {
      createIndex: vi.fn().mockResolvedValue('requestId_1'),
      indexes: vi.fn().mockResolvedValue([{ name: 'requestId_1', key: { committeeVoteId: 1 }, unique: true }])
    };
    vi.spyOn(mongoose.connection, 'collection').mockReturnValue(collection as never);

    await expect(migration.ensureIndex({
      collection: 'disbursement_committee_votes', key: { requestId: 1 }, options: { unique: true }
    })).rejects.toThrow(/requestId_1/);
  });

  it('dung migration neu unique index ton tai dung key nhung sai option', async () => {
    const collection = {
      createIndex: vi.fn().mockResolvedValue('lockName_1'),
      indexes: vi.fn().mockResolvedValue([{ name: 'lockName_1', key: { lockName: 1 }, unique: false }])
    };
    vi.spyOn(mongoose.connection, 'collection').mockReturnValue(collection as never);

    await expect(migration.ensureIndex({
      collection: 'technical_signer_execution_locks', key: { lockName: 1 }, options: { unique: true }
    })).rejects.toThrow(/lockName_1/);
  });
});
