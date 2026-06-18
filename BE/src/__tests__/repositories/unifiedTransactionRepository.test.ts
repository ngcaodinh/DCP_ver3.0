/**
 * Unit tests cho unifiedTransactionRepository — cursor encoding, pagination, va CRUD operations.
 *
 * Coverage:
 * 1. encodeCursor / decodeCursor round-trip — cursor encode/decode chinh xac
 * 2. encodeCursor / decodeCursor voi null separator \\x00 — separator khong bi split sai
 * 3. findUnifiedTimeline — empty results tra ve dung
 * 4. findUnifiedTimeline — co results tra ve dung structure
 * 5. findUnifiedTimeline — pagination voi cursor hoat dong dung (limit + skip)
 * 6. findUnifiedTimeline — filter theo walletAddress (lowercase)
 * 7. findUnifiedTimeline — filter theo projectId
 * 8. findUnifiedTimeline — filter theo startDate / endDate (date range)
 * 9. aggregateSummaryByProjectId — tra ve dung shape { totalRaisedVnd, totalTransactions }
 * 10. aggregateSummaryByProjectId — khong co transaction thi tra ve 0
 * 11. insertUnifiedTransaction — insert moi thanh cong
 * 12. insertUnifiedTransaction — insert duplicate voi same utxId thi nem loi duplicate key
 * 13. buildPayosCorrelationId — tao dung format
 * 14. buildBlockchainCorrelationId — tao dung format
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  encodeCursor,
  decodeCursor,
  buildPayosCorrelationId,
  buildBlockchainCorrelationId,
  findUnifiedTimeline,
  insertUnifiedTransaction,
  aggregateSummaryByProjectId
} from '../../repositories/unifiedTransactionRepository';
import { UnifiedTransactionModel } from '../../models/unifiedTransactionModel';

vi.mock('../../models/unifiedTransactionModel', () => ({
  UnifiedTransactionModel: {
    find: vi.fn(),
    findOne: vi.fn(),
    create: vi.fn(),
    countDocuments: vi.fn(),
    findOneAndUpdate: vi.fn(),
    updateMany: vi.fn(),
    aggregate: vi.fn()
  }
}));

function createMockTransaction(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  const now = new Date();
  return {
    utxId: 'test-utx-id-123',
    correlationId: 'deposit:12345678',
    projectId: 'project-001',
    walletAddress: '0x742d35cc6634c0532925a3b844bc9e7595f5c21a',
    eventType: 'DONATION',
    eventTimestamp: now,
    amountVnd: 50000,
    source: 'PAYOS',
    chainStatus: 'PENDING',
    chainTxHash: null,
    chainBlockNumber: null,
    payosStatus: 'PAYMENT_CONFIRMED',
    payosOrderCode: '12345678',
    payosTransactionId: null,
    payosRecordId: null,
    blockchainRecordId: null,
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

describe('unifiedTransactionRepository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ===== 1. encodeCursor / decodeCursor round-trip =====
  describe('encodeCursor / decodeCursor', () => {
    it('encodeCursor / decodeCursor round-trip chinh xac', () => {
      const timestamp = new Date('2024-06-15T10:30:00.000Z');
      const documentId = 'doc-abc-123';

      const encoded = encodeCursor(timestamp, documentId);
      const decoded = decodeCursor(encoded);

      expect(decoded).not.toBeNull();
      expect(decoded!.timestamp.toISOString()).toBe(timestamp.toISOString());
      expect(decoded!.documentId).toBe(documentId);
    });

    // ===== 2. encodeCursor / decodeCursor voi null separator \\x00 =====
    it('decodeCursor voi null separator \\x00 khong bi split sai', () => {
      // Encode voi timestamp chua ky tu dac biet
      const timestamp = new Date('2024-01-01T00:00:00.000Z');
      const documentId = 'doc-with-special-chars_id.123';

      const encoded = encodeCursor(timestamp, documentId);
      const decoded = decodeCursor(encoded);

      expect(decoded).not.toBeNull();
      expect(decoded!.documentId).toBe(documentId);
      expect(decoded!.documentId).not.toContain('\x00');
    });

    it('decodeCursor tra ve null khi cursor khong hop le', () => {
      const result = decodeCursor('invalid-base64-cursor!!!');
      expect(result).toBeNull();
    });

    it('decodeCursor tra ve null khi cursor khong co separator', () => {
      // Encode binh thuong roi thay doi de mat separator
      const encoded = Buffer.from('2024-06-15T10:30:00.000Z_noseparator').toString('base64');
      const result = decodeCursor(encoded);
      expect(result).toBeNull();
    });

    it('decodeCursor tra ve null khi timestamp khong hop le', () => {
      const encoded = Buffer.from('invalid-timestamp\x00doc123').toString('base64');
      const result = decodeCursor(encoded);
      expect(result).toBeNull();
    });

    it('decodeCursor tra ve null khi documentId rong', () => {
      const encoded = Buffer.from('2024-06-15T10:30:00.000Z\x00').toString('base64');
      const result = decodeCursor(encoded);
      expect(result).toBeNull();
    });
  });

  // ===== buildPayosCorrelationId / buildBlockchainCorrelationId =====
  describe('correlation ID builders', () => {
    it('buildPayosCorrelationId tra ve dung format deposit:orderCode', () => {
      const result = buildPayosCorrelationId('12345678');
      expect(result).toBe('deposit:12345678');
    });

    it('buildBlockchainCorrelationId tra ve dung format donation:txHash', () => {
      const txHash = '0xABCDEF123456';
      const result = buildBlockchainCorrelationId(txHash);
      expect(result).toBe('donation:0xabcdef123456'); // lowercase
    });

    it('buildBlockchainCorrelationId luon tra ve lowercase', () => {
      const txHash = '0xABCDEF123456';
      const result = buildBlockchainCorrelationId(txHash);
      expect(result).toBe('donation:0xabcdef123456');
    });
  });

  // ===== 3. findUnifiedTimeline — empty results =====
  describe('findUnifiedTimeline', () => {
    it('empty results tra ve mang rong', async () => {
      const mockFind = vi.mocked(UnifiedTransactionModel.find).mockReturnValue({
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        lean: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue([])
      } as unknown as ReturnType<typeof UnifiedTransactionModel.find>);

      const result = await findUnifiedTimeline({ projectId: 'nonexistent' }, 10);

      expect(result.items).toEqual([]);
      expect(result.nextCursor).toBeNull();
      expect(result.totalCount).toBe(0);
    });

    // ===== 4. findUnifiedTimeline — co results tra ve dung structure =====
    it('co results tra ve dung structure', async () => {
      const mockItems = [
        createMockTransaction({ utxId: 'doc1' }),
        createMockTransaction({ utxId: 'doc2' })
      ];

      vi.mocked(UnifiedTransactionModel.find).mockReturnValue({
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        lean: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue(mockItems)
      } as unknown as ReturnType<typeof UnifiedTransactionModel.find>);

      const result = await findUnifiedTimeline({}, 10);

      expect(result.items).toHaveLength(2);
      expect(result.totalCount).toBe(2);
    });

    // ===== 5. findUnifiedTimeline — pagination voi cursor =====
    it('pagination voi cursor hoat dong dung (limit + skip)', async () => {
      const timestamp = new Date('2024-06-15T10:00:00.000Z');
      const cursorDocId = 'cursor-doc-id';
      const cursor = encodeCursor(timestamp, cursorDocId);

      const mockItems = [
        createMockTransaction({ utxId: 'after-cursor-1' }),
        createMockTransaction({ utxId: 'after-cursor-2' })
      ];

      let capturedLimit = 0;
      vi.mocked(UnifiedTransactionModel.find).mockReturnValue({
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockImplementation((n: number) => {
          capturedLimit = n;
          return {
            lean: vi.fn().mockReturnThis(),
            exec: vi.fn().mockResolvedValue(mockItems)
          };
        }),
        lean: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue(mockItems)
      } as unknown as ReturnType<typeof UnifiedTransactionModel.find>);

      const result = await findUnifiedTimeline({}, 2, cursor);

      // Verify that find was called
      expect(UnifiedTransactionModel.find).toHaveBeenCalled();
      expect(result.items).toHaveLength(2);

      // Verify decodeCursor was called with correct input
      const findCallArgs = vi.mocked(UnifiedTransactionModel.find).mock.calls[0];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const filterQuery = findCallArgs[0] as any as Record<string, unknown>;

      // Verify $or filter with $gt timestamp was constructed
      expect(filterQuery.$or).toBeDefined();
      expect(Array.isArray(filterQuery.$or)).toBe(true);
      const orFilter = filterQuery.$or as Array<Record<string, unknown>>;
      expect(orFilter.length).toBe(2);
      // First condition: eventTimestamp > cursor.timestamp
      expect(orFilter[0]).toHaveProperty('eventTimestamp');
      expect((orFilter[0].eventTimestamp as Record<string, Date>).$gt).toEqual(timestamp);
      // Second condition: eventTimestamp === cursor.timestamp AND utxId > cursor.docId
      expect(orFilter[1]).toHaveProperty('eventTimestamp');
      expect((orFilter[1].eventTimestamp as Record<string, Date>)).toEqual(timestamp);
      expect(orFilter[1]).toHaveProperty('utxId');

      // Verify limit was called with pageSize + 1 (for hasMore detection)
      expect(capturedLimit).toBe(3); // 2 + 1 for hasMore
    });

    // ===== 6. findUnifiedTimeline — filter theo walletAddress (lowercase) =====
    it('filter theo walletAddress (lowercase)', async () => {
      const walletAddress = '0x742d35cc6634c0532925a3b844bc9e7595f5c21a';

      vi.mocked(UnifiedTransactionModel.find).mockReturnValue({
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        lean: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue([createMockTransaction()])
      } as unknown as ReturnType<typeof UnifiedTransactionModel.find>);

      await findUnifiedTimeline({ walletAddress }, 10);

      const findCall = vi.mocked(UnifiedTransactionModel.find).mock.calls[0];
      const filterQuery = findCall[0] as unknown as Record<string, unknown>;
      expect(filterQuery.walletAddress).toBe(walletAddress.toLowerCase());
    });

    // ===== 7. findUnifiedTimeline — filter theo projectId =====
    it('filter theo projectId', async () => {
      const projectId = 'project-001';

      vi.mocked(UnifiedTransactionModel.find).mockReturnValue({
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        lean: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue([createMockTransaction()])
      } as unknown as ReturnType<typeof UnifiedTransactionModel.find>);

      await findUnifiedTimeline({ projectId }, 10);

      const findCall = vi.mocked(UnifiedTransactionModel.find).mock.calls[0];
      const filterQuery = findCall[0] as unknown as Record<string, unknown>;
      expect(filterQuery.projectId).toBe(projectId);
    });

    // ===== 8. findUnifiedTimeline — filter theo startDate / endDate (date range) =====
    it('filter theo startDate / endDate (date range)', async () => {
      const startDate = new Date('2024-01-01');
      const endDate = new Date('2024-12-31');

      vi.mocked(UnifiedTransactionModel.find).mockReturnValue({
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        lean: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue([createMockTransaction()])
      } as unknown as ReturnType<typeof UnifiedTransactionModel.find>);

      await findUnifiedTimeline({ startDate, endDate }, 10);

      const findCall = vi.mocked(UnifiedTransactionModel.find).mock.calls[0];
      const filterQuery = findCall[0] as unknown as Record<string, Record<string, Date>>;
      expect(filterQuery.eventTimestamp.$gte).toEqual(startDate);
      expect(filterQuery.eventTimestamp.$lte).toEqual(endDate);
    });

    it('findUnifiedTimeline normalize pageSize within bounds 1-50', async () => {
      // Test voi pageSize > 50
      vi.mocked(UnifiedTransactionModel.find).mockReturnValue({
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockImplementation((n: number) => {
          expect(n).toBeLessThanOrEqual(51); // 50 + 1 for hasMore check
          return {
            lean: vi.fn().mockReturnThis(),
            exec: vi.fn().mockResolvedValue([])
          };
        })
      } as unknown as ReturnType<typeof UnifiedTransactionModel.find>);

      await findUnifiedTimeline({}, 100);
    });
  });

  // ===== 9. aggregateSummaryByProjectId — tra ve dung shape =====
  describe('aggregateSummaryByProjectId', () => {
    it('tra ve dung shape { totalRaisedVnd, totalTransactions }', async () => {
      vi.mocked(UnifiedTransactionModel.aggregate).mockReturnValue({
        hint: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue([{
          totalRaisedVnd: 1000000,
          totalTransactions: 50
        }])
      } as unknown as ReturnType<typeof UnifiedTransactionModel.aggregate>);

      const result = await aggregateSummaryByProjectId('project-001');

      expect(result).toEqual({
        totalRaisedVnd: 1000000,
        totalTransactions: 50
      });
    });

    // ===== 10. aggregateSummaryByProjectId — khong co transaction thi tra ve 0 =====
    it('khong co transaction thi tra ve 0', async () => {
      vi.mocked(UnifiedTransactionModel.aggregate).mockReturnValue({
        hint: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue([])
      } as unknown as ReturnType<typeof UnifiedTransactionModel.aggregate>);

      const result = await aggregateSummaryByProjectId('nonexistent-project');

      expect(result).toEqual({
        totalRaisedVnd: 0,
        totalTransactions: 0
      });
    });

    // ===== 9. aggregateSummaryByProjectId — tra ve 0 khi undefined =====
  it('tra ve 0 khi aggregate tra ve gia tri undefined', async () => {
    vi.mocked(UnifiedTransactionModel.aggregate).mockReturnValue({
      hint: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([{
        totalRaisedVnd: undefined,
        totalTransactions: undefined
      }])
    } as unknown as ReturnType<typeof UnifiedTransactionModel.aggregate>);

    const result = await aggregateSummaryByProjectId('project-001');

    // Repository xu ly undefined bang cach tra ve 0
    expect(result.totalRaisedVnd).toBe(0);
    expect(result.totalTransactions).toBe(0);
  });
  });

  // ===== 11. insertUnifiedTransaction — insert moi thanh cong =====
  describe('insertUnifiedTransaction', () => {
    it('insert moi thanh cong', async () => {
      const mockRecord = {
        utxId: 'new-utx-id',
        correlationId: 'donation:0xtxhash123',
        projectId: 'project-001',
        walletAddress: '0x742d35cc6634c0532925a3b844bc9e7595f5c21a',
        eventType: 'DONATION' as const,
        eventTimestamp: new Date(),
        amountVnd: 50000,
        source: 'BLOCKCHAIN' as const,
        chainStatus: 'CONFIRMED' as const,
        chainTxHash: '0xtxhash123',
        chainBlockNumber: 12345678,
        payosStatus: null,
        payosOrderCode: null,
        payosTransactionId: null,
        payosRecordId: null,
        blockchainRecordId: '0xtxhash123'
      };

      vi.mocked(UnifiedTransactionModel.findOne).mockReturnValue({
        lean: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue(null)
      } as unknown as ReturnType<typeof UnifiedTransactionModel.findOne>);

      const mockCreated = {
        ...mockRecord,
        toObject: vi.fn(() => mockRecord)
      };
      vi.mocked(UnifiedTransactionModel.create).mockResolvedValue(mockCreated as never);

      const result = await insertUnifiedTransaction(mockRecord);

      expect(result).toEqual(mockRecord);
      expect(UnifiedTransactionModel.create).toHaveBeenCalledWith(mockRecord);
    });

    // ===== 12. insertUnifiedTransaction — insert duplicate thi tra ve existing =====
    it('insert duplicate thi tra ve existing record', async () => {
      const existingRecord = createMockTransaction({
        utxId: 'existing-utx-id',
        correlationId: 'deposit:12345678'
      });

      vi.mocked(UnifiedTransactionModel.findOne).mockReturnValue({
        lean: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue(existingRecord)
      } as unknown as ReturnType<typeof UnifiedTransactionModel.findOne>);

      const newRecord = {
        utxId: 'new-utx-id',
        correlationId: 'deposit:12345678', // Same correlationId
        projectId: 'project-001',
        walletAddress: '0x742d35cc6634c0532925a3b844bc9e7595f5c21a',
        eventType: 'DONATION' as const,
        eventTimestamp: new Date(),
        amountVnd: 50000,
        source: 'BLOCKCHAIN' as const,
        chainStatus: 'CONFIRMED' as const,
        chainTxHash: '0xnewtx',
        chainBlockNumber: 12345678,
        payosStatus: null,
        payosOrderCode: null,
        payosTransactionId: null,
        payosRecordId: null,
        blockchainRecordId: '0xnewtx'
      };

      const result = await insertUnifiedTransaction(newRecord);

      expect(result).toEqual(existingRecord);
      expect(UnifiedTransactionModel.create).not.toHaveBeenCalled();
    });
  });
});
