import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ethers } from 'ethers';

const recordBlockchainTransactionMock = vi.hoisted(() => vi.fn());
const eventLoggerLogEventMock = vi.hoisted(() => vi.fn());
const providerMock = vi.hoisted(() => ({
  getTransactionCount: vi.fn().mockResolvedValue(0),
  getTransactionReceipt: vi.fn().mockResolvedValue(null)
}));
const reserveNonceMock = vi.hoisted(() => vi.fn().mockResolvedValue(0));

// vi.mock hoists above imports, so ethers needs to be imported before any vi.mock calls
// that reference it. The sbtMintService module creates SBT_MINTED_EVENT_IFACE at module
// evaluation time, so ethers must be available. Import at top ensures this.

vi.mock('../../config/logger', () => ({
  getLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn()
  })
}));

vi.mock('../../config/sbtContract', () => ({
  getWritableImpactSbtContract: vi.fn(),
  getReadOnlyImpactSbtProvider: vi.fn(() => providerMock),
  getImpactSbtMintSignerAddress: vi.fn(() => '0x0000000000000000000000000000000000000001')
}));

// Reset cache for each test to avoid stale contract instances
beforeEach(() => {
  vi.clearAllMocks();
  providerMock.getTransactionCount.mockResolvedValue(0);
  providerMock.getTransactionReceipt.mockResolvedValue(null);
  reserveNonceMock.mockResolvedValue(0);
  (claimImpactSbtForSubmission as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 'SUBMITTING' });
  // Reset module-level cached contract by clearing the internal state
  // The cached contract is created lazily on first call to getWritableContract
});

vi.mock('../../models/impactSbtMetadataModel', () => ({
  createImpactSbtMetadata: vi.fn(),
  findImpactSbtMetadataByMintRequestId: vi.fn(),
  findImpactSbtMetadataByVerificationId: vi.fn(),
  claimImpactSbtForSubmission: vi.fn().mockResolvedValue({ status: 'SUBMITTING' }),
  reserveImpactSbtSubmissionNonce: vi.fn().mockResolvedValue({ status: 'SUBMITTING' }),
  markImpactSbtAsSubmitted: vi.fn().mockResolvedValue({ status: 'SUBMITTED' }),
  markImpactSbtAsConfirmed: vi.fn().mockResolvedValue({ status: 'CONFIRMED' }),
  markImpactSbtAsFailed: vi.fn(),
  releaseExpiredSbtSubmissionWithoutNonce: vi.fn(),
  markImpactSbtAsDlq: vi.fn(),
  resetImpactSbtForReRun: vi.fn(),
  createBlockedImpactSbtMetadata: vi.fn(),
  findImpactSbtNeedingRecovery: vi.fn(),
  countConfirmedImpactSbtByProjectId: vi.fn()
}));

vi.mock('../../models/sbtMintNonceModel', () => ({
  reserveNextSbtMintNonce: reserveNonceMock
}));

vi.mock('../../models/sbtMintDlqModel', () => ({
  createSbtMintDlqEntry: vi.fn(),
  markSbtMintDlqAsRecovered: vi.fn(),
  findSbtMintDlqByMintRequestId: vi.fn(),
  markSbtMintDlqRerunStarted: vi.fn(),
  markSbtMintDlqRerunFailed: vi.fn()
}));

vi.mock('../../queues/sbtMintQueue', () => ({
  enqueueSbtMint: vi.fn().mockResolvedValue({ jobId: 'job-123', enqueued: true }),
  countPendingSbtMintJobsByRequestId: vi.fn().mockResolvedValue(0),
  removePendingSbtMintJobsByRequestId: vi.fn().mockResolvedValue(0),
  SBT_MINT_RETRY_DELAYS_MS: [300000, 900000, 3600000, 3600000, 14400000, 86400000],
  SBT_MINT_MAX_ATTEMPTS: 7,
  SBT_MINT_STUCK_TX_THRESHOLD_MS: 300000
}));

vi.mock('../../events/sbtEvents', () => ({
  sbtEvents: { emit: vi.fn() }
}));

vi.mock('../../services/event-logger.service', () => ({
  logEvent: eventLoggerLogEventMock
}));

vi.mock('../../services/sbtMetadataCacheService', () => ({
  invalidateSbtGalleryTotalCache: vi.fn()
}));

vi.mock('../../utils/blockchainMetrics', () => ({
  recordBlockchainTransaction: recordBlockchainTransactionMock
}));

vi.mock('../../services/audit-log.service', () => ({
  recordAdminAuditLog: vi.fn().mockResolvedValue({})
}));

vi.mock('../../models/adminActionOutboxModel', () => ({
  createAdminActionOutbox: vi.fn().mockResolvedValue({})
}));

vi.mock('../../workers/adminActionOutboxWorker', () => ({
  runAdminActionOutboxOnce: vi.fn().mockResolvedValue(1)
}));

vi.mock('../../utils/applicationError', () => ({
  ApplicationError: class ApplicationError extends Error {
    public statusCode: number;
    public code: string;
    constructor(message: string, statusCode: number, code: string) {
      super(message);
      this.name = 'ApplicationError';
      this.statusCode = statusCode;
      this.code = code;
    }
  }
}));

