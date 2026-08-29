import mongoose from 'mongoose';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ warn: vi.fn() }));

vi.mock('../../config/logger', () => ({ getLogger: () => ({ warn: mocks.warn }) }));

import { verifyRequiredCommitteeGovernanceIndexes } from '../../config/requiredIndexes';

const REQUIRED_INDEXES: Record<string, Array<Record<string, unknown>>> = {
  technical_signer_execution_locks: [{ name: 'lockName_1', key: { lockName: 1 }, unique: true }],
  disbursement_committee_votes: [
    { name: 'requestId_1', key: { requestId: 1 }, unique: true },
    { name: 'committeeVoteId_1', key: { committeeVoteId: 1 }, unique: true }
  ],
  committee_vote_signing_requests: [
    { name: 'signingRequestId_1', key: { signingRequestId: 1 }, unique: true },
    { name: 'deadline_1', key: { deadline: 1 }, expireAfterSeconds: 0 }
  ]
};

describe('verifyRequiredCommitteeGovernanceIndexes', () => {
  const originalNodeEnvironment = process.env.NODE_ENV;

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    if (originalNodeEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnvironment;
  });

  it('dừng production và liệt kê index thiếu để không khởi động worker khi mất unique constraint', async () => {
    process.env.NODE_ENV = 'production';
    vi.spyOn(mongoose.connection, 'collection').mockReturnValue({ indexes: vi.fn().mockResolvedValue([]) } as never);

    await expect(verifyRequiredCommitteeGovernanceIndexes()).rejects.toThrow(
      'technical_signer_execution_locks.lockName_1'
    );
    await expect(verifyRequiredCommitteeGovernanceIndexes()).rejects.toThrow(
      'disbursement_committee_votes.requestId_1'
    );
    await expect(verifyRequiredCommitteeGovernanceIndexes()).rejects.toThrow(
      'committee_vote_signing_requests.deadline_1'
    );
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it('chỉ cảnh báo ngoài production để môi trường local vẫn cho Mongoose autoIndex hoàn tất', async () => {
    process.env.NODE_ENV = 'test';
    vi.spyOn(mongoose.connection, 'collection').mockReturnValue({ indexes: vi.fn().mockResolvedValue([]) } as never);

    await expect(verifyRequiredCommitteeGovernanceIndexes()).resolves.toBeUndefined();
    expect(mocks.warn).toHaveBeenCalledWith(expect.stringContaining('committee_vote_signing_requests.deadline_1'));
  });

  it('không cảnh báo khi mọi index an toàn đã tồn tại', async () => {
    process.env.NODE_ENV = 'production';
    vi.spyOn(mongoose.connection, 'collection').mockImplementation(collectionName => ({
      indexes: vi.fn().mockResolvedValue(REQUIRED_INDEXES[collectionName] || [])
    }) as never);

    await expect(verifyRequiredCommitteeGovernanceIndexes()).resolves.toBeUndefined();
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it('lan truyen loi MongoDB de production khong bo qua gate startup', async () => {
    process.env.NODE_ENV = 'production';
    const databaseFailure = new Error('MongoDB unavailable');
    vi.spyOn(mongoose.connection, 'collection').mockReturnValue({
      indexes: vi.fn().mockRejectedValue(databaseFailure)
    } as never);

    await expect(verifyRequiredCommitteeGovernanceIndexes()).rejects.toBe(databaseFailure);
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it('chan production khi unique index ton tai dung ten nhung sai option', async () => {
    process.env.NODE_ENV = 'production';
    vi.spyOn(mongoose.connection, 'collection').mockImplementation(collectionName => ({
      indexes: vi.fn().mockResolvedValue(collectionName === 'technical_signer_execution_locks'
        ? [{ name: 'lockName_1', key: { lockName: 1 }, unique: false }]
        : REQUIRED_INDEXES[collectionName] || [])
    }) as never);

    await expect(verifyRequiredCommitteeGovernanceIndexes()).rejects.toThrow(
      'technical_signer_execution_locks.lockName_1'
    );
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it('canh bao ngoai production khi TTL index ton tai dung ten nhung sai option', async () => {
    process.env.NODE_ENV = 'test';
    vi.spyOn(mongoose.connection, 'collection').mockImplementation(collectionName => ({
      indexes: vi.fn().mockResolvedValue(collectionName === 'committee_vote_signing_requests'
        ? [
          { name: 'signingRequestId_1', key: { signingRequestId: 1 }, unique: true },
          { name: 'deadline_1', key: { deadline: 1 }, expireAfterSeconds: 60 }
        ]
        : REQUIRED_INDEXES[collectionName] || [])
    }) as never);

    await expect(verifyRequiredCommitteeGovernanceIndexes()).resolves.toBeUndefined();
    expect(mocks.warn).toHaveBeenCalledWith(expect.stringContaining('committee_vote_signing_requests.deadline_1'));
  });

  it('coi NamespaceNotFound là index thiếu để production trả lỗi migration có hướng dẫn', async () => {
    process.env.NODE_ENV = 'production';
    const namespaceNotFound = Object.assign(new Error('NamespaceNotFound'), { code: 26 });
    vi.spyOn(mongoose.connection, 'collection').mockReturnValue({
      indexes: vi.fn().mockRejectedValue(namespaceNotFound)
    } as never);

    await expect(verifyRequiredCommitteeGovernanceIndexes()).rejects.toThrow(
      'Chạy node scripts/migrateCommitteeGovernanceIndexes.js'
    );
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it('cô lập NamespaceNotFound ở collection thiếu và chỉ cảnh báo ngoài production', async () => {
    process.env.NODE_ENV = 'test';
    const namespaceNotFound = Object.assign(new Error('NamespaceNotFound'), { code: 26 });
    vi.spyOn(mongoose.connection, 'collection').mockImplementation(collectionName => ({
      indexes: vi.fn().mockImplementation(async () => {
        if (collectionName === 'technical_signer_execution_locks') throw namespaceNotFound;
        return REQUIRED_INDEXES[collectionName] || [];
      })
    }) as never);

    await expect(verifyRequiredCommitteeGovernanceIndexes()).resolves.toBeUndefined();
    expect(mocks.warn).toHaveBeenCalledTimes(1);
    expect(mocks.warn).toHaveBeenCalledWith(expect.stringContaining('technical_signer_execution_locks.lockName_1'));
  });

  it.each([
    ['code MongoDB khác 26', Object.assign(new Error('OperationNotSupported'), { code: 25 })],
    ['code MongoDB dạng chuỗi', Object.assign(new Error('NamespaceNotFound'), { code: '26' })]
  ])('lan truyền %s thay vì che giấu sự cố hạ tầng', async (_description, databaseFailure) => {
    process.env.NODE_ENV = 'test';
    vi.spyOn(mongoose.connection, 'collection').mockReturnValue({
      indexes: vi.fn().mockRejectedValue(databaseFailure)
    } as never);

    await expect(verifyRequiredCommitteeGovernanceIndexes()).rejects.toBe(databaseFailure);
    expect(mocks.warn).not.toHaveBeenCalled();
  });
});
