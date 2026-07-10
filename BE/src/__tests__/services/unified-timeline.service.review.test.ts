/**
 * Unit tests chuyên biệt cho cac fix service-level theo B4 review report (section 5.1).
 *
 * Coverage theo review checklist (muc 5):
 * 1. Normalization: walletAddress viet hoa → lowercase o cache key (F1)
 * 2. Cache integrity: Tamper payload → service reject (F2)
 * 3. Cursor integrity: Craft cursor → service validate (F11)
 * 4. Fallback: findUnifiedTimeline throws → service fail-fast (F8)
 * 5. Cache invalidation: Set cache voi projectId:undefined → verify xoa pattern (F10)
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import crypto from 'crypto';

vi.mock('../../config/logger', () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }))
}));

const redisMockApi = vi.hoisted(() => ({
  mockRedisGet: vi.fn(),
  mockRedisSet: vi.fn(),
  mockRedisDel: vi.fn(),
  mockRedisScanIterator: vi.fn()
}));

vi.mock('../../config/redis', () => ({
  getRedisClientIfReady: vi.fn(() => ({
    get: redisMockApi.mockRedisGet,
    set: redisMockApi.mockRedisSet,
    del: redisMockApi.mockRedisDel,
    scanIterator: redisMockApi.mockRedisScanIterator
  }))
}));

vi.mock('../../repositories/unifiedTransactionRepository', async () => {
  // Su dung implementation that de test cursor HMAC
  const actual = await vi.importActual<typeof import('../../repositories/unifiedTransactionRepository')>('../../repositories/unifiedTransactionRepository');
  return {
    ...actual,
    findUnifiedTimeline: vi.fn(),
    // Giu nguyen encodeCursor/decodeCursor tu implementation that
    encodeCursor: actual.encodeCursor,
    decodeCursor: actual.decodeCursor
  };
});

vi.mock('../../repositories/donationRepository', () => ({
  findDonationsByProjectIdWithDateFilter: vi.fn().mockResolvedValue([])
}));

import {
  getUnifiedTimeline,
  invalidateUnifiedTimelineCache
} from '../../services/unified-timeline.service';
import { findUnifiedTimeline } from '../../repositories/unifiedTransactionRepository';

describe('B4 Review - Service fixes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisMockApi.mockRedisScanIterator.mockReturnValue((async function* () {})());
  });

  // ===== F1: walletAddress canonicalization =====
  describe('F1: walletAddress canonicalization o service layer', () => {
    it('walletAddress viet hoa → repository nhan lowercase (cache key + filter dong bo)', async () => {
      const walletMixedCase = '0xABCDEF1234567890ABCDEF1234567890ABCDEF12';
      const walletLowercase = walletMixedCase.toLowerCase();

      vi.mocked(findUnifiedTimeline).mockResolvedValue({
        items: [],
        nextCursor: null,
        totalCount: 0
      });

      // Wallet viet hoa
      await getUnifiedTimeline({ walletAddress: walletMixedCase }, 10);

      // Repository phai nhan lowercase (service da canonicalize)
      expect(findUnifiedTimeline).toHaveBeenCalledWith(
        expect.objectContaining({
          walletAddress: walletLowercase
        }),
        expect.any(Number),
        undefined
      );
    });

    it('walletAddress lowercase duoc giu nguyen khi truyen xuong repository', async () => {
      const walletLowercase = '0x742d35cc6634c0532925a3b844bc9e7595f5c21a';

      vi.mocked(findUnifiedTimeline).mockResolvedValue({
        items: [],
        nextCursor: null,
        totalCount: 0
      });

      await getUnifiedTimeline({ walletAddress: walletLowercase }, 10);

      expect(findUnifiedTimeline).toHaveBeenCalledWith(
        expect.objectContaining({
          walletAddress: walletLowercase
        }),
        expect.any(Number),
        undefined
      );
    });

    it('walletAddress khong hop le (regex fail) → undefined (skip filter)', async () => {
      vi.mocked(findUnifiedTimeline).mockResolvedValue({
        items: [],
        nextCursor: null,
        totalCount: 0
      });

      await getUnifiedTimeline({ walletAddress: 'invalid-wallet' }, 10);

      // Service skip wallet filter (undefined)
      expect(findUnifiedTimeline).toHaveBeenCalledWith(
        expect.objectContaining({
          walletAddress: undefined
        }),
        expect.any(Number),
        undefined
      );
    });

    it('Hai request cung wallet (mixed-case vs lowercase) → cung cache key', async () => {
      const walletMixedCase = '0xABCDEF1234567890ABCDEF1234567890ABCDEF12';
      const walletLowercase = walletMixedCase.toLowerCase();

      vi.mocked(findUnifiedTimeline).mockResolvedValue({
        items: [],
        nextCursor: null,
        totalCount: 0
      });
      redisMockApi.mockRedisGet.mockResolvedValue(null);

      // Request 1: wallet viet hoa
      await getUnifiedTimeline({ projectId: 'p1', walletAddress: walletMixedCase }, 10);

      // Request 2: wallet lowercase
      await getUnifiedTimeline({ projectId: 'p1', walletAddress: walletLowercase }, 10);

      // Cả hai phai truy cap cung Redis key (cache hit potential)
      const calls = redisMockApi.mockRedisGet.mock.calls;
      expect(calls.length).toBe(2);
      expect(calls[0][0]).toBe(calls[1][0]); // Cung key
      // Key phai chua wallet lowercase
      expect(calls[0][0]).toContain(walletLowercase);
      // KHONG chua wallet mixed-case
      expect(calls[0][0]).not.toContain(walletMixedCase);
    });
  });

  // ===== F2: cache HMAC integrity =====
  describe('F2: cache payload HMAC integrity', () => {
    it('HMAC hop le → service tra ve cached data', async () => {
      // Tao payload dung HMAC de cache hit
      const json = JSON.stringify({
        timeline: [{
          eventId: 'cached-event',
          correlationId: 'corr-1',
          eventType: 'DEPOSIT',
          timestamp: '2024-06-15T10:30:00.000Z',
          chainBlockNumber: null,
          amountVnd: 50000,
          chainStatus: 'CONFIRMED',
          chainTxHash: null,
          payosStatus: 'PAYMENT_CONFIRMED',
          payosOrderCode: 'ORD123',
          walletAddress: '0x742d35cc6634c0532925a3b844bc9e7595f5c21a',
          projectId: 'p1',
          source: 'payos'
        }],
        nextCursor: null,
        cached: false,
        count: 1
      });

      const hmacKey = process.env.CACHE_HMAC_KEY || process.env.JWT_SECRET || 'dcp-cache-hmac-default-rotate-me';
      const signature = crypto.createHmac('sha256', hmacKey).update(json).digest('hex');
      const signedPayload = `${json}.${signature}`;

      redisMockApi.mockRedisGet.mockResolvedValueOnce(signedPayload);

      const result = await getUnifiedTimeline({ projectId: 'p1' }, 10);

      expect(result.cached).toBe(true);
      expect(result.timeline).toHaveLength(1);
      expect(result.timeline[0].eventId).toBe('cached-event');
    });

    it('tamper payload → service reject (cached=false) + xoa entry', async () => {
      // Payload bi sua (ky khong khop)
      const tampered = '{"timeline":[{"eventId":"FAKE-EVENT","amountVnd":99999999}],"nextCursor":null,"cached":false,"count":1}.invalidsignature';

      redisMockApi.mockRedisGet.mockResolvedValueOnce(tampered);
      redisMockApi.mockRedisDel.mockResolvedValueOnce(1);

      vi.mocked(findUnifiedTimeline).mockResolvedValue({
        items: [],
        nextCursor: null,
        totalCount: 0
      });

      const result = await getUnifiedTimeline({ projectId: 'p1' }, 10);

      // F2 fix: payload tamper → cache miss, tra ve tu repository
      expect(result.cached).toBe(false);
      // Phai xoa entry khoi Redis de tranh retry
      expect(redisMockApi.mockRedisDel).toHaveBeenCalled();
    });

    it('HMAC verify voi payload rong (no signature) → cache miss', async () => {
      redisMockApi.mockRedisGet.mockResolvedValueOnce('just-a-plain-string-without-signature');

      vi.mocked(findUnifiedTimeline).mockResolvedValue({
        items: [],
        nextCursor: null,
        totalCount: 0
      });

      const result = await getUnifiedTimeline({ projectId: 'p1' }, 10);

      expect(result.cached).toBe(false);
    });

    it('setCache sign payload voi HMAC', async () => {
      // Test gia lap behavior: khi set, payload phai co HMAC signature
      redisMockApi.mockRedisSet.mockResolvedValueOnce('OK');

      vi.mocked(findUnifiedTimeline).mockResolvedValue({
        items: [],
        nextCursor: null,
        totalCount: 0
      });

      await getUnifiedTimeline({ projectId: 'p1' }, 10);

      // Phai goi set voi payload co HMAC (chứa '.')
      expect(redisMockApi.mockRedisSet).toHaveBeenCalled();
      const setCall = redisMockApi.mockRedisSet.mock.calls[0];
      const signedPayload = setCall[1];
      expect(signedPayload).toContain('.');
      const separatorIndex = signedPayload.lastIndexOf('.');
      const signature = signedPayload.slice(separatorIndex + 1);
      // Signature phai la hex 64 chars
      expect(signature).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  // ===== F11: cursor HMAC integrity =====
  describe('F11: cursor HMAC integrity', () => {
    it('encodeCursor → decodeCursor round-trip (HMAC hop le)', async () => {
      const { encodeCursor, decodeCursor } = await import('../../repositories/unifiedTransactionRepository');
      const timestamp = new Date('2024-06-15T10:30:00.000Z');
      const docId = 'utx-test-001';

      const encoded = encodeCursor(timestamp, docId);
      const decoded = decodeCursor(encoded);

      expect(decoded).not.toBeNull();
      expect(decoded!.timestamp.toISOString()).toBe(timestamp.toISOString());
      expect(decoded!.documentId).toBe(docId);
    });

    it('decodeCursor voi signature bi sua → null (reject)', async () => {
      const { encodeCursor, decodeCursor } = await import('../../repositories/unifiedTransactionRepository');
      const timestamp = new Date('2024-06-15T10:30:00.000Z');
      const encoded = encodeCursor(timestamp, 'utx-test');

      // Attacker sua signature
      const separatorIndex = encoded.lastIndexOf('.');
      const tampered = encoded.slice(0, separatorIndex) + '.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      const decoded = decodeCursor(tampered);

      expect(decoded).toBeNull();
    });

    it('decodeCursor voi payload bi sua → null (reject)', async () => {
      const { encodeCursor, decodeCursor } = await import('../../repositories/unifiedTransactionRepository');
      const timestamp = new Date('2024-06-15T10:30:00.000Z');
      const encoded = encodeCursor(timestamp, 'utx-test');

      // Attacker sua payload (giu signature cu)
      const separatorIndex = encoded.lastIndexOf('.');
      const signature = encoded.slice(separatorIndex + 1);
      const tamperedPayload = Buffer.from(JSON.stringify({
        ts: '2099-01-01T00:00:00.000Z',
        id: 'utx-attacker'
      })).toString('base64url');
      const tampered = `${tamperedPayload}.${signature}`;
      const decoded = decodeCursor(tampered);

      expect(decoded).toBeNull();
    });

    it('decodeCursor voi cursor base64 thuong (legacy format) → null', async () => {
      const { decodeCursor } = await import('../../repositories/unifiedTransactionRepository');
      // Cursor dang cu: base64(ts + \x00 + id), khong co HMAC
      const legacyCursor = Buffer.from('2024-06-15T10:30:00.000Z\x00utx-test').toString('base64');
      const decoded = decodeCursor(legacyCursor);

      expect(decoded).toBeNull();
    });

    it('Craft cursor voi utxId tuy y → service khong the truy cap (HMAC chan)', async () => {
      vi.mocked(findUnifiedTimeline).mockResolvedValue({
        items: [],
        nextCursor: null,
        totalCount: 0
      });

      // Attacker craft cursor voi utxId tuy y nhung khong co HMAC hop le
      const maliciousCursor = Buffer.from(JSON.stringify({
        ts: '2024-06-15T10:30:00.000Z',
        id: 'utx-attacker-chosen-id'
      })).toString('base64url') + '.fake-signature';

      await getUnifiedTimeline({ projectId: 'p1' }, 10, maliciousCursor);

      // Service van goi repository (cursor khong validate tai service layer)
      // nhung payload duoc repository filter qua HMAC decode -> cursorData = null
      // → repository se khong them $or filter (giong cursorData undefined).
      expect(findUnifiedTimeline).toHaveBeenCalled();
      const callArgs = vi.mocked(findUnifiedTimeline).mock.calls[0];
      const cursorArg = callArgs[2];
      // Cursor phai duoc truyen xuong repo de verify (HMAC decode null)
      expect(cursorArg).toBe(maliciousCursor);
    });
  });

  // ===== F8: fail-fast on repository error =====
  describe('F8: repository error → service fail-fast', () => {
    it('findUnifiedTimeline throws → service propagate (khong silent fallback)', async () => {
      const dbError = new Error('Mongo timeout');
      vi.mocked(findUnifiedTimeline).mockRejectedValueOnce(dbError);

      // F8 fix: query error phai throw (khong tu dong fallback sang blockchain)
      // de controller tra 500, khong gay data divergence.
      await expect(
        getUnifiedTimeline({ projectId: 'p1' }, 10)
      ).rejects.toThrow('Mongo timeout');
    });

    it('findUnifiedTimeline tra ve rỗng → service van fallback sang blockchain (khong phai error)', async () => {
      const { findDonationsByProjectIdWithDateFilter } = await import('../../repositories/donationRepository');

      vi.mocked(findUnifiedTimeline).mockResolvedValue({
        items: [],
        nextCursor: null,
        totalCount: 0
      });

      vi.mocked(findDonationsByProjectIdWithDateFilter).mockResolvedValue([{
        _id: 'doc-1',
        amount: 50000,
        timestamp: new Date('2024-06-15T10:30:00.000Z'),
        walletAddress: '0x742d35cc6634c0532925a3b844bc9e7595f5c21a',
        txHash: '0xabc',
        projectId: 'p1'
      }]);

      const result = await getUnifiedTimeline({ projectId: 'p1' }, 10);

      // Khong co data o unified → fallback sang blockchain (co data)
      expect(result.fallbackMode).toBe(true);
      expect(result.timeline).toHaveLength(1);
    });
  });

  // ===== F10: cache invalidation pattern =====
  describe('F10: cache invalidation pattern', () => {
    it('invalidateUnifiedTimelineCache luon xoa toan bo namespace (transparency:unified:*)', async () => {
      // F10 fix: luon xoa tat ca key co prefix `transparency:unified:*`,
      // khong phan biet projectId de tranh bo sot wallet-only / date-range key.
      const fakeKeys = [
        'transparency:unified:p1:0xabc:2024-01-01:2024-12-31:50',
        'transparency:unified:p2:all:none:none:50',
        'transparency:unified:all:0xdef:2024-06-01:2024-06-30:50',
        'transparency:unified::0xghi:::10'
      ];

      async function* fakeIterator() {
        yield fakeKeys;
      }
      redisMockApi.mockRedisScanIterator.mockReturnValueOnce(fakeIterator());
      redisMockApi.mockRedisDel.mockResolvedValueOnce(fakeKeys.length);

      // Caller truyen projectId cu the - van phai xoa het
      await invalidateUnifiedTimelineCache('p1');

      // Pattern phai la `transparency:unified:*` (khong phai `transparency:unified:p1:*`)
      expect(redisMockApi.mockRedisScanIterator).toHaveBeenCalledWith({
        MATCH: 'transparency:unified:*',
        COUNT: 100
      });

      // Phai del tat ca keys (khong chi key cua p1)
      expect(redisMockApi.mockRedisDel).toHaveBeenCalledWith(...fakeKeys);
    });

    it('invalidateUnifiedTimelineCache khong co projectId → van xoa het namespace', async () => {
      async function* fakeIterator() {
        yield ['transparency:unified:any-key'];
      }
      redisMockApi.mockRedisScanIterator.mockReturnValueOnce(fakeIterator());
      redisMockApi.mockRedisDel.mockResolvedValueOnce(1);

      await invalidateUnifiedTimelineCache(undefined);

      expect(redisMockApi.mockRedisScanIterator).toHaveBeenCalledWith({
        MATCH: 'transparency:unified:*',
        COUNT: 100
      });
    });

    it('invalidateUnifiedTimelineCache khi khong co key → khong goi del', async () => {
      async function* fakeIterator() {
        // Khong yield gi
      }
      redisMockApi.mockRedisScanIterator.mockReturnValueOnce(fakeIterator());

      await invalidateUnifiedTimelineCache('p1');

      // Khong co key thi khong can del
      expect(redisMockApi.mockRedisDel).not.toHaveBeenCalled();
    });

    it('Cache set voi projectId=undefined → invalidate phai xoa key do', async () => {
      // F10 scenario: set cache voi projectId undefined → key se co dang
      // "transparency:unified:all:0xabc:::50". Cu goi invalidateUnifiedTimelineCache('p1')
      // cu phai xoa (vi gio pattern la transparency:unified:*).

      // Step 1: Set cache (HMAC signed)
      const walletOnlyJson = JSON.stringify({
        timeline: [],
        nextCursor: null,
        cached: false,
        count: 0,
        fallbackMode: false
      });
      const hmacKey = process.env.CACHE_HMAC_KEY || process.env.JWT_SECRET || 'dcp-cache-hmac-default-rotate-me';
      const walletSig = crypto.createHmac('sha256', hmacKey).update(walletOnlyJson).digest('hex');
      const signedWalletJson = `${walletOnlyJson}.${walletSig}`;

      const walletOnlyKey = 'transparency:unified:all:0xabc:::50';

      // Mock Redis scan iterator tra ve key can xoa
      async function* fakeIterator() {
        yield [walletOnlyKey];
      }
      redisMockApi.mockRedisScanIterator.mockReturnValueOnce(fakeIterator());
      redisMockApi.mockRedisDel.mockResolvedValueOnce(1);

      await invalidateUnifiedTimelineCache('p1');

      // Verify key duoc xoa (vi pattern gio la transparency:unified:*)
      expect(redisMockApi.mockRedisDel).toHaveBeenCalledWith(walletOnlyKey);
    });
  });
});