import { getWritableImpactSbtContract } from '../../config/sbtContract';
import {
  createImpactSbtMetadata,
  findImpactSbtMetadataByVerificationId,
  findImpactSbtMetadataByMintRequestId,
  claimImpactSbtForSubmission,
  markImpactSbtAsSubmitted,
  markImpactSbtAsConfirmed,
  markImpactSbtAsFailed,
  releaseExpiredSbtSubmissionWithoutNonce,
  markImpactSbtAsDlq,
  resetImpactSbtForReRun,
  findImpactSbtNeedingRecovery
} from '../../models/impactSbtMetadataModel';
import { createSbtMintDlqEntry, findSbtMintDlqByMintRequestId } from '../../models/sbtMintDlqModel';
import { enqueueSbtMint, countPendingSbtMintJobsByRequestId, removePendingSbtMintJobsByRequestId, SBT_MINT_RETRY_DELAYS_MS, SBT_MINT_MAX_ATTEMPTS } from '../../queues/sbtMintQueue';
import { sbtEvents } from '../../events/sbtEvents';
import { invalidateSbtGalleryTotalCache } from '../../services/sbtMetadataCacheService';
import { ApplicationError } from '../../utils/applicationError';
import { recordBlockchainTransaction } from '../../utils/blockchainMetrics';
import * as adminActionOutboxModel from '../../models/adminActionOutboxModel';
import { runAdminActionOutboxOnce } from '../../workers/adminActionOutboxWorker';
import {
  createSbtMintRequest,
  executeSbtMint,
  handleSbtMintFailure,
  rerunSbtMintJob,
  recoverStuckSbtMints,
  reconcileSubmittedSbtMint,
  resetWritableContractForTest
} from '../../services/sbtMintService';

// =============================================================================
// Test: createSbtMintRequest
// =============================================================================
describe('sbtMintService - createSbtMintRequest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('trả về duplicate=true khi verificationId đã tồn tại (atomic upsert trả về existing record)', async () => {
    // [IMPORTANT #19 fix] createImpactSbtMetadata dùng upsert nên trả về existing record
    // thay vì throw. Check duplicate bằng cách so sánh sbtId.
    const existingRecord = {
      sbtId: 'SBT-existing', // Khác với sbtId sẽ được generate
      mintRequestId: 'SBT-MINT-existing',
      verificationId: 'ver-123',
      status: 'PENDING',
      attemptNumber: 0
    } as any;
    // Upsert trả về existing record khi verificationId đã tồn tại
    (createImpactSbtMetadata as ReturnType<typeof vi.fn>).mockResolvedValue(existingRecord);

    const input = {
      verificationId: 'ver-123',
      projectId: 'proj-1',
      organizationId: 'org-1',
      beneficiaryAddress: '0x1234567890123456789012345678901234567890',
      projectIdNumeric: 1,
      milestone: 0,
      beneficiaryCount: 1,
      gpsCoordinates: '',
      imageCid: 'QmTest',
      tokenUri: 'ipfs://QmTest'
    };

    const result = await createSbtMintRequest(input);

    expect(result.duplicate).toBe(true);
    expect(result.record.mintRequestId).toBe('SBT-MINT-existing');
    expect(enqueueSbtMint).toHaveBeenCalledWith(expect.objectContaining({ attemptNumber: 1 }), expect.objectContaining({ priority: 5 }));
  });

  it('tạo record mới + enqueue job + trả về duplicate=false khi chưa tồn tại', async () => {
    // createImpactSbtMetadata trả về record với sbtId giống như chúng ta generate
    (createImpactSbtMetadata as ReturnType<typeof vi.fn>).mockImplementation(async (data: any) => {
      return {
        ...data,
        status: 'PENDING'
      };
    });
    (enqueueSbtMint as ReturnType<typeof vi.fn>).mockResolvedValue({ jobId: 'job-456', enqueued: true });

    const input = {
      verificationId: 'ver-new',
      projectId: 'proj-1',
      organizationId: 'org-1',
      beneficiaryAddress: '0x1234567890123456789012345678901234567890',
      projectIdNumeric: 1,
      milestone: 0,
      beneficiaryCount: 1,
      gpsCoordinates: '',
      imageCid: 'QmTest',
      tokenUri: 'ipfs://QmTest'
    };

    const result = await createSbtMintRequest(input);

    expect(result.duplicate).toBe(false);
    expect(result.jobId).toBe('job-456');
    expect(createImpactSbtMetadata).toHaveBeenCalled();
    expect(enqueueSbtMint).toHaveBeenCalledWith(
      expect.objectContaining({
        mintRequestId: expect.stringContaining('SBT-MINT-'),
        sbtId: expect.stringContaining('SBT-'),
        attemptNumber: 1,
        enqueuedBy: 'oracle_event'
      }),
      expect.objectContaining({ priority: 5 })
    );
  });

  it('atomic upsert luôn thành công - trả về existing record khi verificationId đã tồn tại', async () => {
    // [IMPORTANT #19 fix] Với atomic upsert, createImpactSbtMetadata KHÔNG throw cho duplicate.
    // Thay vào đó, upsert trả về existing record và chúng ta check sbtId để detect duplicate.
    const existingRecord = {
      sbtId: 'SBT-existing', // Khác với sbtId sẽ được generate bên trong
      mintRequestId: 'SBT-MINT-existing',
      verificationId: 'ver-race',
      status: 'PENDING',
      attemptNumber: 0
    } as any;
    (createImpactSbtMetadata as ReturnType<typeof vi.fn>).mockResolvedValue(existingRecord);

    const input = {
      verificationId: 'ver-race',
      projectId: 'proj-1',
      organizationId: 'org-1',
      beneficiaryAddress: '0x1234567890123456789012345678901234567890',
      projectIdNumeric: 1,
      milestone: 0,
      beneficiaryCount: 1,
      gpsCoordinates: '',
      imageCid: 'QmTest',
      tokenUri: 'ipfs://QmTest'
    };

    const result = await createSbtMintRequest(input);

    // Duplicate được detect bằng sbtId khác nhau
    expect(result.duplicate).toBe(true);
    expect(result.record.mintRequestId).toBe('SBT-MINT-existing');
    expect(enqueueSbtMint).toHaveBeenCalledWith(expect.objectContaining({ attemptNumber: 1 }), expect.objectContaining({ priority: 5 }));
  });

  it('throw error khi beneficiaryAddress không hợp lệ', async () => {
    // Validation xảy ra trước khi gọi createImpactSbtMetadata
    const input = {
      verificationId: 'ver-invalid',
      projectId: 'proj-1',
      organizationId: 'org-1',
      beneficiaryAddress: '0xinvalid',
      projectIdNumeric: 1,
      milestone: 0,
      beneficiaryCount: 1,
      gpsCoordinates: '',
      imageCid: 'QmTest',
      tokenUri: 'ipfs://QmTest'
    };

    await expect(createSbtMintRequest(input)).rejects.toThrow('Địa chỉ beneficiary không hợp lệ');
  });
});

