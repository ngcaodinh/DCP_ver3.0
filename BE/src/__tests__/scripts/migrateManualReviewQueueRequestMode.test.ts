import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type MigrationModule = {
  getRequiredEnvironmentVariable: (variableName: string) => string;
  getSafeMigrationErrorName: (error: unknown) => string;
  migrateRequestMode: (batchSize?: number, collections?: { queueCollection: unknown; disbursementCollection: unknown }) => Promise<number>;
};

let migration: MigrationModule;

/** Tạo cursor Mongo tối thiểu để kiểm tra truy vấn batch mà không cần database thật. */
function createCursor<T>(items: T[]) {
  const cursor = {
    sort: vi.fn(),
    limit: vi.fn(),
    toArray: vi.fn().mockResolvedValue(items)
  };
  cursor.sort.mockReturnValue(cursor);
  cursor.limit.mockReturnValue(cursor);
  return cursor;
}

describe('migrateManualReviewQueueRequestMode', () => {
  beforeAll(async () => {
    // @ts-expect-error Script vận hành CommonJS chưa có declaration TypeScript riêng.
    migration = await import('../../../scripts/migrateManualReviewQueueRequestMode.js') as unknown as MigrationModule;
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('cập nhật đúng mode hợp lệ theo batch, bỏ qua disbursement thiếu/sai mode và không sửa field khác', async () => {
    const queueItems = [
      { _id: 1, queueId: 'MRQ-001', disbursementRequestId: 'DS-001' },
      { _id: 2, queueId: 'MRQ-002', disbursementRequestId: 'DS-002' },
      { _id: 3, queueId: 'MRQ-003', disbursementRequestId: 'DS-003' }
    ];
    const queueCollection = {
      find: vi.fn()
        .mockReturnValueOnce(createCursor(queueItems))
        .mockReturnValueOnce(createCursor([])),
      bulkWrite: vi.fn().mockResolvedValue({ modifiedCount: 1 })
    };
    const disbursementCollection = {
      find: vi.fn().mockReturnValue(createCursor([
        { requestId: 'DS-001', requestMode: 'EMERGENCY' },
        { requestId: 'DS-002', requestMode: 'INVALID' },
        { requestId: 'DS-999', requestMode: 'NORMAL' }
      ]))
    };
    const updatedCount = await migration.migrateRequestMode(500, { queueCollection, disbursementCollection });

    expect(updatedCount).toBe(1);
    expect(queueCollection.bulkWrite).toHaveBeenCalledWith([
      {
        updateOne: {
          filter: { queueId: 'MRQ-001', status: 'PENDING', requestMode: { $exists: false } },
          update: { $set: { requestMode: 'EMERGENCY' } }
        }
      }
    ], { ordered: false });
    expect(queueCollection.find).toHaveBeenNthCalledWith(2, {
      status: 'PENDING',
      requestMode: { $exists: false },
      _id: { $gt: 3 }
    }, expect.anything());
  });

  it('chạy lần hai không tạo update mới khi queue đã được backfill', async () => {
    const queueCollection = {
      find: vi.fn().mockReturnValue(createCursor([])),
      bulkWrite: vi.fn()
    };
    const disbursementCollection = { find: vi.fn() };
    await expect(migration.migrateRequestMode(undefined, { queueCollection, disbursementCollection })).resolves.toBe(0);
    expect(queueCollection.bulkWrite).not.toHaveBeenCalled();
  });

  it('fail fast khi thiếu MONGODB_URI để tránh chạy nhầm database', () => {
    const previousValue = process.env.MONGODB_URI;
    delete process.env.MONGODB_URI;
    expect(() => migration.getRequiredEnvironmentVariable('MONGODB_URI')).toThrow('Thiếu biến môi trường: MONGODB_URI');
    if (previousValue === undefined) delete process.env.MONGODB_URI;
    else process.env.MONGODB_URI = previousValue;
  });

  it('không ghi error message có thể chứa credential MongoDB', () => {
    const error = new Error('mongodb://user:password@example.test/app');
    expect(migration.getSafeMigrationErrorName(error)).toBe('Error');
    expect(migration.getSafeMigrationErrorName('raw-secret')).toBe('UNKNOWN_ERROR');
  });
});
