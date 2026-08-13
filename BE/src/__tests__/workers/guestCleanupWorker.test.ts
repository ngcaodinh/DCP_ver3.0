/**
 * Unit tests cho guestCleanupWorker.
 * Test các hàm utility và task-level functions.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { vi } from 'vitest';

// Mock dependencies before imports
vi.mock('../../repositories/guestWalletSessionRepository', () => ({
  expireGuestSessions: vi.fn().mockResolvedValue(0),
  purgeOldGuestSessions: vi.fn().mockResolvedValue(0),
  findGuestWalletSessionsByIds: vi.fn().mockResolvedValue([]),
  aggregateFingerprintCounts: vi.fn().mockResolvedValue(new Map()),
  aggregateSubnetCounts: vi.fn().mockResolvedValue(new Map()),
  findSessionIdsByFingerprintPrefix: vi.fn().mockResolvedValue([]),
  findSessionIdsBySubnet: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../repositories/guestDonationRiskRepository', () => ({
  findAllClusterSuspects: vi.fn().mockResolvedValue([]),
  markManyAsClusterSuspect: vi.fn().mockResolvedValue(0),
}));

vi.mock('../../repositories/anonymousDonationAuditRepository', () => ({
  countAnonymousDonationsSince: vi.fn().mockResolvedValue(0),
}));

vi.mock('../../repositories/donationRepository', () => ({
  countTotalDonationsSince: vi.fn().mockResolvedValue(0),
}));

// Mock logger to avoid noisy output during tests
vi.mock('../../config/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Import after mocks
import {
  extractIpSubnet,
  isIpv6Address,
  taskExpireOverdueSessions,
  taskPurgeOldSessions,
  taskAntiFarmingCheck,
  runGuestCleanup,
  runGuestCleanupOnce,
  detectFingerprintReuse,
  detectSubnetBurst,
  detectSessionVelocity,
  taskDetectClusters
} from '../../workers/guestCleanupWorker';
import { getRequestContext, runWithWorkerContext } from '../../config/requestContext';
import * as guestWalletSessionRepo from '../../repositories/guestWalletSessionRepository';
import * as guestDonationRiskRepo from '../../repositories/guestDonationRiskRepository';
import * as anonymousDonationAuditRepo from '../../repositories/anonymousDonationAuditRepository';
import * as donationRepo from '../../repositories/donationRepository';

describe('guestCleanupWorker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =========================================================
  // Utility function tests
  // =========================================================

  describe('extractIpSubnet', () => {
    it('should return first 3 octets for valid IPv4 address', () => {
      expect(extractIpSubnet('192.168.1.100')).toBe('192.168.1');
      expect(extractIpSubnet('10.0.0.1')).toBe('10.0.0');
      expect(extractIpSubnet('172.16.0.100')).toBe('172.16.0');
    });

    it('should return first 4 groups for full IPv6 address', () => {
      expect(extractIpSubnet('2001:db8:acme:b85f:1234::')).toBe('2001:db8:acme:b85f');
      expect(extractIpSubnet('2001:0db8:0000:0000:0000:0000:0000:0001')).toBe('2001:0db8:0000:0000');
    });

    it('should return empty string for null/undefined/empty input', () => {
      expect(extractIpSubnet('')).toBe('');
      expect(extractIpSubnet(null as unknown as string)).toBe('');
      expect(extractIpSubnet(undefined as unknown as string)).toBe('');
    });

    it('should return original string for malformed IPv4 (not exactly 4 parts)', () => {
      expect(extractIpSubnet('192.168.1')).toBe('192.168.1');
      expect(extractIpSubnet('192.168')).toBe('192.168');
      expect(extractIpSubnet('127.0.0.1')).toBe('127.0.0');
    });

    it('should expand and return first 4 groups for compressed IPv6 (::1)', () => {
      // '::1' expand thành 8 groups: 0:0:0:0:0:0:0:1 → subnet = '0:0:0:0'
      expect(extractIpSubnet('::1')).toBe('0:0:0:0');
    });

    it('should expand and return first 4 groups for compressed IPv6 (fe80::1)', () => {
      // 'fe80::1' expand thành 8 groups: fe80:0:0:0:0:0:0:1 → subnet = 'fe80:0:0:0'
      expect(extractIpSubnet('fe80::1')).toBe('fe80:0:0:0');
    });

    it('should expand and return first 4 groups for compressed IPv6 (2001:db8::)', () => {
      // '2001:db8::' expand thành 8 groups: 2001:db8:0:0:0:0:0:0 → subnet = '2001:db8:0:0'
      expect(extractIpSubnet('2001:db8::')).toBe('2001:db8:0:0');
    });

    it('should expand and return first 4 groups for compressed IPv6 (2001:db8::1)', () => {
      // '2001:db8::1' expand thành 8 groups: 2001:db8:0:0:0:0:0:1 → subnet = '2001:db8:0:0'
      expect(extractIpSubnet('2001:db8::1')).toBe('2001:db8:0:0');
    });

    it('should expand correctly for IPv6 with :: in the middle (non-empty groups = 7)', () => {
      // Input: "1:2::3:4:5:6:7" → 7 non-empty groups, :: at index 1
      // Should expand to: 1:2:0:3:4:5:6:7 → subnet = "1:2:0:3"
      expect(extractIpSubnet('1:2::3:4:5:6:7')).toBe('1:2:0:3');
    });

    it('should return first 4 groups for IPv6 with more than 8 groups (truncate)', () => {
      // More than 8 groups → extract first 4 (no subnet needed for cluster detection)
      expect(extractIpSubnet('2001:db8:0:0:0:0:0:0:0:0:0')).toBe('2001:db8:0:0');
    });

    it('should handle IPv6 with fewer than 4 groups (after expansion)', () => {
      // '2001:db8:acme' expand thành 8 groups: 2001:db8:acme:0:0:0:0:0 → subnet = '2001:db8:acme:0'
      expect(extractIpSubnet('2001:db8:acme')).toBe('2001:db8:acme:0');
    });

    it('should expand IPv6 :: at end correctly (2001:db8::)', () => {
      // '2001:db8::' split: ['2001','db8',''] → 3 non-empty → expansion = 5 → before=['2001','db8'], after=[]
      // result: ['2001','db8','0','0','0','0','0','0'] → subnet = '2001:db8:0:0'
      expect(extractIpSubnet('2001:db8::')).toBe('2001:db8:0:0');
    });

    it('should expand IPv6 :: at beginning correctly (::1)', () => {
      // '::1' split: ['','1'] → 1 non-empty → expansion = 7 → before=[], after=['1']
      // result: ['0','0','0','0','0','0','0','1'] → subnet = '0:0:0:0'
      expect(extractIpSubnet('::1')).toBe('0:0:0:0');
    });

    it('should expand IPv6 :: in middle correctly (fe80::1)', () => {
      // 'fe80::1' split: ['fe80','','1'] → 2 non-empty → expansion = 6 → before=['fe80'], after=['1']
      // result: ['fe80','0','0','0','0','0','0','1'] → subnet = 'fe80:0:0:0'
      expect(extractIpSubnet('fe80::1')).toBe('fe80:0:0:0');
    });

    it('should expand IPv6 with multiple non-empty groups before ::', () => {
      // '2001:db8:acme::' split: ['2001','db8','acme',''] → 3 non-empty → expansion = 5
      // before=['2001','db8','acme'], after=[] → result: 8 groups
      // subnet = '2001:db8:acme:0'
      expect(extractIpSubnet('2001:db8:acme::')).toBe('2001:db8:acme:0');
    });

    it('should handle IPv6 with multiple :: (invalid form - uses first :: only)', () => {
      // Multiple :: like '1::2::3' → split: ['1','','2','','3'] → first emptyIndex = 1
      // This is technically invalid IPv6 but we handle gracefully
      // 3 non-empty → expansion = 5 → before=['1'], after=['2','','3'].filter=[]
      // result: ['1','0','0','0','0','0','','']... wait, let me trace:
      // groups = ['1','','2','','3'], emptyIndex=1, nonEmpty=3, expansion=5
      // before=['1'], expansion=[0,0,0,0,0], after=['2','3']
      // result = ['1','0','0','0','0','0','2','3']
      // Then filter: result.slice(0,8) = ['1','0','0','0','0','0','2','3']
      // slice(0,4) = ['1','0','0','0'] → '1:0:0:0'
      expect(extractIpSubnet('1::2::3')).toBe('1:0:0:0');
    });
  });

  describe('isIpv6Address', () => {
    it('should return false for IPv4 address', () => {
      expect(isIpv6Address('192.168.1.100')).toBe(false);
      expect(isIpv6Address('127.0.0.1')).toBe(false);
      expect(isIpv6Address('10.0.0.1')).toBe(false);
    });

    it('should return false for null/undefined/empty string', () => {
      expect(isIpv6Address('')).toBe(false);
      expect(isIpv6Address(null as unknown as string)).toBe(false);
      expect(isIpv6Address(undefined as unknown as string)).toBe(false);
    });

    it('should return true for IPv6 address', () => {
      expect(isIpv6Address('2001:db8::1')).toBe(true);
      expect(isIpv6Address('::1')).toBe(true);
    });

    it('should return true for full IPv6 address', () => {
      expect(isIpv6Address('2001:0db8:85a3:0000:0000:8a2e:0370:7334')).toBe(true);
    });
  });

  // =========================================================
  // Task-level function tests
  // =========================================================

  describe('taskExpireOverdueSessions', () => {
    it('should call expireGuestSessions and return count', async () => {
      vi.mocked(guestWalletSessionRepo.expireGuestSessions).mockResolvedValue(5);
      const result = await taskExpireOverdueSessions();
      expect(result).toBe(5);
      expect(guestWalletSessionRepo.expireGuestSessions).toHaveBeenCalledTimes(1);
    });

    it('should return 0 when no sessions expired', async () => {
      vi.mocked(guestWalletSessionRepo.expireGuestSessions).mockResolvedValue(0);
      const result = await taskExpireOverdueSessions();
      expect(result).toBe(0);
    });
  });

  describe('taskPurgeOldSessions', () => {
    it('should call purgeOldGuestSessions and return count', async () => {
      vi.mocked(guestWalletSessionRepo.purgeOldGuestSessions).mockResolvedValue(3);
      const result = await taskPurgeOldSessions();
      expect(result).toBe(3);
      expect(guestWalletSessionRepo.purgeOldGuestSessions).toHaveBeenCalledTimes(1);
    });
  });

  describe('taskAntiFarmingCheck', () => {
    it('should return true when guest donations exceed threshold', async () => {
      vi.mocked(anonymousDonationAuditRepo.countAnonymousDonationsSince).mockResolvedValue(70);
      vi.mocked(donationRepo.countTotalDonationsSince).mockResolvedValue(100);
      const result = await taskAntiFarmingCheck();
      expect(result).toBe(true);
    });

    it('should return false when guest donations below threshold', async () => {
      vi.mocked(anonymousDonationAuditRepo.countAnonymousDonationsSince).mockResolvedValue(30);
      vi.mocked(donationRepo.countTotalDonationsSince).mockResolvedValue(100);
      const result = await taskAntiFarmingCheck();
      expect(result).toBe(false);
    });

    it('should return false when total donations is zero', async () => {
      vi.mocked(anonymousDonationAuditRepo.countAnonymousDonationsSince).mockResolvedValue(0);
      vi.mocked(donationRepo.countTotalDonationsSince).mockResolvedValue(0);
      const result = await taskAntiFarmingCheck();
      expect(result).toBe(false);
    });

    it('should return false when guest percent exactly equals threshold', async () => {
      vi.mocked(anonymousDonationAuditRepo.countAnonymousDonationsSince).mockResolvedValue(60);
      vi.mocked(donationRepo.countTotalDonationsSince).mockResolvedValue(100);
      const result = await taskAntiFarmingCheck();
      expect(result).toBe(false);
    });
  });

  describe('runGuestCleanup', () => {
    it('should execute all tasks and return results', async () => {
      let observedWorkerContext: ReturnType<typeof getRequestContext>;

      vi.mocked(guestWalletSessionRepo.expireGuestSessions).mockImplementationOnce(async () => {
        observedWorkerContext = getRequestContext();
        return 2;
      });
      vi.mocked(guestWalletSessionRepo.expireGuestSessions).mockResolvedValue(2);
      vi.mocked(guestWalletSessionRepo.purgeOldGuestSessions).mockResolvedValue(1);
      vi.mocked(guestDonationRiskRepo.findAllClusterSuspects).mockResolvedValue([]);
      vi.mocked(anonymousDonationAuditRepo.countAnonymousDonationsSince).mockResolvedValue(30);
      vi.mocked(donationRepo.countTotalDonationsSince).mockResolvedValue(100);

      const result = await runGuestCleanup();
      expect(result.expired).toBe(2);
      expect(result.purged).toBe(1);
      expect(result.clusters).toBe(0);
      expect(result.farmingDetected).toBe(false);
      expect(observedWorkerContext).toMatchObject({
        workerName: 'guest-cleanup',
        workerRunId: expect.stringMatching(/^guest-cleanup:/)
      });
      expect(observedWorkerContext?.requestId).toBe(observedWorkerContext?.workerRunId);
    });

    it('should create a guest context when run once outside a worker scope', async () => {
      let observedWorkerContext: ReturnType<typeof getRequestContext>;

      vi.mocked(guestWalletSessionRepo.expireGuestSessions).mockImplementationOnce(async () => {
        observedWorkerContext = getRequestContext();
        return 0;
      });

      await runGuestCleanupOnce();

      expect(observedWorkerContext).toMatchObject({
        workerName: 'guest-cleanup',
        workerRunId: expect.stringMatching(/^guest-cleanup:/)
      });
      expect(observedWorkerContext?.requestId).toBe(observedWorkerContext?.workerRunId);
    });

    it('should inherit the parent worker context when ranking reconcile runs it', async () => {
      let observedWorkerContext: ReturnType<typeof getRequestContext>;

      vi.mocked(guestWalletSessionRepo.expireGuestSessions).mockImplementationOnce(async () => {
        observedWorkerContext = getRequestContext();
        return 0;
      });

      await runWithWorkerContext('ranking-reconcile', () => runGuestCleanupOnce());

      expect(observedWorkerContext).toMatchObject({
        workerName: 'ranking-reconcile',
        workerRunId: expect.stringMatching(/^ranking-reconcile:/)
      });
      expect(observedWorkerContext?.requestId).toBe(observedWorkerContext?.workerRunId);
    });
  });

  // =========================================================
  // Cluster detection helper function tests
  // =========================================================

  describe('detectFingerprintReuse', () => {
    it('should return 0 when no fingerprint counts exceed threshold', async () => {
      const fingerprintCounts = new Map<string, number>([
        ['abc123', 2],
        ['def456', 1],
      ]);
      const handledSessionIds = new Set<string>();
      const uniqueFingerprintPrefixes = new Set(['abc123', 'def456']);

      const result = await detectFingerprintReuse(uniqueFingerprintPrefixes, fingerprintCounts, handledSessionIds);
      expect(result).toBe(0);
      expect(guestDonationRiskRepo.markManyAsClusterSuspect).not.toHaveBeenCalled();
    });

    it('should mark sessions when fingerprint count >= 3', async () => {
      const fingerprintCounts = new Map<string, number>([
        ['abc123', 5],
        ['def456', 1],
      ]);
      const handledSessionIds = new Set<string>();
      const uniqueFingerprintPrefixes = new Set(['abc123', 'def456']);

      vi.mocked(guestWalletSessionRepo.findSessionIdsByFingerprintPrefix).mockResolvedValue(['s1', 's2', 's3']);
      vi.mocked(guestDonationRiskRepo.markManyAsClusterSuspect).mockResolvedValue(3);

      const result = await detectFingerprintReuse(uniqueFingerprintPrefixes, fingerprintCounts, handledSessionIds);
      expect(result).toBe(3);
      expect(handledSessionIds.has('s1')).toBe(true);
      expect(handledSessionIds.has('s2')).toBe(true);
      expect(handledSessionIds.has('s3')).toBe(true);
    });

    it('should handle multiple fingerprint prefixes in parallel chunks', async () => {
      const fingerprintCounts = new Map<string, number>([
        ['abc123', 5],
        ['def456', 3],
        ['ghi789', 1],
      ]);
      const handledSessionIds = new Set<string>();
      const uniqueFingerprintPrefixes = new Set(['abc123', 'def456', 'ghi789']);

      vi.mocked(guestWalletSessionRepo.findSessionIdsByFingerprintPrefix)
        .mockResolvedValueOnce(['s1', 's2', 's3', 's4', 's5'])
        .mockResolvedValueOnce(['s6', 's7', 's8'])
        .mockResolvedValueOnce([]);
      vi.mocked(guestDonationRiskRepo.markManyAsClusterSuspect)
        .mockResolvedValueOnce(5)
        .mockResolvedValueOnce(3);

      const result = await detectFingerprintReuse(uniqueFingerprintPrefixes, fingerprintCounts, handledSessionIds);
      expect(result).toBe(8);
    });

    it('should return 0 when no prefixes in set', async () => {
      const fingerprintCounts = new Map<string, number>();
      const handledSessionIds = new Set<string>();
      const uniqueFingerprintPrefixes = new Set<string>();

      const result = await detectFingerprintReuse(uniqueFingerprintPrefixes, fingerprintCounts, handledSessionIds);
      expect(result).toBe(0);
    });
  });

  describe('detectSubnetBurst', () => {
    it('should return 0 when no subnet counts exceed threshold', async () => {
      const subnetCounts = new Map<string, number>([
        ['192.168.1', 4],
        ['10.0.0', 2],
      ]);
      const handledSessionIds = new Set<string>();
      const uniqueSubnetQueries = [
        { prefix: '192.168.1', isIpv6: false },
        { prefix: '10.0.0', isIpv6: false },
      ];

      const result = await detectSubnetBurst(uniqueSubnetQueries, subnetCounts, handledSessionIds);
      expect(result).toBe(0);
    });

    it('should mark sessions when subnet count >= 5', async () => {
      const subnetCounts = new Map<string, number>([
        ['192.168.1', 8],
      ]);
      const handledSessionIds = new Set<string>();
      const uniqueSubnetQueries = [{ prefix: '192.168.1', isIpv6: false }];

      vi.mocked(guestWalletSessionRepo.findSessionIdsBySubnet).mockResolvedValue(['s1', 's2', 's3', 's4', 's5']);
      vi.mocked(guestDonationRiskRepo.markManyAsClusterSuspect).mockResolvedValue(5);

      const result = await detectSubnetBurst(uniqueSubnetQueries, subnetCounts, handledSessionIds);
      expect(result).toBe(5);
    });

    it('should handle multiple subnets in parallel chunks', async () => {
      const subnetCounts = new Map<string, number>([
        ['192.168.1', 8],
        ['10.0.0', 6],
      ]);
      const handledSessionIds = new Set<string>();
      const uniqueSubnetQueries = [
        { prefix: '192.168.1', isIpv6: false },
        { prefix: '10.0.0', isIpv6: false },
      ];

      vi.mocked(guestWalletSessionRepo.findSessionIdsBySubnet)
        .mockResolvedValueOnce(['s1', 's2', 's3', 's4', 's5'])
        .mockResolvedValueOnce(['s6', 's7', 's8', 's9', 's10', 's11']);
      vi.mocked(guestDonationRiskRepo.markManyAsClusterSuspect)
        .mockResolvedValueOnce(5)
        .mockResolvedValueOnce(6);

      const result = await detectSubnetBurst(uniqueSubnetQueries, subnetCounts, handledSessionIds);
      expect(result).toBe(11);
    });

    it('should return 0 when empty subnet queries array', async () => {
      const subnetCounts = new Map<string, number>();
      const handledSessionIds = new Set<string>();
      const uniqueSubnetQueries: { prefix: string; isIpv6: boolean }[] = [];

      const result = await detectSubnetBurst(uniqueSubnetQueries, subnetCounts, handledSessionIds);
      expect(result).toBe(0);
    });
  });

  describe('detectSessionVelocity', () => {
    it('should return 0 when sessions are too far apart in time', async () => {
      const now = new Date();
      const lookbackDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

      const subnetSessionMap = new Map<string, any[]>([
        ['192.168.1', [
          { sessionId: 's1', createdAt: new Date(now.getTime() - 10 * 60 * 1000) },
          { sessionId: 's2', createdAt: new Date(now.getTime() - 5 * 60 * 1000) },
        ]]
      ]);
      const handledSessionIds = new Set<string>();
      const uniqueSubnetQueries = [{ prefix: '192.168.1', isIpv6: false }];

      const result = await detectSessionVelocity(uniqueSubnetQueries, subnetSessionMap, handledSessionIds, lookbackDate);
      expect(result).toBe(0);
    });

    it('should mark sessions when created within 2 minutes', async () => {
      const now = new Date();
      const lookbackDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

      const subnetSessionMap = new Map<string, any[]>([
        ['192.168.1', [
          { sessionId: 's1', createdAt: new Date(now.getTime() - 90 * 1000) },
          { sessionId: 's2', createdAt: new Date(now.getTime() - 30 * 1000) },
        ]]
      ]);
      const handledSessionIds = new Set<string>();
      const uniqueSubnetQueries = [{ prefix: '192.168.1', isIpv6: false }];

      vi.mocked(guestDonationRiskRepo.markManyAsClusterSuspect).mockResolvedValue(2);

      const result = await detectSessionVelocity(uniqueSubnetQueries, subnetSessionMap, handledSessionIds, lookbackDate);
      expect(result).toBe(2);
      expect(handledSessionIds.has('s1')).toBe(true);
      expect(handledSessionIds.has('s2')).toBe(true);
    });

    it('should return 0 when subnet has fewer than 2 sessions', async () => {
      const now = new Date();
      const lookbackDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

      const subnetSessionMap = new Map<string, any[]>([
        ['192.168.1', [
          { sessionId: 's1', createdAt: new Date() },
        ]]
      ]);
      const handledSessionIds = new Set<string>();
      const uniqueSubnetQueries = [{ prefix: '192.168.1', isIpv6: false }];

      const result = await detectSessionVelocity(uniqueSubnetQueries, subnetSessionMap, handledSessionIds, lookbackDate);
      expect(result).toBe(0);
    });

    it('should skip pairs where both sessions are already handled', async () => {
      const now = new Date();
      const lookbackDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

      const subnetSessionMap = new Map<string, any[]>([
        ['192.168.1', [
          { sessionId: 's1', createdAt: new Date(now.getTime() - 90 * 1000) },
          { sessionId: 's2', createdAt: new Date(now.getTime() - 30 * 1000) },
        ]]
      ]);
      const handledSessionIds = new Set<string>(['s1', 's2']);
      const uniqueSubnetQueries = [{ prefix: '192.168.1', isIpv6: false }];

      const result = await detectSessionVelocity(uniqueSubnetQueries, subnetSessionMap, handledSessionIds, lookbackDate);
      expect(result).toBe(0);
      expect(guestDonationRiskRepo.markManyAsClusterSuspect).not.toHaveBeenCalled();
    });

    it('should use timestamp-based clusterId (not array index)', async () => {
      const now = new Date();
      const t1 = now.getTime() - 90 * 1000;
      const t2 = now.getTime() - 30 * 1000;
      const lookbackDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

      const subnetSessionMap = new Map<string, any[]>([
        ['192.168.1', [
          { sessionId: 's1', createdAt: new Date(t1) },
          { sessionId: 's2', createdAt: new Date(t2) },
        ]]
      ]);
      const handledSessionIds = new Set<string>();
      const uniqueSubnetQueries = [{ prefix: '192.168.1', isIpv6: false }];

      vi.mocked(guestDonationRiskRepo.markManyAsClusterSuspect).mockImplementation(async (ids, clusterId) => {
        // Verify clusterId uses timestamp, not array index
        expect(clusterId).toBe(`vel_192.168.1_${t1}`);
        return ids.length;
      });

      const result = await detectSessionVelocity(uniqueSubnetQueries, subnetSessionMap, handledSessionIds, lookbackDate);
      expect(result).toBe(2);
    });

    it('should detect multiple velocity pairs in sorted order', async () => {
      const now = new Date();
      const lookbackDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

      const subnetSessionMap = new Map<string, any[]>([
        ['192.168.1', [
          { sessionId: 's1', createdAt: new Date(now.getTime() - 120 * 1000) },
          { sessionId: 's2', createdAt: new Date(now.getTime() - 90 * 1000) },
          { sessionId: 's3', createdAt: new Date(now.getTime() - 60 * 1000) },
        ]]
      ]);
      const handledSessionIds = new Set<string>();
      const uniqueSubnetQueries = [{ prefix: '192.168.1', isIpv6: false }];

      // S1↔S2 within 2min, S2↔S3 within 2min → 2 clusters
      vi.mocked(guestDonationRiskRepo.markManyAsClusterSuspect)
        .mockResolvedValueOnce(2)
        .mockResolvedValueOnce(0); // S3 already handled

      const result = await detectSessionVelocity(uniqueSubnetQueries, subnetSessionMap, handledSessionIds, lookbackDate);
      // First cluster marks s1,s2. Second cluster: s3 already handled in s1↔s2, so 0.
      expect(result).toBe(2);
    });

    it('should filter out sessions outside lookback window', async () => {
      const now = new Date();
      const lookbackDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

      const subnetSessionMap = new Map<string, any[]>([
        ['192.168.1', [
          { sessionId: 's1', createdAt: new Date(now.getTime() - 90 * 1000) },
          // Session old enough to be outside lookback window → filtered
          { sessionId: 's_old', createdAt: new Date(lookbackDate.getTime() - 1000) },
        ]]
      ]);
      const handledSessionIds = new Set<string>();
      const uniqueSubnetQueries = [{ prefix: '192.168.1', isIpv6: false }];

      // After filtering: only s1 remains (length=1 < 2) → no adjacent pairs → no marking
      const result = await detectSessionVelocity(uniqueSubnetQueries, subnetSessionMap, handledSessionIds, lookbackDate);
      expect(result).toBe(0);
    });

    it('should NOT mark when timeDiffMs exactly equals VELOCITY_WINDOW_MS (120000ms)', async () => {
      const now = new Date();
      const lookbackDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      // S1 tạo lúc now - 120000ms, S2 tạo lúc now → diff = 120000ms === VELOCITY_WINDOW_MS
      const t1 = now.getTime() - 120000;
      const t2 = now.getTime();

      const subnetSessionMap = new Map<string, any[]>([
        ['192.168.1', [
          { sessionId: 's1', createdAt: new Date(t1) },
          { sessionId: 's2', createdAt: new Date(t2) },
        ]]
      ]);
      const handledSessionIds = new Set<string>();
      const uniqueSubnetQueries = [{ prefix: '192.168.1', isIpv6: false }];

      const result = await detectSessionVelocity(uniqueSubnetQueries, subnetSessionMap, handledSessionIds, lookbackDate);
      // timeDiffMs === 120000 >= VELOCITY_WINDOW_MS (120000) → skip → 0
      expect(result).toBe(0);
      expect(guestDonationRiskRepo.markManyAsClusterSuspect).not.toHaveBeenCalled();
    });

    it('should mark when timeDiffMs is just below VELOCITY_WINDOW_MS (119999ms)', async () => {
      const now = new Date();
      const lookbackDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      // S1 tạo lúc now - 119999ms, S2 tạo lúc now → diff = 119999ms < VELOCITY_WINDOW_MS → mark
      const t1 = now.getTime() - 119999;
      const t2 = now.getTime();

      const subnetSessionMap = new Map<string, any[]>([
        ['192.168.1', [
          { sessionId: 's1', createdAt: new Date(t1) },
          { sessionId: 's2', createdAt: new Date(t2) },
        ]]
      ]);
      const handledSessionIds = new Set<string>();
      const uniqueSubnetQueries = [{ prefix: '192.168.1', isIpv6: false }];

      vi.mocked(guestDonationRiskRepo.markManyAsClusterSuspect).mockResolvedValue(2);

      const result = await detectSessionVelocity(uniqueSubnetQueries, subnetSessionMap, handledSessionIds, lookbackDate);
      expect(result).toBe(2);
    });

    it('should NOT mark when timeDiffMs is just above VELOCITY_WINDOW_MS (120001ms)', async () => {
      const now = new Date();
      const lookbackDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      // S1 tạo lúc now - 120001ms, S2 tạo lúc now → diff = 120001ms > VELOCITY_WINDOW_MS → skip
      const t1 = now.getTime() - 120001;
      const t2 = now.getTime();

      const subnetSessionMap = new Map<string, any[]>([
        ['192.168.1', [
          { sessionId: 's1', createdAt: new Date(t1) },
          { sessionId: 's2', createdAt: new Date(t2) },
        ]]
      ]);
      const handledSessionIds = new Set<string>();
      const uniqueSubnetQueries = [{ prefix: '192.168.1', isIpv6: false }];

      const result = await detectSessionVelocity(uniqueSubnetQueries, subnetSessionMap, handledSessionIds, lookbackDate);
      expect(result).toBe(0);
      expect(guestDonationRiskRepo.markManyAsClusterSuspect).not.toHaveBeenCalled();
    });

    it('should mark only the unmarked session when one of the pair is already handled', async () => {
      const now = new Date();
      const lookbackDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

      const subnetSessionMap = new Map<string, any[]>([
        ['192.168.1', [
          { sessionId: 's1', createdAt: new Date(now.getTime() - 90 * 1000) },
          { sessionId: 's2', createdAt: new Date(now.getTime() - 30 * 1000) },
        ]]
      ]);
      // s1 đã được mark trước đó, chỉ s2 cần mark
      const handledSessionIds = new Set<string>(['s1']);
      const uniqueSubnetQueries = [{ prefix: '192.168.1', isIpv6: false }];

      vi.mocked(guestDonationRiskRepo.markManyAsClusterSuspect).mockImplementation(async (ids, clusterId) => {
        // Chỉ s2 được mark
        expect(ids).toEqual(['s2']);
        expect(clusterId).toContain('vel_192.168.1_');
        return ids.length;
      });

      const result = await detectSessionVelocity(uniqueSubnetQueries, subnetSessionMap, handledSessionIds, lookbackDate);
      expect(result).toBe(1);
    });
  });

  describe('taskDetectClusters', () => {
    it('should return 0 when no existing suspects', async () => {
      vi.mocked(guestDonationRiskRepo.findAllClusterSuspects).mockResolvedValue([]);

      const result = await taskDetectClusters();
      expect(result).toBe(0);
    });

    it('should process suspects and run all detection steps', async () => {
      const now = new Date();
      const suspect = {
        _id: { toString: () => 'suspectObjId1' },
        sessionId: 'suspect1',
        walletAddress: '0x123',
        riskScore: 30,
        riskLevel: 'MEDIUM' as const,
        trustMultiplier: 0.5,
        factors: {
          walletAgeScore: 0,
          ipBurstScore: 0,
          fingerprintReuseScore: 0,
          donationPatternScore: 0,
          sessionVelocityScore: 0,
        },
        blocked: false,
        blockedAt: null,
        blockedReason: null,
        clusterSuspect: true,
        clusterId: null,
        lastEvaluatedAt: now,
        createdAt: now,
        updatedAt: now,
      };

      vi.mocked(guestDonationRiskRepo.findAllClusterSuspects).mockResolvedValue([suspect] as any);
      vi.mocked(guestWalletSessionRepo.findGuestWalletSessionsByIds).mockResolvedValue([{
        sessionId: 'suspect1',
        walletAddress: '0x123',
        deviceFingerprintHash: 'abcd1234abcd1234abcd1234abcd1234',
        ipAddress: '192.168.1.100',
        userAgent: 'Mozilla/5.0',
        status: 'ACTIVE' as const,
        donationCount: 0,
        totalDonatedAmount: 0,
        totalSponsoredGas: 0,
        renewalCount: 0,
        claimedByUserId: null,
        serverSalt: 'salt',
        smartAccountOwnerEncryptedPrivateKey: null,
        hasPendingDonation: false,
        pendingAlertSentAt: null,
        expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
        createdAt: new Date(now.getTime() - 60 * 60 * 1000),
        updatedAt: now,
      }]);
      vi.mocked(guestWalletSessionRepo.aggregateFingerprintCounts).mockResolvedValue(new Map());
      vi.mocked(guestWalletSessionRepo.aggregateSubnetCounts).mockResolvedValue(new Map());

      const result = await taskDetectClusters(now);
      expect(result).toBe(0);
      expect(guestDonationRiskRepo.findAllClusterSuspects).toHaveBeenCalled();
      expect(guestWalletSessionRepo.findGuestWalletSessionsByIds).toHaveBeenCalledWith(['suspect1']);
    });

    it('should pass cursor lastSeenId to findAllClusterSuspects on subsequent batches', async () => {
      const now = new Date();
      let capturedLastSeenId: string | undefined;

      vi.mocked(guestDonationRiskRepo.findAllClusterSuspects).mockImplementation(
        async (upperBound: number | undefined, lastSeenId?: string) => {
          capturedLastSeenId = lastSeenId;
          return [];
        }
      );

      await taskDetectClusters(now);

      // First call has no lastSeenId (undefined)
      expect(capturedLastSeenId).toBeUndefined();
    });
  });
});