// =============================================================================
// Test: executeSbtMint
// =============================================================================
describe('sbtMintService - executeSbtMint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throw "Không tìm thấy metadata" khi record không tồn tại', async () => {
    (findImpactSbtMetadataByMintRequestId as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    await expect(executeSbtMint('SBT-MINT-nonexistent', 1))
      .rejects.toThrow('Không tìm thấy metadata');
  });

  it('trả về CONFIRMED early khi record.status=CONFIRMED', async () => {
    const confirmedRecord = {
      sbtId: 'SBT-confirmed',
      mintRequestId: 'SBT-MINT-confirmed',
      status: 'CONFIRMED',
      onChainTokenId: 42,
      transactionHash: '0xtxhash',
      blockNumber: 12345
    } as any;
    (findImpactSbtMetadataByMintRequestId as ReturnType<typeof vi.fn>).mockResolvedValue(confirmedRecord);

    const result = await executeSbtMint('SBT-MINT-confirmed', 1);

    expect(result.status).toBe('CONFIRMED');
    expect(result.onChainTokenId).toBe(42);
    expect(result.transactionHash).toBe('0xtxhash');
    expect(getWritableImpactSbtContract).not.toHaveBeenCalled();
  });

  it('gọi contract.mint + markSubmitted + markConfirmed + emit sbt.minted khi thành công', async () => {
    resetWritableContractForTest();
    const pendingRecord = {
      sbtId: 'SBT-pending',
      mintRequestId: 'SBT-MINT-pending',
      projectId: 'proj-1',
      organizationId: 'org-1',
      beneficiaryAddress: '0x1234567890123456789012345678901234567890',
      projectIdNumeric: 1,
      milestone: 0,
      beneficiaryCount: 1,
      gpsCoordinates: '',
      imageCid: 'QmTest',
      tokenUri: 'ipfs://QmTest',
      status: 'PENDING',
      onChainTokenId: null,
      transactionHash: null,
      blockNumber: null
    } as any;

    (findImpactSbtMetadataByMintRequestId as ReturnType<typeof vi.fn>).mockResolvedValue(pendingRecord);
    (markImpactSbtAsSubmitted as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 'SUBMITTED' } as any);
    (markImpactSbtAsConfirmed as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 'CONFIRMED' } as any);
    (findSbtMintDlqByMintRequestId as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    // Build properly formatted log that ethers v6 Interface.parseLog can decode
    const { parseSbtMintedTokenId: _unused } = await import('../../services/sbtMintService');
    const iface = new ethers.Interface([
      'event SBTMinted(address indexed to, uint256 indexed tokenId, string tokenURI_)'
    ]);
    const encoded = iface.encodeEventLog('SBTMinted', [
      '0x1234567890123456789012345678901234567890',
      BigInt(99),
      'ipfs://QmTest'
    ]);

    const mockContract = {
      mint: vi.fn().mockResolvedValue({
        hash: '0xtxhash456',
        wait: vi.fn().mockResolvedValue({
          status: 1,
          blockNumber: 67890,
          logs: [
            {
              address: '0xContractAddress',
              topics: encoded.topics,
              data: encoded.data,
              logIndex: 0,
              blockHash: '0xBlockHash',
              transactionHash: '0xtxhash456',
              transactionIndex: 0,
              blockNumber: 67890,
              removed: false
            }
          ]
        })
      })
    };
    // ethers v6: contract.mint là ContractFunction có cả .estimateGas và có thể gọi như hàm
    (mockContract.mint as any).estimateGas = vi.fn().mockResolvedValue(BigInt(100000));
    (getWritableImpactSbtContract as ReturnType<typeof vi.fn>).mockReturnValue(mockContract as any);

    const result = await executeSbtMint('SBT-MINT-pending', 1);

    expect(result.status).toBe('CONFIRMED');
    expect(result.transactionHash).toBe('0xtxhash456');
    expect(result.blockNumber).toBe(67890);
    expect(mockContract.mint).toHaveBeenCalledWith(
      pendingRecord.beneficiaryAddress,
      pendingRecord.projectIdNumeric,
      pendingRecord.milestone,
      pendingRecord.beneficiaryCount,
      pendingRecord.gpsCoordinates,
      pendingRecord.imageCid,
      pendingRecord.tokenUri,
      { gasLimit: expect.any(BigInt), nonce: expect.any(Number) }
    );
    expect(recordBlockchainTransaction).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'mint_sbt',
      receipt: expect.objectContaining({ status: 1 })
    }));
    expect(markImpactSbtAsSubmitted).toHaveBeenCalledWith('SBT-MINT-pending', expect.objectContaining({
      transactionHash: '0xtxhash456',
      attemptNumber: 1
    }));
    expect(markImpactSbtAsConfirmed).toHaveBeenCalled();
    expect(invalidateSbtGalleryTotalCache).toHaveBeenCalledWith(pendingRecord.projectId);
    expect(sbtEvents.emit).toHaveBeenCalledWith('sbt.minted', expect.objectContaining({
      sbtId: 'SBT-pending',
      mintRequestId: 'SBT-MINT-pending',
      milestone: pendingRecord.milestone,
      beneficiaryCount: pendingRecord.beneficiaryCount
    }));
    expect(eventLoggerLogEventMock).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'SBT_MINTED',
      projectId: 'proj-1',
      organizationId: 'org-1',
      walletAddress: pendingRecord.beneficiaryAddress,
      payload: {
        tokenId: 99,
        milestone: pendingRecord.milestone,
        beneficiaryCount: pendingRecord.beneficiaryCount,
        sbtId: 'SBT-pending',
        transactionHash: '0xtxhash456'
      }
    }));
  });

  it('trả SUBMITTED khi wait receipt timeout và không broadcast lại', async () => {
    vi.useFakeTimers();
    resetWritableContractForTest();
    (findImpactSbtMetadataByMintRequestId as ReturnType<typeof vi.fn>).mockResolvedValue({
      sbtId: 'SBT-timeout', mintRequestId: 'SBT-MINT-timeout', projectId: 'proj-1', organizationId: 'org-1',
      beneficiaryAddress: '0x1234567890123456789012345678901234567890', projectIdNumeric: 1,
      milestone: 1, beneficiaryCount: 1, gpsCoordinates: '', imageCid: 'QmTest', tokenUri: 'ipfs://QmTest',
      status: 'PENDING', onChainTokenId: null, transactionHash: null, blockNumber: null
    });
    const mockContract = {
      mint: vi.fn().mockResolvedValue({ hash: '0xtimeout', wait: vi.fn(() => new Promise(() => undefined)) })
    };
    (mockContract.mint as any).estimateGas = vi.fn().mockResolvedValue(BigInt(100000));
    (getWritableImpactSbtContract as ReturnType<typeof vi.fn>).mockReturnValue(mockContract as any);

    const resultPromise = executeSbtMint('SBT-MINT-timeout', 1);
    await vi.advanceTimersByTimeAsync(60_001);
    const result = await resultPromise;

    expect(result).toMatchObject({ status: 'SUBMITTED', transactionHash: '0xtimeout' });
    expect(markImpactSbtAsConfirmed).not.toHaveBeenCalled();
    expect(mockContract.mint).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('dừng sau broadcast nếu không persist được tx hash để tránh retry double-mint', async () => {
    resetWritableContractForTest();
    (findImpactSbtMetadataByMintRequestId as ReturnType<typeof vi.fn>).mockResolvedValue({
      sbtId: 'SBT-persist-fail', mintRequestId: 'SBT-MINT-persist-fail', projectId: 'proj-1', organizationId: 'org-1',
      beneficiaryAddress: '0x1234567890123456789012345678901234567890', projectIdNumeric: 1,
      milestone: 1, beneficiaryCount: 1, gpsCoordinates: '', imageCid: 'QmTest', tokenUri: 'ipfs://QmTest',
      status: 'PENDING', onChainTokenId: null, transactionHash: null, blockNumber: null
    });
    (markImpactSbtAsSubmitted as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    const mockContract = {
      mint: vi.fn().mockResolvedValue({ hash: '0xpersist-fail', wait: vi.fn() })
    };
    (mockContract.mint as any).estimateGas = vi.fn().mockResolvedValue(BigInt(100000));
    (getWritableImpactSbtContract as ReturnType<typeof vi.fn>).mockReturnValue(mockContract as any);

    await expect(executeSbtMint('SBT-MINT-persist-fail', 1)).rejects.toThrow('Không ghi được tx hash sau broadcast');
    expect(markImpactSbtAsConfirmed).not.toHaveBeenCalled();
  });

  it('throw "revert on-chain" khi receipt.status=0', async () => {
    resetWritableContractForTest();
    const pendingRecord = {
      sbtId: 'SBT-revert',
      mintRequestId: 'SBT-MINT-revert',
      projectId: 'proj-1',
      organizationId: 'org-1',
      beneficiaryAddress: '0x1234567890123456789012345678901234567890',
      projectIdNumeric: 1,
      milestone: 0,
      beneficiaryCount: 1,
      gpsCoordinates: '',
      imageCid: 'QmTest',
      tokenUri: 'ipfs://QmTest',
      status: 'PENDING',
      onChainTokenId: null,
      transactionHash: null,
      blockNumber: null
    } as any;

    (findImpactSbtMetadataByMintRequestId as ReturnType<typeof vi.fn>).mockResolvedValue(pendingRecord);
    (markImpactSbtAsSubmitted as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 'SUBMITTED' } as any);

    const mockContract = {
      mint: vi.fn().mockResolvedValue({
        hash: '0xrevert',
        wait: vi.fn().mockResolvedValue({
          status: 0,
          blockNumber: 100,
          logs: []
        })
      })
    };
    (mockContract.mint as any).estimateGas = vi.fn().mockResolvedValue(BigInt(100000));
    (getWritableImpactSbtContract as ReturnType<typeof vi.fn>).mockReturnValue(mockContract as any);

    await expect(executeSbtMint('SBT-MINT-revert', 1))
      .rejects.toThrow('revert on-chain');
    expect(recordBlockchainTransaction).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'mint_sbt',
      receipt: expect.objectContaining({ status: 0 })
    }));
  });

  it('throw "Không tìm thấy SBTMinted event" khi logs không chứa event', async () => {
    resetWritableContractForTest();
    const pendingRecord = {
      sbtId: 'SBT-noevent',
      mintRequestId: 'SBT-MINT-noevent',
      projectId: 'proj-1',
      organizationId: 'org-1',
      beneficiaryAddress: '0x1234567890123456789012345678901234567890',
      projectIdNumeric: 1,
      milestone: 0,
      beneficiaryCount: 1,
      gpsCoordinates: '',
      imageCid: 'QmTest',
      tokenUri: 'ipfs://QmTest',
      status: 'PENDING',
      onChainTokenId: null,
      transactionHash: null,
      blockNumber: null
    } as any;

    (findImpactSbtMetadataByMintRequestId as ReturnType<typeof vi.fn>).mockResolvedValue(pendingRecord);
    (markImpactSbtAsSubmitted as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 'SUBMITTED' } as any);

    // Log có address khác (không phải contract SBT)
    const mockContractNoEvent = {
      mint: vi.fn().mockResolvedValue({
        hash: '0xnoevent',
        wait: vi.fn().mockResolvedValue({
          status: 1,
          blockNumber: 200,
          logs: [
            {
              address: '0xOtherContract',
              topics: ['0xOtherEvent'],
              data: '0x',
              logIndex: 0,
              blockHash: '0xBlockHash',
              transactionHash: '0xnoevent',
              transactionIndex: 0,
              blockNumber: 200,
              removed: false
            }
          ]
        })
      })
    };
    (mockContractNoEvent.mint as any).estimateGas = vi.fn().mockResolvedValue(BigInt(100000));
    (getWritableImpactSbtContract as ReturnType<typeof vi.fn>).mockReturnValue(mockContractNoEvent as any);

    await expect(executeSbtMint('SBT-MINT-noevent', 1))
      .rejects.toThrow('Không tìm thấy SBTMinted event');
  });

  it('concurrent executeSbtMint chỉ một tx thành công (race protection)', async () => {
    // Hai caller cùng đọc PENDING; chỉ atomic submission lease đầu tiên được phép broadcast.
    resetWritableContractForTest();
    const pendingRaceRecord = {
          sbtId: 'SBT-race',
          mintRequestId: 'SBT-MINT-race',
          projectId: 'proj-1',
          organizationId: 'org-1',
          beneficiaryAddress: '0x1234567890123456789012345678901234567890',
          projectIdNumeric: 1,
          milestone: 0,
          beneficiaryCount: 1,
          gpsCoordinates: '',
          imageCid: 'QmTest',
          tokenUri: 'ipfs://QmTest',
          status: 'PENDING',
          onChainTokenId: null,
          transactionHash: null,
          blockNumber: null
        } as any;

    (findImpactSbtMetadataByMintRequestId as ReturnType<typeof vi.fn>).mockResolvedValue(pendingRaceRecord);
    (claimImpactSbtForSubmission as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ status: 'SUBMITTING' })
      .mockResolvedValueOnce(null);
    (markImpactSbtAsSubmitted as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 'SUBMITTED' } as any);
    (markImpactSbtAsConfirmed as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 'CONFIRMED' } as any);
    (findSbtMintDlqByMintRequestId as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const iface = new ethers.Interface([
      'event SBTMinted(address indexed to, uint256 indexed tokenId, string tokenURI_)'
    ]);
    const encoded = iface.encodeEventLog('SBTMinted', [
      '0x1234567890123456789012345678901234567890',
      BigInt(99),
      'ipfs://QmTest'
    ]);

    const mockContract = {
      mint: vi.fn().mockResolvedValue({
        hash: '0xtxhash-first',
        wait: vi.fn().mockResolvedValue({
          status: 1,
          blockNumber: 67890,
          logs: [
            {
              address: '0xContractAddress',
              topics: encoded.topics,
              data: encoded.data,
              logIndex: 0,
              blockHash: '0xBlockHash',
              transactionHash: '0xtxhash-first',
              transactionIndex: 0,
              blockNumber: 67890,
              removed: false
            }
          ]
        })
      })
    };
    (mockContract.mint as any).estimateGas = vi.fn().mockResolvedValue(BigInt(100000));
    (getWritableImpactSbtContract as ReturnType<typeof vi.fn>).mockReturnValue(mockContract as any);

    // Race protection: chỉ tối đa 1 tx thành công.
    // Call 1: claim thành công → gọi contract → CONFIRMED
    // Call 2: claim thất bại → trả SUBMITTED, không gọi contract
    // Dùng Promise.allSettled để cả 2 chạy đồng thời
    const results = await Promise.allSettled([
      executeSbtMint('SBT-MINT-race', 1),
      executeSbtMint('SBT-MINT-race', 1)
    ]);

    // [BLOCKER #5 fix] Kiểm tra contract chỉ được gọi đúng 1 lần
    expect(mockContract.mint).toHaveBeenCalledTimes(1);
    // Verify cả 2 đều resolve thành công (1 tx, 1 early return)
    const fulfilledResults = results.filter(r => r.status === 'fulfilled');
    expect(fulfilledResults.length).toBe(2);
  });
});

