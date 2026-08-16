import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockEmit = vi.fn();
const mockIoTo = vi.fn().mockReturnThis();
const mockIo = {
  to: mockIoTo,
  emit: mockEmit
};

vi.mock('../../config/socketServer', () => ({
  getSocketServer: vi.fn(() => mockIo)
}));

vi.mock('../../config/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}));

import { initializeSbtEventBridge, shutdownSbtEventBridge } from '../../services/sbtEventBridge.service';
import { sbtEvents } from '../../events/sbtEvents';
import { getSocketServer } from '../../config/socketServer';

describe('sbtEventBridge.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sbtEvents.removeAllListeners();
  });

  // ===========================================================================
  // initializeSbtEventBridge — listener registration
  // ===========================================================================
  describe('initializeSbtEventBridge', () => {
    it('đăng ký đúng 4 listeners cho sbtEvents', () => {
      initializeSbtEventBridge();

      expect(sbtEvents.listenerCount('sbt.minted')).toBe(1);
      expect(sbtEvents.listenerCount('sbt.mint-failed')).toBe(1);
      expect(sbtEvents.listenerCount('sbt.mint-dlq')).toBe(1);
      expect(sbtEvents.listenerCount('sbt.mint-blocked')).toBe(1);
    });

    it('sbt.minted event → emit socket tới admin room với đúng payload', () => {
      initializeSbtEventBridge();

      sbtEvents.emit('sbt.minted', {
        sbtId: 'SBT-001',
        mintRequestId: 'SBT-MINT-001',
        projectId: 'proj-1',
        organizationId: 'org-1',
        beneficiaryAddress: '0x1234567890123456789012345678901234567890',
        onChainTokenId: 42,
        transactionHash: '0xtxhash001',
        blockNumber: 12345,
        imageCid: 'QmTest',
        tokenUri: 'ipfs://QmTest',
        milestone: 0,
        beneficiaryCount: 1,
        mintedAt: new Date('2025-01-01T00:00:00Z')
      });

      expect(mockIoTo).toHaveBeenCalledWith('admin');
      expect(mockEmit).toHaveBeenCalledWith('sbt:minted', expect.objectContaining({
        sbtId: 'SBT-001',
        mintRequestId: 'SBT-MINT-001',
        onChainTokenId: 42,
        transactionHash: '0xtxhash001',
        blockNumber: 12345
      }));
    });

    it('sbt.mint-failed event → emit socket tới admin room với đúng payload', () => {
      initializeSbtEventBridge();

      sbtEvents.emit('sbt.mint-failed', {
        sbtId: 'SBT-fail-001',
        mintRequestId: 'SBT-MINT-FAIL-001',
        projectId: 'proj-1',
        organizationId: 'org-1',
        attemptNumber: 3,
        errorMessage: 'RPC timeout',
        failedAt: new Date('2025-01-01T00:00:00Z')
      });

      expect(mockIoTo).toHaveBeenCalledWith('admin');
      expect(mockEmit).toHaveBeenCalledWith('sbt:mint-failed', expect.objectContaining({
        sbtId: 'SBT-fail-001',
        attemptNumber: 3,
        errorMessage: 'RPC timeout'
      }));
    });

    it('sbt.mint-dlq event → emit socket tới admin room với đúng payload', () => {
      initializeSbtEventBridge();

      sbtEvents.emit('sbt.mint-dlq', {
        sbtId: 'SBT-dlq-001',
        mintRequestId: 'SBT-MINT-DLQ-001',
        projectId: 'proj-1',
        organizationId: 'org-1',
        beneficiaryAddress: '0x1234567890123456789012345678901234567890',
        attemptNumber: 6,
        lastErrorMessage: 'All retries exhausted',
        dlqAt: new Date('2025-01-01T00:00:00Z')
      });

      expect(mockIoTo).toHaveBeenCalledWith('admin');
      expect(mockEmit).toHaveBeenCalledWith('sbt:mint-dlq', expect.objectContaining({
        sbtId: 'SBT-dlq-001',
        attemptNumber: 6,
        lastErrorMessage: 'All retries exhausted'
      }));
    });

    it('sbt.mint-blocked event → emit socket tới admin room với đúng payload', () => {
      initializeSbtEventBridge();

      sbtEvents.emit('sbt.mint-blocked', {
        mintRequestId: 'SBT-MINT-BLOCKED-001',
        verificationId: 'ver-blocked-001',
        projectId: 'proj-1',
        organizationId: 'org-1',
        reason: 'NO_DONOR_ADDRESS',
        blockedAt: new Date('2025-01-01T00:00:00Z')
      });

      expect(mockIoTo).toHaveBeenCalledWith('admin');
      expect(mockEmit).toHaveBeenCalledWith('sbt:mint-blocked', expect.objectContaining({
        verificationId: 'ver-blocked-001',
        reason: 'NO_DONOR_ADDRESS'
      }));
    });

    it('gọi 2 lần KHÔNG tạo duplicate listeners', () => {
      initializeSbtEventBridge();
      initializeSbtEventBridge(); // Re-init

      expect(sbtEvents.listenerCount('sbt.minted')).toBe(1);
      expect(sbtEvents.listenerCount('sbt.mint-failed')).toBe(1);
      expect(sbtEvents.listenerCount('sbt.mint-dlq')).toBe(1);
      expect(sbtEvents.listenerCount('sbt.mint-blocked')).toBe(1);
    });
  });

  // ===========================================================================
  // shutdownSbtEventBridge — cleanup
  // ===========================================================================
  describe('shutdownSbtEventBridge', () => {
    it('xóa tất cả 4 listeners sau khi shutdown', () => {
      initializeSbtEventBridge();
      shutdownSbtEventBridge();

      expect(sbtEvents.listenerCount('sbt.minted')).toBe(0);
      expect(sbtEvents.listenerCount('sbt.mint-failed')).toBe(0);
      expect(sbtEvents.listenerCount('sbt.mint-dlq')).toBe(0);
      expect(sbtEvents.listenerCount('sbt.mint-blocked')).toBe(0);
    });

    it('shutdown 2 lần không crash (idempotent)', () => {
      initializeSbtEventBridge();
      shutdownSbtEventBridge();
      expect(() => shutdownSbtEventBridge()).not.toThrow();
    });
  });

  // ===========================================================================
  // Edge cases
  // ===========================================================================
  describe('edge cases', () => {
    it('emit sbt.minted khi io chưa khả dụng → không throw', () => {
      vi.mocked(getSocketServer).mockReturnValueOnce(null as any);
      initializeSbtEventBridge();

      expect(() => {
        sbtEvents.emit('sbt.minted', {
          sbtId: 'SBT-orphan',
          mintRequestId: 'SBT-MINT-orphan',
          projectId: 'proj-1',
          organizationId: 'org-1',
          beneficiaryAddress: '0x1234567890123456789012345678901234567890',
          onChainTokenId: 0,
          transactionHash: '0xorphan',
          blockNumber: 0,
          imageCid: 'QmOrphan',
        tokenUri: 'ipfs://QmOrphan',
          milestone: 0,
          beneficiaryCount: 1,
          mintedAt: new Date()
        });
      }).not.toThrow();
    });

    it('emit sbt.mint-blocked khi io chưa khả dụng → không throw', () => {
      vi.mocked(getSocketServer).mockReturnValueOnce(null as any);
      initializeSbtEventBridge();

      expect(() => {
        sbtEvents.emit('sbt.mint-blocked', {
          mintRequestId: 'SBT-MINT-BLOCKED-002',
          verificationId: 'ver-blocked-002',
          projectId: 'proj-1',
          organizationId: 'org-1',
          reason: 'NO_DONOR_ADDRESS',
          blockedAt: new Date()
        });
      }).not.toThrow();
    });
  });
});