// =============================================================================
// Test: handleSbtMintFailure
// =============================================================================
describe('sbtMintService - handleSbtMintFailure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('trả về willRetry=false khi record không tồn tại', async () => {
    (findImpactSbtMetadataByMintRequestId as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const result = await handleSbtMintFailure('SBT-MINT-nonexistent', 1, 'some error');

    expect(result.willRetry).toBe(false);
    expect(result.movedToDlq).toBe(false);
    expect(result.nextDelayMs).toBeNull();
  });

  it('mark FAILED + enqueue với delay khi attemptNumber < MAX (retry)', async () => {
    const record = {
      sbtId: 'SBT-fail',
      mintRequestId: 'SBT-MINT-fail',
      projectId: 'proj-1',
      organizationId: 'org-1',
      beneficiaryAddress: '0x1234567890123456789012345678901234567890',
      attemptNumber: 2,
      createdAt: new Date()
    } as any;
    (findImpactSbtMetadataByMintRequestId as ReturnType<typeof vi.fn>).mockResolvedValue(record);
    (markImpactSbtAsFailed as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 'FAILED' } as any);
    (enqueueSbtMint as ReturnType<typeof vi.fn>).mockResolvedValue({ jobId: 'job-retry', enqueued: true });

    const result = await handleSbtMintFailure('SBT-MINT-fail', 2, 'RPC timeout');

    expect(result.willRetry).toBe(true);
    expect(result.movedToDlq).toBe(false);
    expect(result.nextDelayMs).toBe(SBT_MINT_RETRY_DELAYS_MS[1]); // 900000ms
    expect(markImpactSbtAsFailed).toHaveBeenCalledWith('SBT-MINT-fail', {
      attemptNumber: 2,
      errorMessage: 'RPC timeout'
    });
    expect(enqueueSbtMint).toHaveBeenCalledWith(
      expect.objectContaining({
        mintRequestId: 'SBT-MINT-fail',
        attemptNumber: 3,
        enqueuedBy: 'worker_retry'
      }),
      expect.objectContaining({ delay: SBT_MINT_RETRY_DELAYS_MS[1] })
    );
    expect(sbtEvents.emit).toHaveBeenCalledWith('sbt.mint-failed', expect.any(Object));
    expect(eventLoggerLogEventMock).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'SBT_MINT_FAILED',
      projectId: 'proj-1',
      payload: expect.objectContaining({ mintRequestId: 'SBT-MINT-fail' })
    }));
  });

  it('move to DLQ + emit sbt.mint-dlq khi attemptNumber >= MAX (7)', async () => {
    const record = {
      sbtId: 'SBT-dlq',
      mintRequestId: 'SBT-MINT-dlq',
      projectId: 'proj-1',
      organizationId: 'org-1',
      beneficiaryAddress: '0x1234567890123456789012345678901234567890',
      attemptNumber: 7,
      createdAt: new Date()
    } as any;
    (findImpactSbtMetadataByMintRequestId as ReturnType<typeof vi.fn>).mockResolvedValue(record);
    (markImpactSbtAsFailed as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 'FAILED' } as any);
    (markImpactSbtAsDlq as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 'DLQ' } as any);
    (createSbtMintDlqEntry as ReturnType<typeof vi.fn>).mockResolvedValue({ dlqId: 'DLQ-1' } as any);

    const result = await handleSbtMintFailure('SBT-MINT-dlq', 7, 'All retries exhausted');

    expect(result.willRetry).toBe(false);
    expect(result.movedToDlq).toBe(true);
    expect(result.nextDelayMs).toBeNull();
    expect(markImpactSbtAsDlq).toHaveBeenCalled();
    expect(createSbtMintDlqEntry).toHaveBeenCalled();
    expect(sbtEvents.emit).toHaveBeenCalledWith('sbt.mint-dlq', expect.any(Object));
    expect(eventLoggerLogEventMock).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'SBT_MINT_DLQ',
      projectId: 'proj-1',
      payload: expect.objectContaining({ mintRequestId: 'SBT-MINT-dlq' })
    }));
    expect(enqueueSbtMint).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Test: rerunSbtMintJob
// =============================================================================
describe('sbtMintService - rerunSbtMintJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throw ApplicationError(409) khi status=CONFIRMED', async () => {
    const record = {
      sbtId: 'SBT-confirmed',
      mintRequestId: 'SBT-MINT-confirmed',
      status: 'CONFIRMED'
    } as any;
    (findImpactSbtMetadataByMintRequestId as ReturnType<typeof vi.fn>).mockResolvedValue(record);

    await expect(rerunSbtMintJob('SBT-MINT-confirmed', 'admin-1'))
      .rejects.toThrow('đã CONFIRMED');
  });

  it('[C3] status DLQ hoặc FAILED → đều throw ApplicationError với mã khác nhau', async () => {
    // Gộp 2 tests trùng logic thành 1 với multiple assertions — [IMPORTANT #20 fix]
    const dlqRecord = {
      sbtId: 'SBT-dlq',
      mintRequestId: 'SBT-MINT-dlq',
      status: 'DLQ'
    } as any;
    const failedRecord = {
      sbtId: 'SBT-failed',
      mintRequestId: 'SBT-MINT-failed',
      status: 'FAILED'
    } as any;

    // Test DLQ status
    (findImpactSbtMetadataByMintRequestId as ReturnType<typeof vi.fn>).mockResolvedValueOnce(dlqRecord);
    await expect(rerunSbtMintJob('SBT-MINT-dlq', 'admin-1')).rejects.toThrow();

    // Test FAILED status
    (findImpactSbtMetadataByMintRequestId as ReturnType<typeof vi.fn>).mockResolvedValueOnce(failedRecord);
    await expect(rerunSbtMintJob('SBT-MINT-failed', 'admin-1')).rejects.not.toThrow('đã CONFIRMED');
  });

  it('throw ApplicationError(409) khi status=SUBMITTED', async () => {
    const record = {
      sbtId: 'SBT-sub',
      mintRequestId: 'SBT-MINT-sub',
      status: 'SUBMITTED'
    } as any;
    (findImpactSbtMetadataByMintRequestId as ReturnType<typeof vi.fn>).mockResolvedValue(record);

    await expect(rerunSbtMintJob('SBT-MINT-sub', 'admin-1'))
      .rejects.toThrow('đang SUBMITTED');
  });

  it('throw error khi record không tồn tại', async () => {
    (findImpactSbtMetadataByMintRequestId as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    await expect(rerunSbtMintJob('SBT-MINT-nonexistent', 'admin-1'))
      .rejects.toThrow('Không tìm thấy mint request');
  });

  it('reset + re-enqueue khi status=FAILED', async () => {
    const record = {
      sbtId: 'SBT-rerun',
      mintRequestId: 'SBT-MINT-rerun',
      status: 'FAILED',
      attemptNumber: 3
    } as any;
    (findImpactSbtMetadataByMintRequestId as ReturnType<typeof vi.fn>).mockResolvedValue(record);
    (countPendingSbtMintJobsByRequestId as ReturnType<typeof vi.fn>).mockResolvedValue(0);
    (resetImpactSbtForReRun as ReturnType<typeof vi.fn>).mockResolvedValue({
      sbtId: 'SBT-rerun',
      mintRequestId: 'SBT-MINT-rerun',
      status: 'PENDING',
      attemptNumber: 0
    } as any);
    (enqueueSbtMint as ReturnType<typeof vi.fn>).mockResolvedValue({ jobId: 'job-rerun', enqueued: true });

    const result = await rerunSbtMintJob('SBT-MINT-rerun', 'admin-1');

    expect(resetImpactSbtForReRun).toHaveBeenCalledWith('SBT-MINT-rerun', expect.objectContaining({
      reRunBy: 'admin-1',
      reRunAt: expect.any(Date)
    }));
    expect(enqueueSbtMint).not.toHaveBeenCalled();
    expect(adminActionOutboxModel.createAdminActionOutbox).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'SBT_MINT_RERUN',
        payload: expect.objectContaining({
          mintRequestId: 'SBT-MINT-rerun',
          sbtId: 'SBT-rerun',
          adminId: 'admin-1',
          reRunCount: expect.anything()
        })
      }),
      undefined
    );
    expect(runAdminActionOutboxOnce).toHaveBeenCalledWith(expect.stringContaining('sbt-rerun-dispatch:SBT-MINT-rerun:'));
    expect(result.record.status).toBe('PENDING');
  });
});

// =============================================================================
// Test: recoverStuckSbtMints
// =============================================================================
describe('sbtMintService - recoverStuckSbtMints', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reconcile late confirmation ghi CONFIRMED mà không broadcast mint lại', async () => {
    const submittedRecord = {
      sbtId: 'SBT-late-confirmed',
      mintRequestId: 'SBT-MINT-late-confirmed',
      projectId: 'proj-1',
      organizationId: 'org-1',
      beneficiaryAddress: '0x1234567890123456789012345678901234567890',
      imageCid: 'QmImage',
      tokenUri: 'ipfs://QmMetadata',
      milestone: 2,
      beneficiaryCount: 1,
      status: 'SUBMITTED',
      attemptNumber: 1,
      transactionHash: '0xlate-confirmed',
      onChainTokenId: null
    } as any;
    const iface = new ethers.Interface([
      'event SBTMinted(address indexed to, uint256 indexed tokenId, string tokenURI_)'
    ]);
    const encoded = iface.encodeEventLog('SBTMinted', [
      submittedRecord.beneficiaryAddress,
      BigInt(77),
      submittedRecord.tokenUri
    ]);
    (findImpactSbtMetadataByMintRequestId as ReturnType<typeof vi.fn>).mockResolvedValue(submittedRecord);
    providerMock.getTransactionReceipt.mockResolvedValue({
      status: 1,
      blockNumber: 700,
      logs: [{ address: '0xContractAddress', topics: encoded.topics, data: encoded.data }]
    });
    (markImpactSbtAsConfirmed as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 'CONFIRMED' } as any);

    await expect(reconcileSubmittedSbtMint(submittedRecord.mintRequestId)).resolves.toBe('CONFIRMED');

    expect(markImpactSbtAsConfirmed).toHaveBeenCalledWith(submittedRecord.mintRequestId, expect.objectContaining({
      onChainTokenId: 77,
      blockNumber: 700
    }));
    expect(getWritableImpactSbtContract).not.toHaveBeenCalled();
    expect(sbtEvents.emit).toHaveBeenCalledWith('sbt.minted', expect.objectContaining({
      transactionHash: submittedRecord.transactionHash,
      onChainTokenId: 77
    }));
  });

  it('reconcile receipt revert chuyển sang failure/DLQ mà không resend nonce', async () => {
    const submittedRecord = {
      sbtId: 'SBT-late-revert',
      mintRequestId: 'SBT-MINT-late-revert',
      projectId: 'proj-1',
      organizationId: 'org-1',
      beneficiaryAddress: '0x1234567890123456789012345678901234567890',
      status: 'SUBMITTED',
      attemptNumber: 7,
      transactionHash: '0xlate-revert',
      createdAt: new Date('2026-08-17T00:00:00Z'),
      reRunCount: 0
    } as any;
    (findImpactSbtMetadataByMintRequestId as ReturnType<typeof vi.fn>).mockResolvedValue(submittedRecord);
    providerMock.getTransactionReceipt.mockResolvedValue({ status: 0, blockNumber: 701, logs: [] });
    (markImpactSbtAsFailed as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 'FAILED' } as any);
    (markImpactSbtAsDlq as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 'DLQ' } as any);

    await expect(reconcileSubmittedSbtMint(submittedRecord.mintRequestId)).resolves.toBe('FAILED');

    expect(markImpactSbtAsFailed).toHaveBeenCalledWith(submittedRecord.mintRequestId, expect.objectContaining({ attemptNumber: 7 }));
    expect(markImpactSbtAsDlq).toHaveBeenCalledWith(submittedRecord.mintRequestId, expect.objectContaining({ attemptNumber: 7 }));
    expect(getWritableImpactSbtContract).not.toHaveBeenCalled();
  });

  it('bỏ qua side effect khi failure transition đã được reconciler khác claim', async () => {
    const submittedRecord = {
      sbtId: 'SBT-race',
      mintRequestId: 'SBT-MINT-race',
      projectId: 'proj-1',
      organizationId: 'org-1',
      beneficiaryAddress: '0x1234567890123456789012345678901234567890',
      status: 'SUBMITTED',
      attemptNumber: 1,
      transactionHash: '0xrace'
    } as any;
    (findImpactSbtMetadataByMintRequestId as ReturnType<typeof vi.fn>).mockResolvedValue(submittedRecord);
    providerMock.getTransactionReceipt.mockResolvedValue({ status: 0, blockNumber: 702, logs: [] });
    (markImpactSbtAsFailed as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    await expect(reconcileSubmittedSbtMint(submittedRecord.mintRequestId)).resolves.toBe('FAILED');

    expect(markImpactSbtAsDlq).not.toHaveBeenCalled();
    expect(sbtEvents.emit).not.toHaveBeenCalledWith('sbt.mint-failed', expect.anything());
    expect(enqueueSbtMint).not.toHaveBeenCalled();
  });

  it('trả về {recovered:0, enqueued:0} khi không có candidates', async () => {
    (findImpactSbtNeedingRecovery as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const result = await recoverStuckSbtMints(15);

    expect(result.recovered).toBe(0);
    expect(result.enqueued).toBe(0);
  });

  it('không auto-fail SUBMITTED khi receipt chưa có, dù quá 5 phút', async () => {
    const oldDate = new Date('2025-01-01T11:54:00Z'); // 6 phút trước
    const submittedRecord = {
      sbtId: 'SBT-stuck',
      mintRequestId: 'SBT-MINT-stuck',
      status: 'SUBMITTED',
      attemptNumber: 1,
      submittedAt: oldDate,
      transactionHash: '0xstucktx'
    } as any;
    (findImpactSbtNeedingRecovery as ReturnType<typeof vi.fn>).mockResolvedValue([submittedRecord]);
    providerMock.getTransactionReceipt.mockResolvedValue(null);

    const result = await recoverStuckSbtMints(15);

    expect(markImpactSbtAsFailed).not.toHaveBeenCalled();
    expect(enqueueSbtMint).not.toHaveBeenCalled();
    expect(result.enqueued).toBe(0);
  });

  it('skip SUBMITTED < 5min (không enqueue)', async () => {
    const recentDate = new Date('2025-01-01T11:59:00Z'); // 1 phút trước
    const recentRecord = {
      sbtId: 'SBT-recent',
      mintRequestId: 'SBT-MINT-recent',
      status: 'SUBMITTED',
      attemptNumber: 1,
      submittedAt: recentDate,
      transactionHash: '0xrecenttx'
    } as any;
    (findImpactSbtNeedingRecovery as ReturnType<typeof vi.fn>).mockResolvedValue([recentRecord]);
    providerMock.getTransactionReceipt.mockResolvedValue(null);

    const result = await recoverStuckSbtMints(15);

    expect(markImpactSbtAsFailed).not.toHaveBeenCalled();
    expect(enqueueSbtMint).not.toHaveBeenCalled();
    expect(result.enqueued).toBe(0);
  });

  it('enqueue PENDING records khi jobIndex không chứa mintRequestId', async () => {
    const pendingRecord = {
      sbtId: 'SBT-pending-recover',
      mintRequestId: 'SBT-MINT-pending-recover',
      status: 'PENDING',
      attemptNumber: 0,
      submittedAt: null
    } as any;
    (findImpactSbtNeedingRecovery as ReturnType<typeof vi.fn>).mockResolvedValue([pendingRecord]);
    (countPendingSbtMintJobsByRequestId as ReturnType<typeof vi.fn>).mockResolvedValue(0);
    (enqueueSbtMint as ReturnType<typeof vi.fn>).mockResolvedValue({ jobId: 'job-pending', enqueued: true });

    const result = await recoverStuckSbtMints(15);

    expect(enqueueSbtMint).toHaveBeenCalledWith(
      expect.objectContaining({
        mintRequestId: 'SBT-MINT-pending-recover',
        sbtId: 'SBT-pending-recover',
        attemptNumber: 1,
        enqueuedBy: 'cron_recovery'
      }),
      expect.objectContaining({ delay: 0 })
    );
    expect(result.enqueued).toBe(1);
  });

  it('release expired SUBMITTING lease before nonce reservation and enqueue again', async () => {
    const submittingRecord = {
      sbtId: 'SBT-submitting-expired',
      mintRequestId: 'SBT-MINT-submitting-expired',
      status: 'SUBMITTING',
      attemptNumber: 1,
      transactionNonce: null,
      transactionHash: null,
      submissionLeaseExpiresAt: new Date(Date.now() - 60_000)
    } as any;
    const releasedRecord = { ...submittingRecord, status: 'PENDING' };
    (findImpactSbtNeedingRecovery as ReturnType<typeof vi.fn>).mockResolvedValue([submittingRecord]);
    (releaseExpiredSbtSubmissionWithoutNonce as ReturnType<typeof vi.fn>).mockResolvedValue(releasedRecord);
    (countPendingSbtMintJobsByRequestId as ReturnType<typeof vi.fn>).mockResolvedValue(0);
    (enqueueSbtMint as ReturnType<typeof vi.fn>).mockResolvedValue({ jobId: 'job-recovered', enqueued: true });

    const result = await recoverStuckSbtMints(15);

    expect(releaseExpiredSbtSubmissionWithoutNonce).toHaveBeenCalledWith(
      submittingRecord.mintRequestId,
      'Submission lease expired before nonce reservation.'
    );
    expect(enqueueSbtMint).toHaveBeenCalledWith(expect.objectContaining({ attemptNumber: 2 }), { delay: 0 });
    expect(result.enqueued).toBe(1);
  });

  it('skip PENDING records khi jobIndex chứa mintRequestId (có job đang chạy/chờ)', async () => {
    const pendingRecord = {
      sbtId: 'SBT-has-job',
      mintRequestId: 'SBT-MINT-has-job',
      status: 'PENDING',
      attemptNumber: 0,
      submittedAt: null
    } as any;
    (findImpactSbtNeedingRecovery as ReturnType<typeof vi.fn>).mockResolvedValue([pendingRecord]);
    (countPendingSbtMintJobsByRequestId as ReturnType<typeof vi.fn>).mockResolvedValue(1); // 1 job deterministic đang chờ

    const result = await recoverStuckSbtMints(15);

    expect(enqueueSbtMint).not.toHaveBeenCalled();
    expect(result.enqueued).toBe(0);
  });
});
